"""Async HTTP client for Sonarr and Radarr APIs."""
import asyncio
import os
import pathlib

import httpx
from .config import ArrConfig


def _headers(cfg: ArrConfig) -> dict:
    return {"X-Api-Key": cfg.api_key, "Content-Type": "application/json"}


# ── Root folders (same endpoint shape in both Sonarr and Radarr) ───────────────

async def get_root_folders(cfg: ArrConfig) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f"{cfg.url.rstrip('/')}/api/v3/rootfolder",
            headers=_headers(cfg),
        )
        r.raise_for_status()
        return r.json()


def resolve_root_folder(roots: list[dict], mount_path: str) -> str | None:
    """Return the root folder that lives under mount_path, or None.

    Mounts map 1:1 to root folders, so the first match wins.
    """
    mount = pathlib.Path(mount_path)
    for root in roots:
        path = root.get("path")
        if path and pathlib.Path(path).is_relative_to(mount):
            return path
    return None


async def move_into(src: str | pathlib.Path, dest_dir: pathlib.Path) -> pathlib.Path:
    """Move a file into dest_dir on the same filesystem — an atomic rename."""
    src = pathlib.Path(src)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    await asyncio.to_thread(os.replace, str(src), str(dest))
    return dest


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
            # Only set for series already added — tells the UI which drive it lives on
            "path": s.get("path") if s.get("id") else None,
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


async def sonarr_episodes_with_files(cfg: ArrConfig, series_id: int) -> set[tuple[int, int]]:
    """Return {(season, episode)} for episodes Sonarr already has a file for.

    Source of truth for "already imported": Sonarr moves+renames files into its
    own library on import, so checking the download mount misses them.
    """
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{cfg.url.rstrip('/')}/api/v3/episode",
            params={"seriesId": series_id},
            headers=_headers(cfg),
        )
        r.raise_for_status()
    return {
        (e["seasonNumber"], e["episodeNumber"])
        for e in r.json()
        if e.get("hasFile")
    }


async def sonarr_add_series(
    cfg: ArrConfig, tvdb_id: int, title: str, year: int, root_folder: str
) -> int:
    """Add a series to Sonarr under root_folder. Returns the Sonarr series id.

    root_folder is resolved from the destination mount the user picked, so a new
    series is created on the drive they chose rather than on Sonarr's first root.
    An existing series keeps whatever folder Sonarr already has for it.
    """
    existing_id = await sonarr_get_series_id(cfg, tvdb_id)
    if existing_id:
        return existing_id

    profile_id = await sonarr_get_default_profile_id(cfg)

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


async def sonarr_get_series_path(cfg: ArrConfig, series_id: int) -> str:
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f"{cfg.url.rstrip('/')}/api/v3/series/{series_id}",
            headers=_headers(cfg),
        )
        r.raise_for_status()
        return r.json()["path"]


async def sonarr_rescan_series(cfg: ArrConfig, series_id: int) -> None:
    """Tell Sonarr to rescan its series folder so it picks up the new file.

    Only worth calling when the file landed inside Sonarr's own series folder —
    a series has exactly one path, so a rescan can't see files on another drive.
    """
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{cfg.url.rstrip('/')}/api/v3/command",
            json={"name": "RescanSeries", "seriesId": series_id},
            headers=_headers(cfg),
        )
        r.raise_for_status()
        cmd_id = r.json().get("id")
        print(f"[sonarr] RescanSeries accepted (commandId={cmd_id})", flush=True)


# ── Radarr ─────────────────────────────────────────────────────────────────────

async def radarr_search(cfg: ArrConfig, query: str) -> list[dict]:
    """Search for a movie by name. Returns both already-added and TMDB results."""
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"{cfg.url.rstrip('/')}/api/v3/movie/lookup",
            params={"term": query},
            headers=_headers(cfg),
        )
        r.raise_for_status()
        results = r.json()

    out = []
    for m in results[:10]:
        out.append({
            "tmdbId": m.get("tmdbId"),
            "title": m.get("title", ""),
            "year": m.get("year", 0),
            "overview": m.get("overview", "")[:120],
            "inRadarr": bool(m.get("id")),
            "radarrId": m.get("id"),
        })
    return out


async def radarr_scan(cfg: ArrConfig, path: str) -> None:
    """Point DownloadedMoviesScan at a folder Radarr can import from in place.

    The file has already been moved onto the destination mount, so Radarr never
    has to relocate it across drives.
    """
    print(f"[radarr] triggering DownloadedMoviesScan for {path!r}", flush=True)

    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{cfg.url.rstrip('/')}/api/v3/command",
            json={"name": "DownloadedMoviesScan", "path": path},
            headers=_headers(cfg),
        )
        r.raise_for_status()
        cmd_id = r.json().get("id")
        print(f"[radarr] DownloadedMoviesScan accepted (commandId={cmd_id})", flush=True)
