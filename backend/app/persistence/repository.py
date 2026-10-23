"""Saved designs. The API talks to a repository, never to Supabase directly: Supabase (PostgREST,
with the server-side secret key) in dev and production, an in-memory store for tests and local runs."""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass
from functools import lru_cache
from typing import Protocol

import httpx2

from app.config import get_settings


class StorageError(Exception):
    """The store could not be reached or answered unexpectedly."""


@dataclass(frozen=True)
class SavedDesign:
    token_hash: str
    name: str
    design: dict
    revision: int


class DesignRepository(Protocol):
    def create(self, token_hash: str, name: str, design: dict) -> tuple[str, int]: ...

    def get(self, design_id: str) -> SavedDesign | None: ...

    def update(self, design_id: str, token_hash: str, expected_revision: int, name: str, design: dict) -> int | None:
        """The new revision, or None when the row is gone or no longer at expected_revision."""
        ...


class InMemoryRepository:
    def __init__(self) -> None:
        self._rows: dict[str, SavedDesign] = {}
        self._lock = threading.Lock()

    def create(self, token_hash: str, name: str, design: dict) -> tuple[str, int]:
        design_id = str(uuid.uuid4())
        with self._lock:
            self._rows = {**self._rows, design_id: SavedDesign(token_hash, name, design, 1)}
        return design_id, 1

    def get(self, design_id: str) -> SavedDesign | None:
        return self._rows.get(design_id)

    def update(self, design_id: str, token_hash: str, expected_revision: int, name: str, design: dict) -> int | None:
        with self._lock:
            row = self._rows.get(design_id)
            if row is None or row.token_hash != token_hash or row.revision != expected_revision:
                return None
            self._rows = {**self._rows, design_id: SavedDesign(token_hash, name, design, expected_revision + 1)}
        return expected_revision + 1


class SupabaseRepository:
    def __init__(self, url: str, secret_key: str, client: httpx2.Client | None = None) -> None:
        self._endpoint = f"{url.rstrip('/')}/rest/v1/designs"
        self._client = client or httpx2.Client(timeout=10)
        self._headers = {"apikey": secret_key, "Authorization": f"Bearer {secret_key}"}

    def _send(self, method: str, params: dict, json: dict | None = None) -> list[dict]:
        headers = {**self._headers, "Prefer": "return=representation"} if json is not None else self._headers
        try:
            response = self._client.request(method, self._endpoint, params=params, json=json, headers=headers)
        except httpx2.HTTPError as exc:
            # from None: the chained error may carry the URL, whose filters include the token hash
            raise StorageError(f"Supabase request failed: {type(exc).__name__}") from None
        if response.status_code >= 400:
            raise StorageError(f"Supabase answered {response.status_code}")
        try:
            rows = response.json()
        except ValueError:
            rows = None
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            raise StorageError("Supabase returned an unexpected body")
        return rows

    def create(self, token_hash: str, name: str, design: dict) -> tuple[str, int]:
        return _fields(self._create, token_hash, name, design)

    def get(self, design_id: str) -> SavedDesign | None:
        return _fields(self._get, design_id)

    def update(self, design_id: str, token_hash: str, expected_revision: int, name: str, design: dict) -> int | None:
        return _fields(self._update, design_id, token_hash, expected_revision, name, design)

    def _create(self, token_hash: str, name: str, design: dict) -> tuple[str, int]:
        rows = self._send("POST", {"select": "id,revision"}, {"token_hash": token_hash, "name": name, "design": design})
        if len(rows) != 1:
            raise StorageError("Supabase did not return the new row")
        return rows[0]["id"], rows[0]["revision"]

    def _get(self, design_id: str) -> SavedDesign | None:
        rows = self._send("GET", {"id": f"eq.{design_id}", "select": "token_hash,name,design,revision"})
        if not rows:
            return None
        row = rows[0]
        return SavedDesign(row["token_hash"], row["name"], row["design"], row["revision"])

    def _update(self, design_id: str, token_hash: str, expected_revision: int, name: str, design: dict) -> int | None:
        # The filter is the optimistic lock: zero matching rows means someone saved first (or the link is wrong).
        params = {"id": f"eq.{design_id}", "token_hash": f"eq.{token_hash}",
                  "revision": f"eq.{expected_revision}", "select": "revision"}
        rows = self._send("PATCH", params, {"name": name, "design": design, "revision": expected_revision + 1,
                                            "updated_at": "now"})  # Postgres reads 'now' as the current time
        return rows[0]["revision"] if rows else None


def _fields(call, *args):
    """Run a Supabase call; a row missing the expected columns is a storage error, not a 500."""
    try:
        return call(*args)
    except (KeyError, TypeError) as exc:
        raise StorageError(f"Supabase returned an unexpected row: {type(exc).__name__}") from None


@lru_cache
def _local_repository() -> InMemoryRepository:
    return InMemoryRepository()


@lru_cache
def _supabase_repository(url: str, secret_key: str) -> SupabaseRepository:
    return SupabaseRepository(url, secret_key)


def get_repository() -> DesignRepository | None:
    """Supabase when configured; an in-memory store for local and E2E runs; otherwise None (saving is off)."""
    settings = get_settings()
    if settings.storage_enabled:
        return _supabase_repository(settings.supabase_url.strip(), settings.supabase_secret_key.strip())
    if settings.app_env in ("local", "e2e"):
        return _local_repository()
    return None
