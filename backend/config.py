import yaml
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import Optional

CONFIG_PATH = Path(__file__).parent.parent / "config.yaml"


@dataclass
class Mount:
    name: str
    path: str


@dataclass
class ArrConfig:
    url: str
    api_key: str


@dataclass
class TelegramConfig:
    api_id: int
    api_hash: str
    session_file: str = "telegram.session"
    bot_token: str | None = None
    chat_id: str | None = None


@dataclass
class Config:
    password: str
    mounts: list[Mount]
    max_concurrent_jobs: int = 2
    max_channel_entries: int = 500
    telegram: Optional[TelegramConfig] = None
    sonarr: Optional[ArrConfig] = None
    radarr: Optional[ArrConfig] = None


_config: Config | None = None


def load_config() -> Config:
    global _config
    with open(CONFIG_PATH) as f:
        data = yaml.safe_load(f)

    tg_data = data.get("telegram")
    tg = TelegramConfig(**tg_data) if tg_data else None

    sonarr_data = data.get("sonarr")
    radarr_data = data.get("radarr")

    _config = Config(
        password=data["password"],
        mounts=[Mount(**m) for m in data["mounts"]],
        max_concurrent_jobs=data.get("max_concurrent_jobs", 2),
        max_channel_entries=data.get("max_channel_entries", 500),
        telegram=tg,
        sonarr=ArrConfig(**sonarr_data) if sonarr_data else None,
        radarr=ArrConfig(**radarr_data) if radarr_data else None,
    )
    return _config


def get_config() -> Config:
    if _config is None:
        return load_config()
    return _config


def reload_config() -> Config:
    """Force re-read from disk, busting the cache."""
    global _config
    _config = None
    return load_config()


def save_config(cfg: Config) -> None:
    """Serialize cfg back to yaml and write to disk."""
    def _arr(a):
        return {"url": a.url, "api_key": a.api_key} if a else None

    def _tg(t):
        if t is None:
            return None
        d = {"api_id": t.api_id, "api_hash": t.api_hash, "session_file": t.session_file}
        if t.bot_token is not None:
            d["bot_token"] = t.bot_token
        if t.chat_id is not None:
            d["chat_id"] = t.chat_id
        return d

    data = {
        "password": cfg.password,
        "mounts": [{"name": m.name, "path": m.path} for m in cfg.mounts],
        "max_concurrent_jobs": cfg.max_concurrent_jobs,
        "max_channel_entries": cfg.max_channel_entries,
    }
    if cfg.telegram:
        data["telegram"] = _tg(cfg.telegram)
    if cfg.sonarr:
        data["sonarr"] = _arr(cfg.sonarr)
    if cfg.radarr:
        data["radarr"] = _arr(cfg.radarr)

    with open(CONFIG_PATH, "w") as f:
        yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False)
