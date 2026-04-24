"""Telethon-based downloader for private Telegram channel links (t.me/c/...)."""
import asyncio
import re
from pathlib import Path

from . import ws_hub
from .config import get_config
from .db import update_job_status

BASE_DIR = Path(__file__).parent.parent


def parse_private_link(url: str) -> tuple[int, int]:
    """Parse t.me/c/<channel_id>/<message_id> → (peer_id, message_id).

    Telegram's internal channel ID is -100 prefixed, e.g. channel 2891054658
    becomes -1002891054658.
    """
    m = re.match(r"https?://t\.me/c/(\d+)/(\d+)", url.strip())
    if not m:
        raise ValueError(f"Not a valid private Telegram link: {url}")
    channel_id = int(m.group(1))
    message_id = int(m.group(2))
    peer_id = int(f"-100{channel_id}")
    return peer_id, message_id


async def download_private(job_id: str, url: str, dest_dir: str) -> Path:
    """Download media from a private Telegram channel message using Telethon."""
    from telethon import TelegramClient

    cfg = get_config()
    if cfg.telegram is None:
        raise RuntimeError(
            "Telegram credentials not configured. Add a 'telegram:' block to config.yaml."
        )

    tg = cfg.telegram
    session_path = str(BASE_DIR / tg.session_file)
    peer_id, message_id = parse_private_link(url)

    dest_path = Path(dest_dir)
    dest_path.mkdir(parents=True, exist_ok=True)

    await update_job_status(job_id, "running")
    await ws_hub.broadcast(job_id, {"status": "running", "pct": 0})

    loop = asyncio.get_event_loop()

    def _run():
        import asyncio as _asyncio

        async def _download():
            client = TelegramClient(session_path, tg.api_id, tg.api_hash)
            await client.connect()

            if not await client.is_user_authorized():
                raise RuntimeError(
                    "Telegram session not authorized. Run setup_session.py first."
                )

            message = await client.get_messages(peer_id, ids=message_id)
            if message is None or message.media is None:
                raise ValueError("No media found in that Telegram message.")

            # Determine filename from media attributes
            filename = None
            if hasattr(message.media, "document"):
                for attr in message.media.document.attributes:
                    if hasattr(attr, "file_name"):
                        filename = attr.file_name
                        break
            if not filename:
                filename = f"telegram_{peer_id}_{message_id}.mp4"

            out_file = dest_path / filename

            def _progress(received: int, total: int):
                pct = round((received / total) * 100, 1) if total else 0
                _asyncio.run_coroutine_threadsafe(
                    ws_hub.broadcast(
                        job_id,
                        {"status": "downloading", "pct": pct, "speed": "", "eta": ""},
                    ),
                    loop,
                )

            await client.download_media(message, file=str(out_file), progress_callback=_progress)
            await client.disconnect()
            return out_file

        # Run nested async in a fresh event loop inside the thread
        new_loop = _asyncio.new_event_loop()
        try:
            return new_loop.run_until_complete(_download())
        finally:
            new_loop.close()

    out_file = await loop.run_in_executor(None, _run)

    await ws_hub.broadcast(job_id, {"status": "done", "pct": 100})
    return Path(out_file)
