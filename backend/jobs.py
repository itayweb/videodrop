"""Asyncio job queue — max N concurrent workers."""
import asyncio
import uuid
from . import ws_hub
from .db import update_job_status, insert_job
from .config import get_config

# In-memory job registry for active/queued jobs
_active: dict[str, dict] = {}
_queue: asyncio.Queue = asyncio.Queue()
_workers_started = False


def new_job_id() -> str:
    return str(uuid.uuid4())


async def enqueue_url_job(
    job_id: str,
    url: str,
    mount_path: str,
    mount_name: str,
    filename: str | None = None,
    media_type: str = "none",
    series_tvdb_id: int | None = None,
    series_title: str | None = None,
    series_year: int | None = None,
):
    await insert_job(job_id, "url", url, mount_name)
    _active[job_id] = {"id": job_id, "type": "url", "status": "queued", "url": url, "mount_path": mount_path}
    await _queue.put({
        "job_type": "url",
        "job_id": job_id,
        "source": url,
        "mount_path": mount_path,
        "filename": filename,
        "media_type": media_type,
        "series_tvdb_id": series_tvdb_id,
        "series_title": series_title,
        "series_year": series_year,
    })


async def enqueue_upload_job(job_id: str, filename: str, mount_path: str, mount_name: str):
    await insert_job(job_id, "upload", filename, mount_name)
    _active[job_id] = {"id": job_id, "type": "upload", "status": "queued", "filename": filename, "mount_path": mount_path}
    await _queue.put({
        "job_type": "upload",
        "job_id": job_id,
        "source": filename,
        "mount_path": mount_path,
        "filename": filename,
        "media_type": "none",
        "series_tvdb_id": None,
        "series_title": None,
        "series_year": None,
    })


async def cancel_job(job_id: str):
    """Mark a queued job as cancelled (running jobs cannot be cancelled mid-stream)."""
    if job_id in _active and _active[job_id]["status"] == "queued":
        _active[job_id]["status"] = "cancelled"
        await update_job_status(job_id, "cancelled")
        await ws_hub.broadcast(job_id, {"status": "cancelled", "pct": 0})


async def _post_download_hook(file_path, media_type: str, series_tvdb_id, series_title, series_year):
    """Call Sonarr/Radarr after a successful download using manual import API."""
    from .arr_client import sonarr_add_series, sonarr_manual_import, radarr_manual_import
    cfg = get_config()

    if media_type == "tv" and cfg.sonarr:
        # Add series if needed (returns sonarr series id either way)
        series_id = await sonarr_add_series(
            cfg.sonarr, series_tvdb_id, series_title, series_year or 0
        )
        # Give Sonarr a moment to finish creating the series folder
        await asyncio.sleep(8)
        await sonarr_manual_import(cfg.sonarr, str(file_path), series_id)

    elif media_type == "movie" and cfg.radarr:
        await radarr_manual_import(cfg.radarr, str(file_path))


async def _worker():
    from .downloader import download_url
    from .uploader import assemble_and_move

    while True:
        item = await _queue.get()
        job_type = item["job_type"]
        job_id = item["job_id"]
        source = item["source"]
        mount_path = item["mount_path"]
        filename = item.get("filename")
        media_type = item.get("media_type", "none")
        series_tvdb_id = item.get("series_tvdb_id")
        series_title = item.get("series_title")
        series_year = item.get("series_year")

        if _active.get(job_id, {}).get("status") == "cancelled":
            _queue.task_done()
            continue

        _active[job_id]["status"] = "running"
        try:
            if job_type == "url":
                file_path = await download_url(job_id, source, mount_path, filename=filename)
            else:
                file_path = await assemble_and_move(job_id, source, mount_path)

            await update_job_status(job_id, "done", dest_path=str(file_path))
            await ws_hub.broadcast(job_id, {"status": "done", "pct": 100})
            _active[job_id]["status"] = "done"

            # Notify Sonarr/Radarr — surface errors to UI but keep job as "done"
            try:
                await _post_download_hook(file_path, media_type, series_tvdb_id, series_title, series_year)
            except Exception as e:
                await update_job_status(job_id, "done", error=f"Import warning: {e}")
                await ws_hub.broadcast(job_id, {"status": "done", "pct": 100, "arr_warning": str(e)})

        except Exception as e:
            await update_job_status(job_id, "failed", error=str(e))
            await ws_hub.broadcast(job_id, {"status": "failed", "error": str(e)})
            _active[job_id]["status"] = "failed"
        finally:
            _queue.task_done()


async def start_workers():
    global _workers_started
    if _workers_started:
        return
    _workers_started = True
    cfg = get_config()
    for _ in range(cfg.max_concurrent_jobs):
        asyncio.create_task(_worker())


def get_active_jobs() -> list[dict]:
    return [j for j in _active.values() if j["status"] in ("queued", "running")]
