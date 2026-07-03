"""YouTube playlist pre-flight: flat metadata extraction, Hebrew→English
title translation and episode/season parsing for the review table.
"""
import asyncio
import re
from urllib.parse import urlparse, parse_qs

import yt_dlp

MAX_PLAYLIST_ENTRIES = 300

_HEBREW_RE = re.compile("[\\u0590-\\u05FF]")
# RTL/LTR embedding marks that sneak into YouTube titles and break regexes
_RTL_MARKS_RE = re.compile("[\\u200e\\u200f\\u202a-\\u202e]")

_EP_DIGIT_RE = re.compile(r"(?:פרק|חלק)\s*[:#-]?\s*(\d{1,4})")
_EP_ENGLISH_RE = re.compile(r"(?:episode|ep\.?)\s*(\d{1,4})", re.IGNORECASE)
# Gematria: multi-letter requires gershayim (י"ב) to avoid matching plain
# words like "פרק חדש"; single letter may carry a geresh (ה') or stand bare
_EP_GEMATRIA_RE = re.compile(r"פרק\s+(?:([א-ת]{1,2})\"([א-ת])|([א-ת])'?(?![א-ת]))")
_SEASON_DIGIT_RE = re.compile(r"עונה\s*[:#-]?\s*(\d{1,2})")
# Leftover season/episode markers at the start of a stripped title remainder
_LEADING_MARKER_RE = re.compile(r"^(?:עונה|פרק|חלק)\s*[:#-]?\s*\d{1,4}\s*")

_GEMATRIA = {
    "א": 1, "ב": 2, "ג": 3, "ד": 4, "ה": 5, "ו": 6, "ז": 7, "ח": 8, "ט": 9,
    "י": 10, "כ": 20, "ך": 20, "ל": 30, "מ": 40, "ם": 40, "נ": 50, "ן": 50,
    "ס": 60, "ע": 70, "פ": 80, "ף": 80, "צ": 90, "ץ": 90,
    "ק": 100, "ר": 200, "ש": 300, "ת": 400,
}

_UNAVAILABLE_TITLES = {"[private video]", "[deleted video]", "[unavailable video]"}

_INVALID_FILENAME_CHARS_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_EMOJI_RE = re.compile("[\\U0001F000-\\U0001FAFF\\u2600-\\u27BF\\ufe0f\\u200d]")


def _normalize_title(title: str) -> str:
    title = _RTL_MARKS_RE.sub("", title)
    return title.replace("״", '"').replace("׳", "'")


def _gematria_to_int(letters: str) -> int | None:
    total = sum(_GEMATRIA.get(ch, 0) for ch in letters)
    return total if 0 < total <= 500 else None


def _match_episode(title: str) -> tuple[int | None, re.Match | None]:
    m = _EP_DIGIT_RE.search(title) or _EP_ENGLISH_RE.search(title)
    if m:
        return int(m.group(1)), m
    m = _EP_GEMATRIA_RE.search(title)
    if m:
        letters = (m.group(1) or "") + (m.group(2) or "") + (m.group(3) or "")
        return _gematria_to_int(letters), m
    return None, None


def parse_episode_number(title: str) -> int | None:
    return _match_episode(_normalize_title(title))[0]


def strip_episode_prefix(title: str) -> str:
    """Drop everything through the episode marker ("שם הסדרה | פרק 3 - שם הפרק"
    → "שם הפרק") so filenames don't repeat what SxxEyy already encodes."""
    normalized = _normalize_title(title)
    number, m = _match_episode(normalized)
    if number is None or m is None:
        return title
    remainder = normalized[m.end():].lstrip(" -–—:|.")
    # Titles like "פרק 3 עונה 5 קלאסי" repeat season/episode markers after the
    # first one — strip leading leftovers so SxxEyy isn't re-encoded in the name
    while True:
        stripped = _LEADING_MARKER_RE.sub("", remainder).lstrip(" -–—:|.")
        if stripped == remainder:
            break
        remainder = stripped
    return remainder.strip() or title


