"""Telegram channel/group pre-flight: enumerate video messages, translate
captions and parse episode/season markers for the review table. Mirrors
playlist.py's flow for YouTube playlists.
"""
import asyncio

from .config import get_config
from .db import get_telegram_seen
from .playlist import (
    parse_episode_number,
    parse_season_number,
    strip_episode_prefix,
    sanitize_filename,
    _translate_all,
)


def _video_duration(msg) -> int | None:
    """Duration for both streamable videos and videos sent as plain
    documents (e.g. .mkv), which Telegram never marks as msg.video."""
    from telethon.tl.types import DocumentAttributeVideo

    doc = getattr(msg, "document", None)
    if not doc:
        return None
    for attr in doc.attributes:
        if isinstance(attr, DocumentAttributeVideo):
            return attr.duration
    return None


def _is_video_message(msg) -> bool:
    if msg.video:
        return True
    doc = getattr(msg, "document", None)
    return bool(doc and doc.mime_type and doc.mime_type.startswith("video/"))


async def _fetch_flat(chat_input: str) -> dict:
    from telethon.errors import FloodError
    from .telegram_dl import resolve_channel, _get_client, _parse_flood_seconds

    client = await _get_client()
    entity, username, channel_id = await resolve_channel(chat_input)
    cap = get_config().max_channel_entries

    title = getattr(entity, "title", None) or username or str(channel_id)

    entries = []
    try:
        async for msg in client.iter_messages(entity, limit=cap):
            if not _is_video_message(msg):
                continue
            entries.append({
                "msg_id": msg.id,
                "date": msg.date.isoformat(),
                "orig_caption": msg.text or msg.raw_text or "",
                "duration": _video_duration(msg),
                "file_size": msg.file.size if msg.file else None,
            })
    except FloodError as e:
        wait = getattr(e, "seconds", None) or _parse_flood_seconds(str(e)) or 5
        await asyncio.sleep(wait)
        async for msg in client.iter_messages(entity, limit=cap):
            if not _is_video_message(msg):
                continue
            entries.append({
                "msg_id": msg.id,
                "date": msg.date.isoformat(),
                "orig_caption": msg.text or msg.raw_text or "",
                "duration": _video_duration(msg),
                "file_size": msg.file.size if msg.file else None,
            })

    truncated = len(entries) >= cap
    return {
        "title": title,
        "username": username,
        "channel_id": channel_id,
        "entries": entries,
        "truncated": truncated,
    }


def build_raw_filename(date_iso: str, msg_id: int, caption: str) -> str:
    date_part = date_iso[:10]  # YYYY-MM-DD prefix of the ISO timestamp
    base = f"{date_part} - {msg_id}"
    caption = sanitize_filename(caption)
    if caption:
        base += f" - {caption}"
    return base


def build_telegram_url(username: str | None, raw_channel_id: int, msg_id: int) -> str:
    """Build a t.me link for one message. Caller resolves the channel once
    per request (not per entry) and passes username/raw id in."""
    if username:
        return f"https://t.me/{username}/{msg_id}"
    return f"https://t.me/c/{raw_channel_id}/{msg_id}"


async def build_preview(chat_input: str) -> dict:
    meta = await _fetch_flat(chat_input)

    captions = [meta["title"]] + [strip_episode_prefix(e["orig_caption"]) for e in meta["entries"]]
    loop = asyncio.get_event_loop()
    translations = await loop.run_in_executor(None, _translate_all, captions)
    channel_title_translated, _ = translations[0]

    seen = await get_telegram_seen(meta["channel_id"], [e["msg_id"] for e in meta["entries"]])

    entries = []
    for entry, (translated_caption, ok) in zip(meta["entries"], translations[1:]):
        entries.append({
            **entry,
            "translated_caption": sanitize_filename(translated_caption) if entry["orig_caption"] else "",
            "translated": ok,
            "episode_number": parse_episode_number(entry["orig_caption"]),
            "season_number": parse_season_number(entry["orig_caption"]),
            "already_downloaded": entry["msg_id"] in seen,
        })

    return {
        "channel_title": meta["title"],
        "channel_title_translated": channel_title_translated,
        "channel_username": meta["username"],
        "channel_id": meta["channel_id"],
        "suggested_season": parse_season_number(meta["title"]) or 1,
        "entries": entries,
        "truncated": meta["truncated"],
    }
