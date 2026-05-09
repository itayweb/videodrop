"""Async HTTP client for Sonarr and Radarr APIs."""
import asyncio
import pathlib
import shutil

import httpx
from .config import ArrConfig


def _headers(cfg: ArrConfig) -> dict:
    return {"X-Api-Key": cfg.api_key, "Content-Type": "application/json"}


# ── Sonarr ─────────────────────────────────────────────────────────────────────

async def sonarr_search(cfg: ArrConfig, query: str) -> list[dict]:
    """Search for a series by name. Returns both already-added and TVDB results."""
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"{cfg.url.rstrip('/')}/api/v3/series/lookup",
            params={"term": query},
            headers=_headers(cfg),
        )
        r.raise_for_status()
        results = r.json()

    out = []
    for s in results[:10]:
        out.append({
            "tvdbId": s.get("tvdbId"),
            "title": s.get("title", ""),
            "year": s.get("year", 0),
            "overview": s.get("overview", "")[:120],
            "inSonarr": bool(s.get("id")),
            "sonarrId": s.get("id"),
        })
    return out


async def sonarr_get_default_profile_id(cfg: ArrConfig) -> int:
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f"{cfg.url.rstrip('/')}/api/v3/qualityprofile",
            headers=_headers(cfg),
        )
        r.raise_for_status()
        profiles = r.json()
    if not profiles:
        raise RuntimeError("No quality profiles found in Sonarr")
    return profiles[0]["id"]


async def sonarr_get_root_folder(cfg: ArrConfig) -> str:
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f"{cfg.url.rstrip('/')}/api/v3/rootfolder",
            headers=_headers(cfg),
        )
        r.raise_for_status()
        folders = r.json()
    if not folders:
        raise RuntimeError("No root folders found in Sonarr")
    return folders[0]["path"]


async def sonarr_get_series_id(cfg: ArrConfig, tvdb_id: int) -> int | None:
    """Return Sonarr's internal series id for a given tvdbId, or None if not found."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f"{cfg.url.rstrip('/')}/api/v3/series",
            headers=_headers(cfg),
        )
        r.raise_for_status()
    for s in r.json():
        if s.get("tvdbId") == tvdb_id:
            return s["id"]
    return None


async def sonarr_add_series(cfg: ArrConfig, tvdb_id: int, title: str, year: int) -> int:
    """Add a series to Sonarr (creates its folder). Returns the Sonarr series id."""
    existing_id = await sonarr_get_series_id(cfg, tvdb_id)
    if existing_id:
        return existing_id

    profile_id = await sonarr_get_default_profile_id(cfg)
    root_folder = await sonarr_get_root_folder(cfg)

    payload = {
        "tvdbId": tvdb_id,
        "title": title,
        "year": year,
        "qualityProfileId": profile_id,
        "rootFolderPath": root_folder,
        "monitored": True,
        "addOptions": {
            "searchForMissingEpisodes": False,
            "ignoreEpisodesWithFiles": False,
            "ignoreEpisodesWithoutFiles": False,
        },
    }
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{cfg.url.rstrip('/')}/api/v3/series",
            json=payload,
            headers=_headers(cfg),
        )
        r.raise_for_status()
        return r.json()["id"]


async def sonarr_import_episode(cfg: ArrConfig, file_path: str, series_id: int) -> None:
    """Move the episode file into the Sonarr series folder then trigger a rescan.

    This is more reliable than the manual-import API because we control the file
    move ourselves — no dependency on Sonarr's download-client tracking.
    Sonarr's RescanSeries command then detects the new file in its own folder
    and links it to the correct episode automatically.
    """
    base = cfg.url.rstrip("/")

    # ── 1. Get the series folder path from Sonarr ──────────────────────────────
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f"{base}/api/v3/series/{series_id}",
            headers=_headers(cfg),
        )
        r.raise_for_status()
        series_path = r.json()["path"]

    src = pathlib.Path(file_path)
    dest = pathlib.Path(series_path) / src.name

    print(f"[sonarr] moving {str(src)!r} → {str(dest)!r}", flush=True)

    # ── 2. Move the file (blocking but near-instant on same filesystem) ────────
    await asyncio.to_thread(shutil.move, str(src), str(dest))

    print(f"[sonarr] move done — queuing RescanSeries (seriesId={series_id})", flush=True)

    # ── 3. Tell Sonarr to rescan its series folder ─────────────────────────────
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{base}/api/v3/command",
            json={"name": "RescanSeries", "seriesId": series_id},
            headers=_headers(cfg),
        )
        r.raise_for_status()
        cmd_id = r.json().get("id")
        print(f"[sonarr] RescanSeries accepted (commandId={cmd_id})", flush=True)


# ── Radarr ─────────────────────────────────────────────────────────────────────

async def radarr_import_movie(cfg: ArrConfig, file_path: str) -> None:
    """Move the movie file into the Radarr download folder and trigger a scan.

    We use DownloadedMoviesScan pointed at the specific file so Radarr picks it
    up without needing a registered download client.
    """
    base = cfg.url.rstrip("/")

    print(f"[radarr] triggering DownloadedMoviesScan for {file_path!r}", flush=True)

    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{base}/api/v3/command",
            json={"name": "DownloadedMoviesScan", "path": file_path},
            headers=_headers(cfg),
        )
        r.raise_for_status()
        cmd_id = r.json().get("id")
        print(f"[radarr] DownloadedMoviesScan accepted (commandId={cmd_id})", flush=True)