def parse_season_number(title: str) -> int | None:
    m = _SEASON_DIGIT_RE.search(_normalize_title(title))
    return int(m.group(1)) if m else None


def sanitize_filename(name: str) -> str:
    name = _INVALID_FILENAME_CHARS_RE.sub("", name)
    name = _EMOJI_RE.sub("", name)
    return re.sub(r"\s+", " ", name).strip().strip(".")


def build_episode_filename(show: str, season: int, episode: int, title: str) -> str:
    return f"{show} - S{season:02d}E{episode:02d} - {title}"


def build_subpath(show: str, season: int) -> str:
    return f"{sanitize_filename(show)}/Season {season:02d}"


def _playlist_url(url: str) -> str:
    """watch?v=X&list=Y / youtu.be/X?list=Y → canonical playlist URL."""
    parsed = urlparse(url)
    list_id = parse_qs(parsed.query).get("list", [None])[0]
    if list_id:
        return f"https://www.youtube.com/playlist?list={list_id}"
    return url


def _fetch_flat(url: str) -> dict:
    ydl_opts = {
        "extract_flat": "in_playlist",
        "skip_download": True,
        "playlistend": MAX_PLAYLIST_ENTRIES,
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(_playlist_url(url), download=False)
    if not info or info.get("_type") != "playlist":
        raise ValueError("URL is not a playlist. Uncheck playlist mode for single videos.")
    entries = [e for e in (info.get("entries") or [])]
    if not entries:
        raise ValueError("Playlist is empty or could not be read.")
    return {"title": info.get("title") or "", "entries": entries}


def _translate_all(texts: list[str]) -> list[tuple[str, bool]]:
    """Hebrew→English per title; on any failure keep the original and flag it."""
    from deep_translator import GoogleTranslator

    translator = GoogleTranslator(source="auto", target="en")
    results: list[tuple[str, bool]] = []
    for text in texts:
        if not text or not _HEBREW_RE.search(text):
            results.append((text, True))
            continue
        try:
            translated = translator.translate(text)
            if translated:
                translated = translated[:1].upper() + translated[1:]
            results.append((translated or text, bool(translated)))
        except Exception:
            results.append((text, False))
    return results


async def build_preview(url: str) -> dict:
    loop = asyncio.get_event_loop()
    meta = await loop.run_in_executor(None, _fetch_flat, url)

    raw_entries = []
    for i, e in enumerate(meta["entries"], start=1):
        title = (e.get("title") if e else None) or ""
        unavailable = e is None or title.lower() in _UNAVAILABLE_TITLES or not e.get("id")
        video_id = (e or {}).get("id") or ""
        video_url = (e or {}).get("url") or (f"https://www.youtube.com/watch?v={video_id}" if video_id else "")
        raw_entries.append({
            "index": i,
            "video_id": video_id,
            "video_url": video_url,
            "orig_title": title,
            "unavailable": unavailable,
        })

    # Translate only the part after the episode marker — SxxEyy already
    # encodes the rest, so "שם הסדרה | פרק 3 - שם הפרק" translates as just the name
    titles = [meta["title"]] + [strip_episode_prefix(en["orig_title"]) for en in raw_entries]
    translations = await loop.run_in_executor(None, _translate_all, titles)
    playlist_title_translated, _ = translations[0]

    entries = []
    for entry, (translated_title, ok) in zip(raw_entries, translations[1:]):
        entries.append({
            **entry,
            "translated_title": sanitize_filename(translated_title) if not entry["unavailable"] else translated_title,
            "translated": ok,
            "episode_number": None if entry["unavailable"] else parse_episode_number(entry["orig_title"]),
            "season_number": None if entry["unavailable"] else parse_season_number(entry["orig_title"]),
        })

    return {
        "playlist_title": meta["title"],
        "playlist_title_translated": playlist_title_translated,
        "suggested_season": parse_season_number(meta["title"]) or 1,
        "entries": entries,
    }
