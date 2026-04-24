"""Asyncio job queue — max N concurrent workers."""
import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Any
from . import ws_hub
from .db import update_job_status, insert_job
from .config import get_config

# In-memory job registry for active/queued jobs
_active: dict[str, dict] = {}
_queue: asyncio.Queue = asyncio.Queue()
_workers_started = False


def new_job_id() -> str:
    return str(uuid.uuid4())


async def enqueue_url_job(job_id: str, url: str, mount_path: str, mount_name: str, filename: str | None = None):
    await insert_job(job_id, "url", url, mount_name)
    _active[job_id] = {"id": job_id, "type": "url", "status": "queued", "url": url, "mount_path": mount_path}
    await _queue.put(("url", job_id, url, mount_path, filename))


async def enqueue_upload_job(job_id: str, filename: str, mount_path: str, mount_name: str):
    await insert_job(job_id, "upload", filename, mount_name)
    _active[job_id] = {"id": job_id, "type": "upload", "status": "queued", "filename": filename, "mount_path": mount_path}
    await _queue.put(("upload", job_id, filename, mount_path))


async def cancel_job(job_id: str):
    """Mark a queued job as cancelled (running jobs cannot be cancelled mid-stream)."""
    if job_id in _active and _active[job_id]["status"] == "queued":
        _active[job_id]["status"] = "cancelled"
        await update_job_status(job_id, "cancelled")
        await ws_hub.broadcast(job_id, {"status": "cancelled", "pct": 0})


async def _worker():
    from .downloader import download_url
    from .uploader import assemble_and_move

    while True:
        item = await _queue.get()
        job_type, job_id, source, mount_path, *rest = item
        filename = rest[0] if rest else None

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
