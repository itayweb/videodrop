"""DailyMotion channel pre-flight: enumerate a public /user/<name>/videos
channel, backfill per-video metadata (title/upload_date/duration — the flat
channel listing only exposes {video_id, url}, unlike YouTube's tab API which
embeds titles inline), translate titles and parse episode/season markers for
the review table. Mirrors playlist.py/telegram_channel.py's flow, but the
preview runs as a fire-and-forget background task streaming progress over
the existing WebSocket hub, since per-video metadata backfill is too slow
for a single blocking request on large archive channels.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor, as_completed

import yt_dlp

from . import ws_hub
from .db import get_dailymotion_seen
from .playlist import (
    MAX_PLAYLIST_ENTRIES,
    parse_episode_number,
    parse_season_number,
    strip_episode_prefix,
    sanitize_filename,
    _translate_all,
)

_METADATA_WORKERS = 8


def build_video_url(video_id: str) -> str:
    return f"https://www.dailymotion.com/video/{video_id}"


def _fetch_channel_ids(url: str) -> dict:
    """Cheap flat crawl. DailyMotion's channel listing only returns
    {video_id, url} per video — no title/date — so this only enumerates IDs;
    per-video metadata is backfilled separately in run_preview."""
    ydl_opts = {
        "extract_flat": "in_playlist",
        "skip_download": True,
        "playlistend": MAX_PLAYLIST_ENTRIES,
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url.strip(), download=False)
    if not info or info.get("_type") != "playlist":
        raise ValueError("URL is not a DailyMotion channel. Uncheck bulk mode for single videos.")
    entries = [e for e in (info.get("entries") or []) if e and e.get("id")]
    if not entries:
        raise ValueError("Channel has no videos or could not be read.")
    # playlistend stops yt-dlp at the cap; hitting it exactly means the real
    # channel is at least this long and was truncated
    truncated = len(entries) >= MAX_PLAYLIST_ENTRIES
    # yt-dlp sets playlist "id" to the matched <name> path segment
    channel_name = info.get("id") or ""
    return {"channel_name": channel_name, "video_ids": [e["id"] for e in entries], "truncated": truncated}


def _fetch_one_metadata(video_id: str) -> dict:
    """Shallow single-video metadata fetch. A fresh YoutubeDL per call keeps
    threads independent (no shared state). Any failure is caught per-video
    so one dead/throttled link doesn't fail the whole channel preview."""
    ydl_opts = {"skip_download": True, "quiet": True, "no_warnings": True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(build_video_url(video_id), download=False)
        return {
            "video_id": video_id,
            "title": info.get("title") or "",
            "upload_date": info.get("upload_date"),  # "YYYYMMDD" or None
            "duration": info.get("duration"),
            "unavailable": False,
        }
    except Exception:
        return {"video_id": video_id, "title": "", "upload_date": None, "duration": None, "unavailable": True}


def _format_upload_date(upload_date: str | None) -> str:
    if not upload_date or len(upload_date) != 8:
        return "unknown-date"
    return f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:8]}"


def build_raw_filename(upload_date: str | None, video_id: str, title: str) -> str:
    """"<upload_date> - <translated title>", falling back to the video_id
    when a video has no usable title."""
    date_part = _format_upload_date(upload_date)
    title = sanitize_filename(title)
    return f"{date_part} - {title}" if title else f"{date_part} - {video_id}"


def _fetch_all_metadata_with_progress(preview_id: str, video_ids: list[str], loop: asyncio.AbstractEventLoop) -> list[dict]:
    """Runs in a worker thread. Bridges progress back to the event loop via
    run_coroutine_threadsafe, same pattern as downloader.py's yt-dlp progress
    hook."""
    total = len(video_ids)
    results: list[dict] = [None] * total
    fetched = 0
    with ThreadPoolExecutor(max_workers=_METADATA_WORKERS) as pool:
        futures = {pool.submit(_fetch_one_metadata, vid): i for i, vid in enumerate(video_ids)}
        for future in as_completed(futures):
            i = futures[future]
            results[i] = future.result()
            fetched += 1
            asyncio.run_coroutine_threadsafe(
                ws_hub.broadcast(preview_id, {"type": "progress", "stage": "metadata", "fetched": fetched, "total": total}),
                loop,
            )
    return results


async def run_preview(preview_id: str, url: str) -> None:
    """Fire-and-forget background task: fetches + translates a DailyMotion
    channel and streams progress/result over ws_hub under preview_id."""
    try:
        loop = asyncio.get_event_loop()
        meta = await loop.run_in_executor(None, _fetch_channel_ids, url)
        video_ids = meta["video_ids"]

        await ws_hub.broadcast(preview_id, {"type": "progress", "stage": "metadata", "fetched": 0, "total": len(video_ids)})
        raw_entries = await loop.run_in_executor(
            None, _fetch_all_metadata_with_progress, preview_id, video_ids, loop
        )

        titles = [meta["channel_name"]] + [strip_episode_prefix(e["title"]) for e in raw_entries]
        translations = await loop.run_in_executor(None, _translate_all, titles)
        channel_title_translated, _ = translations[0]

        seen = await get_dailymotion_seen(video_ids)

        entries = []
        for entry, (translated_title, ok) in zip(raw_entries, translations[1:]):
            entries.append({
                "video_id": entry["video_id"],
                "upload_date": entry["upload_date"],
                "orig_title": entry["title"],
                "translated_title": sanitize_filename(translated_title) if not entry["unavailable"] else translated_title,
                "translated": ok,
                "duration": entry["duration"],
                "episode_number": None if entry["unavailable"] else parse_episode_number(entry["title"]),
                "season_number": None if entry["unavailable"] else parse_season_number(entry["title"]),
                "already_downloaded": entry["video_id"] in seen,
                "unavailable": entry["unavailable"],
            })

        preview = {
            "channel_name": meta["channel_name"],
            "channel_title": meta["channel_name"],
            "channel_title_translated": channel_title_translated,
            "suggested_season": parse_season_number(meta["channel_name"]) or 1,
            "entries": entries,
            "truncated": meta["truncated"],
        }
        await ws_hub.broadcast(preview_id, {"type": "done", "preview": preview})
    except Exception as e:
        await ws_hub.broadcast(preview_id, {"type": "error", "message": str(e)})
