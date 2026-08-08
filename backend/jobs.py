"""Asyncio job queue — max N concurrent workers."""
import asyncio
import logging
import shutil
import time
import uuid
from pathlib import Path
from . import ws_hub
from .db import update_job_status, insert_job
from .config import get_config

# Downloads land here first, on the same filesystem as their destination mount,
# so the final placement is an atomic rename rather than a cross-drive copy.
TMP_SUBDIR = ".videodrop-tmp"

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


def staging_dir(mount_path: str, job_id: str) -> Path:
    return Path(mount_path) / TMP_SUBDIR / job_id


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
    root_folder_path: str | None = None,
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
        "root_folder_path": root_folder_path,
    })


async def register_upload_job(
    job_id: str,
    filename: str,
    mount_path: str,
    mount_name: str,
    media_type: str = "none",
    series_tvdb_id: int | None = None,
    series_title: str | None = None,
    series_year: int | None = None,
    root_folder_path: str | None = None,
):
    """Create the job record for a chunked upload. Does NOT queue it for
    assembly — that only happens once all chunks are received, via
    finalize_upload_job(), so the worker can never pick up an upload before
    its chunks exist on disk."""
    await insert_job(job_id, "upload", filename, mount_name)
    _active[job_id] = {
        "id": job_id, "type": "upload", "status": "uploading", "filename": filename,
        "mount_path": mount_path, "mount_name": mount_name, "started_at": None,
        "media_type": media_type, "series_tvdb_id": series_tvdb_id,
        "series_title": series_title, "series_year": series_year,
        "root_folder_path": root_folder_path,
    }


async def finalize_upload_job(job_id: str):
    """Queue a registered upload job for assembly once its last chunk has
    been received."""
    job = _active[job_id]
    job["status"] = "queued"
    await _queue.put({
        "job_type": "upload",
        "job_id": job_id,
        "source": job["filename"],
        "mount_path": job["mount_path"],
        "filename": job["filename"],
        "media_type": job["media_type"],
        "series_tvdb_id": job["series_tvdb_id"],
        "series_title": job["series_title"],
        "series_year": job["series_year"],
        "root_folder_path": job.get("root_folder_path"),
    })


async def cancel_job(job_id: str):
    """Mark a queued job as cancelled (running jobs cannot be cancelled mid-stream)."""
    if job_id in _active and _active[job_id]["status"] == "queued":
        _active[job_id]["status"] = "cancelled"
        await update_job_status(job_id, "cancelled")
        await ws_hub.broadcast(job_id, {"status": "cancelled", "pct": 0})


async def _place_file(
    file_path: Path,
    mount_path: str,
    root_folder_path: str | None,
    media_type: str,
    series_tvdb_id,
    series_title,
    series_year,
    dest_subpath: str | None = None,
) -> tuple[Path, str | None]:
    """Move the staged file to its final home and notify Sonarr/Radarr.

    The destination mount always wins: the file lands under the root folder that
    lives on the mount the user picked, never wherever Sonarr happens to keep the
    series. Returns (final path, warning or None).
    """
    from .arr_client import (
        move_into,
        radarr_scan,
        sonarr_add_series,
        sonarr_get_series_path,
        sonarr_rescan_series,
    )
    cfg = get_config()

    if media_type == "tv" and cfg.sonarr and root_folder_path:
        # Ensure the series exists in Sonarr; new ones are created on the chosen drive
        series_id = await sonarr_add_series(
            cfg.sonarr, series_tvdb_id, series_title, series_year or 0, root_folder_path
        )
        # Give Sonarr a moment to finish creating the series folder if it's new
        await asyncio.sleep(3)
        series_path = Path(await sonarr_get_series_path(cfg.sonarr, series_id))

        dest = await move_into(file_path, Path(root_folder_path) / series_path.name)

        # A Sonarr series has exactly one path — a rescan can only see files under it
        if series_path.is_relative_to(root_folder_path):
            await sonarr_rescan_series(cfg.sonarr, series_id)
            return dest, None
        return dest, (
            f"Placed outside Sonarr's library — {series_title or 'this series'} lives at "
            f"{series_path}, so Sonarr will not import from {dest.parent}."
        )

    if media_type == "movie" and cfg.radarr and root_folder_path:
        dest = await move_into(file_path, Path(root_folder_path) / file_path.stem)
        await radarr_scan(cfg.radarr, str(dest.parent))
        return dest, None

    # No media type (or the arr isn't configured) — file lands on the mount,
    # under the batch subfolder when one was requested (playlists, channels)
    dest_dir = Path(mount_path) / dest_subpath if dest_subpath else Path(mount_path)
    return await move_into(file_path, dest_dir), None


async def _rescue_to_mount(file_path: Path, mount_path: str) -> Path:
    """Last resort when placement fails: get the file out of the staging dir.

    The staging dir is deleted once the job finishes, so a downloaded file left
    inside it would be lost. Falling back to the mount root keeps it.
    """
    from .arr_client import move_into
    try:
        return await move_into(file_path, Path(mount_path))
    except Exception as e:
        print(f"[jobs] could not rescue {file_path} to {mount_path}: {e}", flush=True)
        return file_path


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
        root_folder_path = item.get("root_folder_path")

        if _active.get(job_id, {}).get("status") == "cancelled":
            _queue.task_done()
            continue

        _active[job_id]["status"] = "running"
        _active[job_id]["started_at"] = time.monotonic()
        mount_name = _active[job_id].get("mount_name", mount_path)
        tmp_dir = staging_dir(mount_path, job_id)
        keep_staging = False
        try:
            if job_type == "url":
                attempt = 1
                while True:
                    try:
                        file_path = await download_url(job_id, source, str(tmp_dir), filename=filename)
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
                file_path = await assemble_and_move(job_id, source, str(tmp_dir))

            # Place the file before reporting done — the staging dir is cleaned up below
            try:
                final_path, warning = await _place_file(
                    Path(file_path), mount_path, root_folder_path,
                    media_type, series_tvdb_id, series_title, series_year,
                    dest_subpath=item.get("dest_subpath"),
                )
            except Exception as e:
                warning = f"Import warning: {e}"
                final_path = await _rescue_to_mount(Path(file_path), mount_path)
                # Rescue failed too — leave the staging dir alone rather than bin the file
                if final_path.is_relative_to(tmp_dir):
                    keep_staging = True
                    warning += f" (file left at {final_path})"

            duration = time.monotonic() - _active[job_id]["started_at"]
            await update_job_status(job_id, "done", dest_path=str(final_path), error=warning)
            payload = {"status": "done", "pct": 100}
            if warning:
                payload["arr_warning"] = warning
            await ws_hub.broadcast(job_id, payload)
            _active[job_id]["status"] = "done"

            from .notifier import notify_job
            await notify_job("done", final_path.name, mount_name, duration)

        except Exception as e:
            duration = time.monotonic() - (_active[job_id].get("started_at") or time.monotonic())
            await update_job_status(job_id, "failed", error=str(e))
            await ws_hub.broadcast(job_id, {"status": "failed", "error": str(e)})
            _active[job_id]["status"] = "failed"

            from .notifier import notify_job
            fname = _active[job_id].get("filename") or source
            await notify_job("failed", fname, mount_name, duration, error=str(e))
        finally:
            # Safe: anything worth keeping has already been moved out of the staging dir
            if not keep_staging:
                shutil.rmtree(tmp_dir, ignore_errors=True)
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
    return [j for j in _active.values() if j["status"] in ("queued", "running", "uploading")]
