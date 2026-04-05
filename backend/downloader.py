"""yt-dlp wrapper that streams progress to the WebSocket hub."""
import asyncio
import yt_dlp
from pathlib import Path
from . import ws_hub
from .db import update_job_status


def _make_progress_hook(job_id: str, loop: asyncio.AbstractEventLoop):
    def hook(d: dict):
        if d["status"] == "downloading":
            pct_raw = d.get("_percent_str", "0%").strip().replace("%", "")
            try:
                pct = float(pct_raw)
            except ValueError:
                pct = 0.0
            payload = {
                "status": "downloading",
                "pct": round(pct, 1),
                "speed": d.get("_speed_str", "").strip(),
                "eta": d.get("_eta_str", "").strip(),
            }
            asyncio.run_coroutine_threadsafe(ws_hub.broadcast(job_id, payload), loop)
        elif d["status"] == "finished":
            asyncio.run_coroutine_threadsafe(
                ws_hub.broadcast(job_id, {"status": "processing", "pct": 99}), loop
            )

    return hook


async def download_url(job_id: str, url: str, dest_dir: str) -> Path:
    loop = asyncio.get_event_loop()
    dest_path = Path(dest_dir)
    dest_path.mkdir(parents=True, exist_ok=True)

    ydl_opts = {
        "format": "bestvideo+bestaudio/best",
        "merge_output_format": "mp4",
        "outtmpl": str(dest_path / "%(title)s.%(ext)s"),
        "progress_hooks": [_make_progress_hook(job_id, loop)],
        "quiet": True,
        "no_warnings": True,
    }

    await update_job_status(job_id, "running")
    await ws_hub.broadcast(job_id, {"status": "running", "pct": 0})

    # Run blocking yt-dlp in a thread pool
    def _run():
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            return ydl.prepare_filename(info).replace(".webm", ".mp4").replace(".mkv", ".mp4")

    filename = await asyncio.get_event_loop().run_in_executor(None, _run)
    return Path(filename)
