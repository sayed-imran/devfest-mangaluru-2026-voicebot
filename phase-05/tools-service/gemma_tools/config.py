"""Settings from environment variables (and an optional `.env` next to this package)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

SERVICE_DIR = Path(__file__).resolve().parent.parent

# Real environment variables win over `.env`.
load_dotenv(SERVICE_DIR / ".env", override=False)

LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


def _str(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return value.strip() if value is not None and value.strip() else default


def _bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    try:
        return int(_str(name, str(default)))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(_str(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    api_key: str
    allowed_hosts: tuple[str, ...]
    llm_base_url: str
    llm_model: str
    llm_api_key: str
    llm_timeout_s: float
    laya_base_url: str
    laya_timeout_ms: int
    route_threshold: float
    mcp_config: Path
    max_steps: int
    fast_confirm: bool
    user_name: str

    @property
    def is_loopback(self) -> bool:
        return self.host in LOOPBACK_HOSTS


@dataclass(frozen=True)
class DesktopSettings:
    dry_run: bool
    browser: str
    search_engine: str
    mail_client: str
    gmail_account: str
    home_url: str


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    mcp_config = Path(_str("TOOLS_MCP_CONFIG", "mcp_servers.json"))
    if not mcp_config.is_absolute():
        mcp_config = SERVICE_DIR / mcp_config
    return Settings(
        host=_str("TOOLS_HOST", "127.0.0.1"),
        port=_int("TOOLS_PORT", 8765),
        api_key=_str("TOOLS_API_KEY"),
        allowed_hosts=tuple(
            h.strip() for h in _str("TOOLS_ALLOWED_HOSTS").split(",") if h.strip()
        ),
        llm_base_url=_str("LLM_BASE_URL", "http://127.0.0.1:8081").rstrip("/"),
        llm_model=_str("LLM_MODEL", "gemma4-e4b"),
        llm_api_key=_str("LLM_API_KEY"),
        llm_timeout_s=_float("LLM_TIMEOUT_S", 90.0),
        laya_base_url=_str("LAYA_BASE_URL", "http://localhost:8002").rstrip("/"),
        laya_timeout_ms=max(300, _int("LAYA_TIMEOUT_MS", 2500)),
        route_threshold=min(0.95, max(0.05, _float("TOOLS_ROUTE_THRESHOLD", 0.5))),
        mcp_config=mcp_config,
        max_steps=max(1, min(8, _int("TOOLS_MAX_STEPS", 4))),
        fast_confirm=_bool("TOOLS_FAST_CONFIRM", True),
        user_name=_str("TOOLS_USER_NAME"),
    )


@lru_cache(maxsize=1)
def get_desktop_settings() -> DesktopSettings:
    return DesktopSettings(
        dry_run=_bool("TOOLS_DRY_RUN", False),
        browser=_str("TOOLS_BROWSER", "default").lower(),
        search_engine=_str("TOOLS_SEARCH_ENGINE", "google").lower(),
        mail_client=_str("TOOLS_MAIL_CLIENT", "gmail").lower(),
        gmail_account=_str("TOOLS_GMAIL_ACCOUNT"),
        home_url=_str("TOOLS_HOME_URL", "https://www.google.com/"),
    )
