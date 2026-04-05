"""WebSocket connection hub — broadcast progress updates to connected clients per job."""
import asyncio
import json
from fastapi import WebSocket

# job_id -> set of connected WebSockets
_connections: dict[str, set[WebSocket]] = {}


def subscribe(job_id: str, ws: WebSocket):
    _connections.setdefault(job_id, set()).add(ws)


def unsubscribe(job_id: str, ws: WebSocket):
    _connections.get(job_id, set()).discard(ws)


async def broadcast(job_id: str, payload: dict):
    dead = set()
    for ws in list(_connections.get(job_id, set())):
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:
            dead.add(ws)
    for ws in dead:
        unsubscribe(job_id, ws)
