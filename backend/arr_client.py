"""Async HTTP client for Sonarr and Radarr APIs."""
import httpx
from .config import ArrConfig


def _headers(cfg: ArrConfig) -> dict:
    return {"X-Api-Key": cfg.api_key, "Content-Type": "application/json"}


# ── Sonarr ─────────────────────────────────────────────────────────────────────

async def sonarr_search(cfg: ArrConfig, query: str) -> list[dict]:
    """Search for a series by name. Returns both already-added and TVDB results."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f"{cfg.url.rstrip('/')}/api/v3/series/lookup",
            params={"term": query},
            headers=_headers(cfg),
        )
        r.raise_for_status()
        results = r.json()

    # Normalise: include `id` field (non-zero means already in Sonarr)
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
    """Return the first quality profile id (used when adding a new series)."""
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
    """Return the first root folder path configured in Sonarr."""
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


async def sonarr_add_series(cfg: ArrConfig, tvdb_id: int, title: str, year: int) -> dict:
    """Add a series to Sonarr (creates its folder). Returns the created series."""
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
        return r.json()


async def sonarr_trigger_import(cfg: ArrConfig, file_path: str) -> None:
    """Tell Sonarr to scan a specific path for downloaded episodes."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"{cfg.url.rstrip('/')}/api/v3/command",
            json={"name": "DownloadedEpisodesScan", "path": file_path},
            headers=_headers(cfg),
        )
        r.raise_for_status()


# ── Radarr ─────────────────────────────────────────────────────────────────────

async def radarr_trigger_import(cfg: ArrConfig, file_path: str) -> None:
    """Tell Radarr to scan a specific path for downloaded movies."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"{cfg.url.rstrip('/')}/api/v3/command",
            json={"name": "DownloadedMoviesScan", "path": file_path},
            headers=_headers(cfg),
        )
        r.raise_for_status()
