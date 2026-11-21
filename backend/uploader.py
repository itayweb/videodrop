"""Chunked upload handler.

Chunks are staged on the destination mount, inside the job's staging dir
(<mount>/.videodrop-tmp/<job_id>/.chunks), never on the app's own disk. The
LXC root disk is small; a single large upload staged there used to fill it.
The worker removes the whole staging dir when the job finishes, and
jobs.sweep_stale_uploads() removes chunks of uploads that were abandoned.
"""
import aiofiles
import errno
import shutil
from pathlib import Path
from fastapi import UploadFile
from . import ws_hub

CHUNKS_SUBDIR = ".chunks"

# Pre-fix location of upload chunks (on the app's root disk). Nothing writes
# here any more; it is only swept on startup to clear leftovers.
LEGACY_TMP_DIR = Path(__file__).parent.parent / "tmp"


class UploadRejected(Exception):
    """The chunk can't be accepted; `status` is the HTTP status to return."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def chunks_dir(staging: Path) -> Path:
    return staging / CHUNKS_SUBDIR


async def receive_chunk(
    job_id: str,
    staging: Path,
    chunk_index: int,
    total_chunks: int,
    chunk: UploadFile,
) -> bool:
    """Save a single chunk into the job's staging dir.

    Returns True when all chunks are received. Raises UploadRejected for a bad
    index, and OSError when the write fails (the caller decides what to do).
    """
    if not 0 <= chunk_index < total_chunks:
        raise UploadRejected(400, f"chunk_index {chunk_index} out of range 0..{total_chunks - 1}")

    job_chunks = chunks_dir(staging)
    job_chunks.mkdir(parents=True, exist_ok=True)
    chunk_path = job_chunks / f"{chunk_index:06d}"

    try:
        async with aiofiles.open(chunk_path, "wb") as f:
            content = await chunk.read()
            await f.write(content)
    except OSError:
        # Never leave a truncated chunk behind — it would be counted as received
        chunk_path.unlink(missing_ok=True)
        raise

    received = len(list(job_chunks.glob("*")))
    pct = round((received / total_chunks) * 95, 1)  # cap at 95 until assembly
    await ws_hub.broadcast(
        job_id,
        {"status": "uploading", "pct": pct, "speed": "", "eta": ""},
    )
    return received >= total_chunks


def is_disk_full(exc: OSError) -> bool:
    return exc.errno in (errno.ENOSPC, errno.EDQUOT)


async def assemble_and_move(job_id: str, filename: str, dest_dir: str) -> Path:
    """Assemble the job's chunks into dest_dir/filename.

    dest_dir is the job's staging dir, which also holds the chunks. Each chunk
    is deleted as soon as it has been appended, so assembly needs about one
    extra chunk of free space instead of a second copy of the whole file.
    """
    staging = Path(dest_dir)
    staging.mkdir(parents=True, exist_ok=True)
    job_chunks = chunks_dir(staging)
    out_file = staging / filename

    await ws_hub.broadcast(job_id, {"status": "assembling", "pct": 96})

    chunk_files = sorted(job_chunks.glob("*"))
    async with aiofiles.open(out_file, "wb") as out:
        for chunk_path in chunk_files:
            async with aiofiles.open(chunk_path, "rb") as f:
                await out.write(await f.read())
            chunk_path.unlink()

    shutil.rmtree(job_chunks, ignore_errors=True)
    # Not done yet — the worker still has to place the file at its destination
    await ws_hub.broadcast(job_id, {"status": "processing", "pct": 99})
    return out_file
