"""Asyncio job queue — max N concurrent workers."""
import asyncio
import logging
import time
import uuid
from pathlib import Path
from . import ws_hub
from .db import update_job_status, insert_job
from .config import get_config

# In-memory job registry for active/queued jobs
_active: dict[str, dict] = {}
_queue: asyncio.Queue = asyncio.Queue()
_workers_started = False

log = logging.getLogger(__name__)

_TRANSIENT_ERROR_MARKERS = ("403", "forbidden", "http error 5", "timed out")
_MAX_DOWNLOAD_ATTEMPTS = 3
_RETRY_DELAY_SECONDS = 3


def _is_transient_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(marker in msg for marker in _TRANSIENT_ERROR_MARKERS)


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
    dest_subpath: str | None = None,
    batch_id: str | None = None,
    batch_label: str | None = None,
):
    await insert_job(job_id, "url", url, mount_name, batch_id=batch_id, batch_label=batch_label)
    _active[job_id] = {"id": job_id, "type": "url", "status": "queued", "url": url, "mount_path": mount_path, "filename": filename, "mount_name": mount_name, "started_at": None, "batch_id": batch_id, "batch_label": batch_label}
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
        "dest_subpath": dest_subpath,
    })


async def enqueue_upload_job(job_id: str, filename: str, mount_path: str, mount_name: str):
    await insert_job(job_id, "upload", filename, mount_name)
    _active[job_id] = {"id": job_id, "type": "upload", "status": "queued", "filename": filename, "mount_path": mount_path, "mount_name": mount_name, "started_at": None}
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
    """Move the file into Sonarr/Radarr's folder and trigger a rescan."""
    from .arr_client import sonarr_add_series, sonarr_import_episode, radarr_import_movie
    cfg = get_config()

    if media_type == "tv" and cfg.sonarr:
        # Ensure series exists in Sonarr (creates folder if new)
        series_id = await sonarr_add_series(
            cfg.sonarr, series_tvdb_id, series_title, series_year or 0
        )
        # Give Sonarr a moment to finish creating the series folder if it's new
        await asyncio.sleep(3)
        # Move file → series folder, then RescanSeries
        await sonarr_import_episode(cfg.sonarr, str(file_path), series_id)

    elif media_type == "movie" and cfg.radarr:
        await radarr_import_movie(cfg.radarr, str(file_path))


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
        _active[job_id]["started_at"] = time.monotonic()
        mount_name = _active[job_id].get("mount_name", mount_path)
        try:
            if job_type == "url":
                dest_subpath = item.get("dest_subpath")
                target_dir = str(Path(mount_path) / dest_subpath) if dest_subpath else mount_path
                attempt = 1
                while True:
                    try:
                        file_path = await download_url(job_id, source, target_dir, filename=filename)
                        break
                    except Exception as e:
                        if attempt >= _MAX_DOWNLOAD_ATTEMPTS or not _is_transient_error(e):
                            raise
                        log.warning(
                            "Transient download error for job %s (attempt %d/%d): %s — retrying in %ds",
                            job_id, attempt, _MAX_DOWNLOAD_ATTEMPTS, e, _RETRY_DELAY_SECONDS,
                        )
                        attempt += 1
                        await asyncio.sleep(_RETRY_DELAY_SECONDS)
            else:
                file_path = await assemble_and_move(job_id, source, mount_path)

            duration = time.monotonic() - _active[job_id]["started_at"]
            await update_job_status(job_id, "done", dest_path=str(file_path))
            await ws_hub.broadcast(job_id, {"status": "done", "pct": 100})
            _active[job_id]["status"] = "done"

            from .notifier import notify_job
            await notify_job("done", Path(file_path).name, mount_name, duration)

            # Notify Sonarr/Radarr — surface errors to UI but keep job as "done"
            try:
                await _post_download_hook(file_path, media_type, series_tvdb_id, series_title, series_year)
            except Exception as e:
                await update_job_status(job_id, "done", error=f"Import warning: {e}")
                await ws_hub.broadcast(job_id, {"status": "done", "pct": 100, "arr_warning": str(e)})

        except Exception as e:
            duration = time.monotonic() - (_active[job_id].get("started_at") or time.monotonic())
            await update_job_status(job_id, "failed", error=str(e))
            await ws_hub.broadcast(job_id, {"status": "failed", "error": str(e)})
            _active[job_id]["status"] = "failed"

            from .notifier import notify_job
            fname = _active[job_id].get("filename") or source
            await notify_job("failed", fname, mount_name, duration, error=str(e))
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
