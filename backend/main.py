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
from .config import get_config, save_config, reload_config, Mount, TelegramConfig, ArrConfig, Config
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
    from .telegram_dl import close_client
    await close_client()


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


@app.get("/api/config/full")
def api_config_full(_: bool = Depends(require_auth)):
    cfg = get_config()

    def _tg(t):
        if t is None:
            return None
        return {
            "api_id": t.api_id,
            "api_hash": t.api_hash,
            "session_file": t.session_file,
            "bot_token": t.bot_token,
            "chat_id": t.chat_id,
        }

    def _arr(a):
        if a is None:
            return None
        return {"url": a.url, "api_key": a.api_key}

    return {
        "password": cfg.password,
        "mounts": [{"name": m.name, "path": m.path} for m in cfg.mounts],
        "max_concurrent_jobs": cfg.max_concurrent_jobs,
        "telegram": _tg(cfg.telegram),
        "sonarr": _arr(cfg.sonarr),
        "radarr": _arr(cfg.radarr),
    }


class TelegramConfigIn(BaseModel):
    api_id: int | None = None
    api_hash: str | None = None
    session_file: str = "telegram.session"
    bot_token: str | None = None
    chat_id: str | None = None


class ArrConfigIn(BaseModel):
    url: str
    api_key: str


class ConfigUpdateRequest(BaseModel):
    password: str
    mounts: list[dict]
    max_concurrent_jobs: int = 2
    telegram: TelegramConfigIn | None = None
    sonarr: ArrConfigIn | None = None
    radarr: ArrConfigIn | None = None


@app.put("/api/config")
def api_config_update(req: ConfigUpdateRequest, _: bool = Depends(require_auth)):
    tg = None
    if req.telegram and req.telegram.api_id and req.telegram.api_hash:
        tg = TelegramConfig(
            api_id=req.telegram.api_id,
            api_hash=req.telegram.api_hash,
            session_file=req.telegram.session_file or "telegram.session",
            bot_token=req.telegram.bot_token or None,
            chat_id=req.telegram.chat_id or None,
        )
    elif req.telegram and (req.telegram.bot_token or req.telegram.chat_id):
        # bot-only config (no Telethon download credentials)
        tg = TelegramConfig(
            api_id=0,
            api_hash="",
            session_file="telegram.session",
            bot_token=req.telegram.bot_token or None,
            chat_id=req.telegram.chat_id or None,
        )

    sonarr = ArrConfig(url=req.sonarr.url, api_key=req.sonarr.api_key) if req.sonarr else None
    radarr = ArrConfig(url=req.radarr.url, api_key=req.radarr.api_key) if req.radarr else None

    cfg = Config(
        password=req.password,
        mounts=[Mount(name=m["name"], path=m["path"]) for m in req.mounts],
        max_concurrent_jobs=req.max_concurrent_jobs,
        telegram=tg,
        sonarr=sonarr,
        radarr=radarr,
    )
    save_config(cfg)
    reload_config()
    return {"ok": True}


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


# ── YouTube playlist ───────────────────────────────────────────────────────────

class PlaylistPreviewRequest(BaseModel):
    url: str


class PlaylistConfirmEntry(BaseModel):
    video_url: str
    season: int
    episode_number: int
    title: str


class PlaylistConfirmRequest(BaseModel):
    mount_name: str
    media_type: str = "none"          # "none" | "tv"
    show_name: str
    series_tvdb_id: int | None = None
    series_title: str | None = None
    series_year: int | None = None
    entries: list[PlaylistConfirmEntry]


@app.post("/api/playlist/preview")
async def playlist_preview(req: PlaylistPreviewRequest, _: bool = Depends(require_auth)):
    from .playlist import build_preview
    try:
        return await asyncio.wait_for(build_preview(req.url), timeout=300)
    except asyncio.TimeoutError:
        raise HTTPException(504, "Playlist metadata fetch timed out")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, f"Could not read playlist: {e}")


@app.post("/api/playlist/confirm", status_code=status.HTTP_202_ACCEPTED)
async def playlist_confirm(req: PlaylistConfirmRequest, _: bool = Depends(require_auth)):
    from .playlist import build_episode_filename, build_subpath, sanitize_filename

    cfg = get_config()
    mount = next((m for m in cfg.mounts if m.name == req.mount_name), None)
    if mount is None:
        raise HTTPException(400, f"Unknown mount: {req.mount_name}")
    if not req.entries:
        raise HTTPException(400, "No entries selected")
    show_name = req.show_name.strip()
    if not show_name:
        raise HTTPException(400, "Show name is required")
    seen: set[tuple[int, int]] = set()
    for e in req.entries:
        key = (e.season, e.episode_number)
        if key in seen:
            raise HTTPException(400, f"Duplicate episode: S{e.season:02d}E{e.episode_number:02d}")
        seen.add(key)

    seasons = sorted({e.season for e in req.entries})
    batch_id = new_job_id()
    if len(seasons) == 1:
        batch_label = f"{show_name} — Season {seasons[0]:02d}"
    else:
        batch_label = f"{show_name} — S{seasons[0]:02d}–S{seasons[-1]:02d}"

    # For Sonarr imports the file is moved+renamed into the library, so the
    # download mount is empty on a re-run — ask Sonarr which (season, episode)
    # pairs already have a file and skip those to avoid re-downloading.
    imported: set[tuple[int, int]] = set()
    if req.media_type == "tv" and cfg.sonarr and req.series_tvdb_id:
        from .arr_client import sonarr_get_series_id, sonarr_episodes_with_files
        try:
            series_id = await sonarr_get_series_id(cfg.sonarr, req.series_tvdb_id)
            if series_id:
                imported = await sonarr_episodes_with_files(cfg.sonarr, series_id)
        except Exception:
            imported = set()  # Sonarr unreachable → fall back to mount check only

    jobs = []
    skipped = []
    for entry in sorted(req.entries, key=lambda e: (e.season, e.episode_number)):
        subpath = build_subpath(show_name, entry.season)
        fname = sanitize_filename(
            build_episode_filename(show_name, entry.season, entry.episode_number, entry.title)
        )
        # Skip if already imported into Sonarr, or still sitting in the download
        # mount (e.g. an earlier import that hasn't run yet) — either way,
        # re-running the playlist resumes only the missing episodes.
        already = (entry.season, entry.episode_number) in imported
        if already or (Path(mount.path) / subpath / f"{fname}.mp4").exists():
            skipped.append({"video_url": entry.video_url, "filename": fname})
            continue
        job_id = new_job_id()
        await enqueue_url_job(
            job_id, entry.video_url, mount.path, mount.name,
            filename=fname,
            media_type=req.media_type,
            series_tvdb_id=req.series_tvdb_id,
            series_title=req.series_title,
            series_year=req.series_year,
            dest_subpath=subpath,
            batch_id=batch_id,
            batch_label=batch_label,
        )
        jobs.append({"job_id": job_id, "filename": fname, "video_url": entry.video_url})

    return {"batch_id": batch_id, "batch_label": batch_label, "jobs": jobs, "skipped": skipped}


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
async def list_jobs(limit: int = Query(100, ge=1, le=1000), _: bool = Depends(require_auth)):
    history = await get_jobs(limit)
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
