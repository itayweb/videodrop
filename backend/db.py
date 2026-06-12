import aiosqlite
from contextlib import asynccontextmanager
from pathlib import Path
from datetime import datetime, timezone

DB_PATH = Path(__file__).parent.parent / "videodrop.db"

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    dest_mount TEXT NOT NULL,
    dest_path TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
);
"""


@asynccontextmanager
async def _connect():
    async with aiosqlite.connect(DB_PATH) as db:
        # busy_timeout is per-connection: wait up to 5s on a locked DB
        # instead of failing immediately with SQLITE_BUSY
        await db.execute("PRAGMA busy_timeout = 5000")
        yield db


async def init_db():
    async with _connect() as db:
        # WAL is persistent (stored in the DB file), so setting it once here
        # covers all future connections
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute(CREATE_SQL)
        await db.commit()


async def insert_job(job_id: str, job_type: str, source: str, dest_mount: str):
    now = datetime.now(timezone.utc).isoformat()
    async with _connect() as db:
        await db.execute(
            "INSERT INTO jobs (id, type, source, dest_mount, status, created_at) VALUES (?,?,?,?,?,?)",
            (job_id, job_type, source, dest_mount, "queued", now),
        )
        await db.commit()


async def update_job_status(job_id: str, status: str, error: str | None = None, dest_path: str | None = None):
    finished_at = datetime.now(timezone.utc).isoformat() if status in ("done", "failed", "cancelled") else None
    async with _connect() as db:
        await db.execute(
            "UPDATE jobs SET status=?, error=?, dest_path=COALESCE(?,dest_path), finished_at=COALESCE(?,finished_at) WHERE id=?",
            (status, error, dest_path, finished_at, job_id),
        )
        await db.commit()


async def get_jobs(limit: int = 100) -> list[dict]:
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
        ) as cursor:
            rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def get_job(job_id: str) -> dict | None:
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)) as cursor:
            row = await cursor.fetchone()
    return dict(row) if row else None
