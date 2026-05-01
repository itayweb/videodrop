"""Async HTTP client for Sonarr and Radarr APIs."""
import asyncio
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
    # If already exists just return its id
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


async def sonarr_manual_import(cfg: ArrConfig, file_path: str, series_id: int) -> None:
    """Import a specific file into Sonarr using the manual import API."""
    base = cfg.url.rstrip("/")

    # Step 1 — ask Sonarr to analyse the file
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"{base}/api/v3/manualimport",
            params={
                "path": file_path,
                "seriesId": series_id,
                "filterExistingFiles": "false",
            },
            headers=_headers(cfg),
        )
        r.raise_for_status()
        candidates = r.json()

    if not candidates:
        raise RuntimeError(
            f"Sonarr found no importable files at: {file_path}\n"
            "Make sure the file is accessible from the Sonarr LXC at this path."
        )

    # Validate — surface any rejections Sonarr flagged
    for c in candidates:
        rejections = c.get("rejections", [])
        hard = [rej for rej in rejections if rej.get("type") == "permanent"]
        if hard:
            reasons = ", ".join(r.get("reason", str(r)) for r in hard)
            raise RuntimeError(f"Sonarr rejected import: {reasons}")

    # Build the POST payload — include seasonNumber which is required
    payload = []
    for c in candidates:
        episode_ids = [ep["id"] for ep in c.get("episodes", [])]
        if not episode_ids:
            # Sonarr couldn't match to an episode — skip (won't import without episode)
            continue
        payload.append({
            "path": c["path"],
            "seriesId": series_id,
            "seasonNumber": c.get("seasonNumber", 0),
            "episodeIds": episode_ids,
            "quality": c.get("quality"),
            "languages": c.get("languages", []),
            "releaseGroup": c.get("releaseGroup", ""),
            "downloadId": c.get("downloadId", ""),
            "importMode": "move",
        })

    if not payload:
        raise RuntimeError(
            f"Sonarr could not match '{file_path}' to any episode.\n"
            "Make sure the filename includes season/episode info, e.g. 'Show Name S01E01.mp4'."
        )

    # Step 2 — execute the import
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{base}/api/v3/manualimport",
            json=payload,
            headers=_headers(cfg),
        )
        r.raise_for_status()


# ── Radarr ─────────────────────────────────────────────────────────────────────

async def radarr_manual_import(cfg: ArrConfig, file_path: str) -> None:
    """Import a specific file into Radarr using the manual import API."""
    base = cfg.url.rstrip("/")
    async with httpx.AsyncClient(timeout=30) as client:
        # Step 1 — analyse
        r = await client.get(
            f"{base}/api/v3/manualimport",
            params={
                "path": file_path,
                "filterExistingFiles": "false",
            },
            headers=_headers(cfg),
        )
        r.raise_for_status()
        candidates = r.json()

    if not candidates:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                f"{base}/api/v3/command",
                json={"name": "DownloadedMoviesScan", "path": file_path},
                headers=_headers(cfg),
            )
            r.raise_for_status()
        return

    payload = []
    for c in candidates:
        entry = {
            "path": c["path"],
            "quality": c.get("quality"),
            "languages": c.get("languages", []),
            "releaseGroup": c.get("releaseGroup", ""),
            "downloadId": c.get("downloadId", ""),
            "importMode": "move",
        }
        if c.get("movie"):
            entry["movieId"] = c["movie"]["id"]
        payload.append(entry)

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{base}/api/v3/manualimport",
            json=payload,
            headers=_headers(cfg),
        )
        r.raise_for_status()
