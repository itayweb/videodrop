"""Telegram bot notifications for job completion/failure."""
import logging
from .config import get_config

logger = logging.getLogger(__name__)


def _fmt_duration(seconds: float) -> str:
    s = int(seconds)
    if s < 60:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}m {s:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h {m:02d}m {s:02d}s"


async def notify_job(
    status: str,
    filename: str,
    mount_name: str,
    duration_s: float,
    error: str | None = None,
) -> None:
    """Send a Telegram bot message on job completion. Silent no-op if not configured."""
    cfg = get_config()
    tg = cfg.telegram
    if tg is None or not tg.bot_token or not tg.chat_id:
        return

    icon = "✅" if status == "done" else "❌"
    label = "Download complete" if status == "done" else "Download failed"
    lines = [
        f"{icon} {label}",
        f"File: {filename}",
        f"Mount: {mount_name}",
        f"Duration: {_fmt_duration(duration_s)}",
    ]
    if error:
        lines.append(f"Error: {error}")
    text = "\n".join(lines)

    try:
        import httpx
        url = f"https://api.telegram.org/bot{tg.bot_token}/sendMessage"
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(url, json={"chat_id": tg.chat_id, "text": text})
    except Exception as exc:
        logger.warning("Telegram notification failed: %s", exc)
