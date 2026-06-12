"""Telethon-based downloader for all Telegram links (public and private)."""
import asyncio
import re
from pathlib import Path

from . import ws_hub
from .config import get_config
from .db import update_job_status

BASE_DIR = Path(__file__).parent.parent

# Telethon's session storage is a SQLite file that cannot be shared by
# multiple clients at once — a second concurrent client raises
# "database is locked". All downloads share this single client instead.
_client = None
_client_lock = asyncio.Lock()


async def _get_client():
    """Return the shared, connected TelegramClient (created on first use)."""
    global _client
    from telethon import TelegramClient

    cfg = get_config()
    if cfg.telegram is None:
        raise RuntimeError(
            "Telegram credentials not configured. Add a 'telegram:' block to config.yaml."
        )
    tg = cfg.telegram

    async with _client_lock:
        if _client is not None and _client.is_connected():
            return _client
        session_path = str(BASE_DIR / tg.session_file)
        client = TelegramClient(session_path, tg.api_id, tg.api_hash)
        await client.connect()
        if not await client.is_user_authorized():
            await client.disconnect()
            raise RuntimeError(
                "Telegram session not authorized. Run setup_session.py first."
            )
        _client = client
        return _client


async def close_client():
    """Disconnect the shared client (called on app shutdown)."""
    global _client
    async with _client_lock:
        if _client is not None:
            await _client.disconnect()
            _client = None


def parse_telegram_link(url: str) -> tuple[str | int, int]:
    """Parse any t.me link and return (peer, message_id).

    Private:  t.me/c/<channel_id>/<msg_id>  → peer = -100<channel_id> (int)
    Public:   t.me/<username>/<msg_id>       → peer = username (str)
    """
    url = url.strip()
    # Private channel: t.me/c/1234567/89
    m = re.match(r"https?://t\.me/c/(\d+)/(\d+)", url)
    if m:
        peer_id = int(f"-100{m.group(1)}")
        return peer_id, int(m.group(2))
    # Public channel: t.me/username/89  or  t.me/s/username/89
    m = re.match(r"https?://t\.me/s?/?([^/]+)/(\d+)", url)
    if m:
        return m.group(1), int(m.group(2))
    raise ValueError(f"Unrecognised Telegram link format: {url}")


async def download_telegram(job_id: str, url: str, dest_dir: str, filename: str | None = None) -> Path:
    """Download media from any Telegram channel message using Telethon."""
    peer, message_id = parse_telegram_link(url)

    dest_path = Path(dest_dir)
    dest_path.mkdir(parents=True, exist_ok=True)

    await update_job_status(job_id, "running")
    await ws_hub.broadcast(job_id, {"status": "running", "pct": 0})

    client = await _get_client()

    message = await client.get_messages(peer, ids=message_id)
    if message is None or message.media is None:
        raise ValueError("No media found in that Telegram message.")

    # Determine filename: custom > media attributes > fallback
    orig_ext = ".mp4"
    media_filename = None
    if hasattr(message.media, "document"):
        for attr in message.media.document.attributes:
            if hasattr(attr, "file_name") and attr.file_name:
                media_filename = attr.file_name
                if "." in media_filename:
                    orig_ext = "." + media_filename.rsplit(".", 1)[-1]
                break

    if filename:
        resolved_filename = filename.strip() + orig_ext
    elif media_filename:
        resolved_filename = media_filename
    else:
        resolved_filename = f"telegram_{peer}_{message_id}.mp4"

    out_file = dest_path / resolved_filename

    async def _progress(received: int, total: int):
        pct = round((received / total) * 100, 1) if total else 0
        await ws_hub.broadcast(
            job_id,
            {"status": "downloading", "pct": pct, "speed": "", "eta": ""},
        )

    await client.download_media(message, file=str(out_file), progress_callback=_progress)

    await ws_hub.broadcast(job_id, {"status": "done", "pct": 100})
    return Path(out_file)
