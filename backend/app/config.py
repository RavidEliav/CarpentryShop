"""Application settings loaded from environment variables."""

import secrets
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

# ASSUMPTION: a configurable default; override with OPENAI_CHAT_MODEL per environment.
DEFAULT_CHAT_MODEL = "gpt-5.4-mini"
# Without Supabase settings these environments save designs in memory (lost on restart).
IN_MEMORY_PERSISTENCE_ENVS = frozenset({"local", "e2e"})


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "local"
    cors_origins: str = "http://localhost:5173"
    openai_api_key: str = ""
    openai_chat_model: str = ""
    proposal_signing_key: str = ""
    # ASSUMPTION: configurable voice defaults (empty = the defaults in app/api/voice.py).
    openai_transcribe_model: str = ""
    openai_tts_model: str = ""
    openai_tts_voice: str = ""
    supabase_url: str = ""
    supabase_secret_key: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def chat_model(self) -> str:
        return self.openai_chat_model.strip() or DEFAULT_CHAT_MODEL

    @property
    def agent_enabled(self) -> bool:
        return bool(self.openai_api_key.strip())

    @property
    def supabase_configured(self) -> bool:
        return bool(self.supabase_url.strip() and self.supabase_secret_key.strip())

    @property
    def persistence_enabled(self) -> bool:
        return self.supabase_configured or self.app_env in IN_MEMORY_PERSISTENCE_ENVS


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_signing_key() -> bytes:
    """The HMAC key for proposals. Required outside local development.

    Locally (APP_ENV=local) a missing key falls back to a random per-process key, so
    proposals simply expire on restart; every other environment must configure one.
    """
    settings = get_settings()
    key = settings.proposal_signing_key.strip()
    if key:
        return key.encode()
    if settings.app_env == "local":
        return secrets.token_bytes(32)
    raise RuntimeError("PROPOSAL_SIGNING_KEY is not configured")
