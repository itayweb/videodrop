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
    finished_at TEXT,
    batch_id TEXT,
    batch_label TEXT
);
"""

CREATE_TELEGRAM_SEEN_SQL = """
CREATE TABLE IF NOT EXISTS telegram_seen (
    channel_id INTEGER NOT NULL,
    msg_id INTEGER NOT NULL,
    dest_path TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, msg_id)
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
        await db.execute(CREATE_TELEGRAM_SEEN_SQL)
        # Pre-existing DBs were created without the batch columns
        async with db.execute("PRAGMA table_info(jobs)") as cursor:
            cols = {row[1] for row in await cursor.fetchall()}
        for col in ("batch_id", "batch_label"):
            if col not in cols:
                await db.execute(f"ALTER TABLE jobs ADD COLUMN {col} TEXT")
        await db.commit()


async def insert_job(
    job_id: str,
    job_type: str,
    source: str,
    dest_mount: str,
    batch_id: str | None = None,
    batch_label: str | None = None,
):
    now = datetime.now(timezone.utc).isoformat()
    async with _connect() as db:
        await db.execute(
            "INSERT INTO jobs (id, type, source, dest_mount, status, created_at, batch_id, batch_label) VALUES (?,?,?,?,?,?,?,?)",
            (job_id, job_type, source, dest_mount, "queued", now, batch_id, batch_label),
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


async def mark_telegram_seen(channel_id: int, msg_id: int, dest_path: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    async with _connect() as db:
        await db.execute(
            "INSERT OR REPLACE INTO telegram_seen (channel_id, msg_id, dest_path, created_at) VALUES (?,?,?,?)",
            (channel_id, msg_id, dest_path, now),
        )
        await db.commit()


async def get_telegram_seen(channel_id: int, msg_ids: list[int]) -> set[int]:
    """A msg_id counts as seen only if its recorded dest_path still exists
    on disk — files deleted outside the app become re-downloadable, and the
    stale telegram_seen row is cleaned up here rather than lingering forever."""
    if not msg_ids:
        return set()
    placeholders = ",".join("?" * len(msg_ids))
    async with _connect() as db:
        async with db.execute(
            f"SELECT msg_id, dest_path FROM telegram_seen WHERE channel_id=? AND msg_id IN ({placeholders})",
            (channel_id, *msg_ids),
        ) as cursor:
            rows = await cursor.fetchall()

        stale = [msg_id for msg_id, dest_path in rows if dest_path and not Path(dest_path).exists()]
        if stale:
            stale_placeholders = ",".join("?" * len(stale))
            await db.execute(
                f"DELETE FROM telegram_seen WHERE channel_id=? AND msg_id IN ({stale_placeholders})",
                (channel_id, *stale),
            )
            await db.commit()

    return {msg_id for msg_id, dest_path in rows if not (dest_path and not Path(dest_path).exists())}
