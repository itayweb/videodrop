"""FastAPI application entry point."""
import asyncio
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Query,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .auth import check_token, require_auth
from .config import get_config
from .db import get_job, get_jobs, init_db
from .jobs import (
    cancel_job,
    enqueue_upload_job,
    enqueue_url_job,
    get_active_jobs,
    new_job_id,
    start_workers,
)
from . import ws_hub
from .uploader import receive_chunk

FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await start_workers()
    yield


app = FastAPI(title="VideoDrop", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Config / health ────────────────────────────────────────────────────────────

@app.get("/api/config")
def api_config(_: bool = Depends(require_auth)):
    cfg = get_config()
    return {"mounts": [{"name": m.name, "path": m.path} for m in cfg.mounts]}


@app.get("/api/health")
def health():
    return {"ok": True}


# ── URL download ───────────────────────────────────────────────────────────────

class UrlJobRequest(BaseModel):
    url: str
    mount_name: str
    filename: str | None = None
    media_type: str = "none"          # "none" | "tv" | "movie"
    series_tvdb_id: int | None = None
    series_title: str | None = None
    series_year: int | None = None


@app.post("/api/jobs/url", status_code=status.HTTP_202_ACCEPTED)
async def submit_url_job(req: UrlJobRequest, _: bool = Depends(require_auth)):
    cfg = get_config()
    mount = next((m for m in cfg.mounts if m.name == req.mount_name), None)
    if mount is None:
        raise HTTPException(400, f"Unknown mount: {req.mount_name}")
    job_id = new_job_id()
    await enqueue_url_job(
        job_id, req.url, mount.path, mount.name,
        filename=req.filename,
        media_type=req.media_type,
        series_tvdb_id=req.series_tvdb_id,
        series_title=req.series_title,
        series_year=req.series_year,
    )
    return {"job_id": job_id}


# ── Sonarr search ──────────────────────────────────────────────────────────────

@app.get("/api/sonarr/search")
async def sonarr_search_endpoint(q: str = Query(..., min_length=1), _: bool = Depends(require_auth)):
    from .arr_client import sonarr_search
    cfg = get_config()
    if cfg.sonarr is None:
        raise HTTPException(503, "Sonarr not configured")
    results = await sonarr_search(cfg.sonarr, q)
    return results


@app.get("/api/arr/status")
def arr_status(_: bool = Depends(require_auth)):
    cfg = get_config()
    return {
        "sonarr": cfg.sonarr is not None,
        "radarr": cfg.radarr is not None,
    }


# ── Chunked upload ─────────────────────────────────────────────────────────────

@app.post("/api/jobs/upload/init", status_code=status.HTTP_202_ACCEPTED)
async def init_upload(
    filename: str = Query(...),
    mount_name: str = Query(...),
    total_chunks: int = Query(...),
    _: bool = Depends(require_auth),
):
    cfg = get_config()
    mount = next((m for m in cfg.mounts if m.name == mount_name), None)
    if mount is None:
        raise HTTPException(400, f"Unknown mount: {mount_name}")
    job_id = new_job_id()
    await enqueue_upload_job(job_id, filename, mount.path, mount.name)
    return {"job_id": job_id, "total_chunks": total_chunks}


@app.post("/api/jobs/upload/chunk")
async def upload_chunk(
    job_id: str = Query(...),
    filename: str = Query(...),
    chunk_index: int = Query(...),
    total_chunks: int = Query(...),
    file: UploadFile = None,
    _: bool = Depends(require_auth),
):
    done = await receive_chunk(job_id, filename, chunk_index, total_chunks, file)
    return {"received": chunk_index + 1, "done": done}


# ── Job status ─────────────────────────────────────────────────────────────────

@app.get("/api/jobs")
async def list_jobs(_: bool = Depends(require_auth)):
    history = await get_jobs()
    active = get_active_jobs()
    return {"active": active, "history": history}


@app.get("/api/jobs/{job_id}")
async def job_detail(job_id: str, _: bool = Depends(require_auth)):
    job = await get_job(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return job


@app.delete("/api/jobs/{job_id}")
async def cancel(job_id: str, _: bool = Depends(require_auth)):
    await cancel_job(job_id)
    return {"cancelled": job_id}


# ── WebSocket progress ─────────────────────────────────────────────────────────

@app.websocket("/ws/{job_id}")
async def ws_progress(websocket: WebSocket, job_id: str, token: str = Query(None)):
    if not check_token(token):
        await websocket.close(code=4001)
        return
    await websocket.accept()
    ws_hub.subscribe(job_id, websocket)
    # Send current DB status immediately on connect
    job = await get_job(job_id)
    if job:
        await websocket.send_json({"status": job["status"], "pct": 100 if job["status"] == "done" else 0})
    try:
        while True:
            await websocket.receive_text()  # keep connection alive; client may send pings
    except WebSocketDisconnect:
        pass
    finally:
        ws_hub.unsubscribe(job_id, websocket)


# ── Serve frontend ─────────────────────────────────────────────────────────────

if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
