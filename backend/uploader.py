"""Chunked upload handler — assembles chunks into a temp file then moves to dest."""
import aiofiles
import asyncio
import os
import shutil
from pathlib import Path
from fastapi import UploadFile
from . import ws_hub
from .db import update_job_status

TMP_DIR = Path(__file__).parent.parent / "tmp"
TMP_DIR.mkdir(exist_ok=True)


async def receive_chunk(
    job_id: str,
    filename: str,
    chunk_index: int,
    total_chunks: int,
    chunk: UploadFile,
) -> bool:
    """Save a single chunk. Returns True when all chunks are received."""
    job_tmp = TMP_DIR / job_id
    job_tmp.mkdir(exist_ok=True)
    chunk_path = job_tmp / f"{chunk_index:06d}"

    async with aiofiles.open(chunk_path, "wb") as f:
        content = await chunk.read()
        await f.write(content)

    received = len(list(job_tmp.glob("*")))
    pct = round((received / total_chunks) * 95, 1)  # cap at 95 until assembly
    await ws_hub.broadcast(
        job_id,
        {"status": "uploading", "pct": pct, "speed": "", "eta": ""},
    )
    return received >= total_chunks


async def assemble_and_move(job_id: str, filename: str, dest_dir: str) -> Path:
    """Assemble chunks into a single file and move to dest_dir."""
    job_tmp = TMP_DIR / job_id
    dest_path = Path(dest_dir)
    dest_path.mkdir(parents=True, exist_ok=True)
    out_file = dest_path / filename

    await ws_hub.broadcast(job_id, {"status": "assembling", "pct": 96})

    chunk_files = sorted(job_tmp.glob("*"))
    async with aiofiles.open(out_file, "wb") as out:
        for chunk_path in chunk_files:
            async with aiofiles.open(chunk_path, "rb") as f:
                await out.write(await f.read())

    shutil.rmtree(job_tmp, ignore_errors=True)
    await ws_hub.broadcast(job_id, {"status": "done", "pct": 100})
    return out_file
