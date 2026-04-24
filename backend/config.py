import yaml
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

CONFIG_PATH = Path(__file__).parent.parent / "config.yaml"


@dataclass
class Mount:
    name: str
    path: str


@dataclass
class TelegramConfig:
    api_id: int
    api_hash: str
    session_file: str = "telegram.session"


@dataclass
class Config:
    password: str
    mounts: list[Mount]
    max_concurrent_jobs: int = 2
    telegram: Optional[TelegramConfig] = None


_config: Config | None = None


def load_config() -> Config:
    global _config
    with open(CONFIG_PATH) as f:
        data = yaml.safe_load(f)

    tg_data = data.get("telegram")
    tg = TelegramConfig(**tg_data) if tg_data else None

    _config = Config(
        password=data["password"],
        mounts=[Mount(**m) for m in data["mounts"]],
        max_concurrent_jobs=data.get("max_concurrent_jobs", 2),
        telegram=tg,
    )
    return _config


def get_config() -> Config:
    if _config is None:
        return load_config()
    return _config
