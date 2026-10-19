"""Saved designs (Phase 7). Supabase when configured; otherwise an in-memory store, but only in
local and E2E environments. Anywhere else saving is reported as unavailable."""

from __future__ import annotations

from functools import lru_cache

from app.config import IN_MEMORY_PERSISTENCE_ENVS, Settings
from app.persistence.memory_repo import MemoryDesignRepository
from app.persistence.repository import DesignRepository
from app.persistence.supabase_repo import SupabaseDesignRepository


def repository_for(settings: Settings) -> DesignRepository | None:
    if settings.supabase_configured:
        return _supabase(settings.supabase_url.strip(), settings.supabase_secret_key.strip())
    if settings.app_env in IN_MEMORY_PERSISTENCE_ENVS:
        return _memory()
    return None


@lru_cache
def _supabase(url: str, secret_key: str) -> SupabaseDesignRepository:
    return SupabaseDesignRepository(url, secret_key)


@lru_cache
def _memory() -> MemoryDesignRepository:
    return MemoryDesignRepository()
