"""Supabase design store, reached through the Data API (PostgREST) with the server-side secret key.

The `designs` table has RLS enabled with no policies and no grants for `anon`/`authenticated`, so
this backend (as `service_role`) is the only client that can read or write it. Saves are atomic
compare-and-set updates: `PATCH ... WHERE id = $1 AND revision = $2`."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpx2

from app.persistence.repository import PersistenceError, StoredDesign

log = logging.getLogger(__name__)

TIMEOUT_SECONDS = 10.0
COLUMNS = "id,token_hash,state,revision"
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1"})


def check_url(url: str) -> str:
    """The project URL without a trailing slash. Plain HTTP is only allowed for a local stack."""
    url = url.strip().rstrip("/")
    parts = urlsplit(url)
    secure = parts.scheme == "https" or (parts.scheme == "http" and parts.hostname in LOCAL_HOSTS)
    if not secure or not parts.hostname or parts.username is not None or parts.password is not None:
        raise RuntimeError("SUPABASE_URL must be an https:// URL")
    return url


class SupabaseDesignRepository:
    def __init__(self, url: str, secret_key: str, *, transport: httpx2.BaseTransport | None = None) -> None:
        headers = {"apikey": secret_key, "Accept": "application/json"}
        # New sb_secret_ keys travel only in `apikey`; a legacy service_role JWT must also be the bearer.
        if not secret_key.startswith("sb_"):
            headers["Authorization"] = f"Bearer {secret_key}"
        self._client = httpx2.Client(
            base_url=f"{check_url(url)}/rest/v1", headers=headers, timeout=TIMEOUT_SECONDS, transport=transport
        )

    def create(self, *, token_hash: str, state: dict, schema_version: int) -> StoredDesign:
        rows = self._send(
            "POST", params={"select": COLUMNS}, headers={"Prefer": "return=representation"},
            json={"token_hash": token_hash, "state": state, "schema_version": schema_version},
        )
        if len(rows) != 1:
            raise PersistenceError("the insert returned no row")
        return _stored(rows[0])

    def get(self, design_id: str) -> StoredDesign | None:
        canonical = _uuid(design_id)
        if canonical is None:
            return None
        rows = self._send("GET", params={"id": f"eq.{canonical}", "select": COLUMNS})
        return _stored(rows[0]) if rows else None

    def update(self, design_id: str, *, expected_revision: int, state: dict, schema_version: int) -> int | None:
        canonical = _uuid(design_id)
        if canonical is None:
            return None
        rows = self._send(
            "PATCH",
            params={"id": f"eq.{canonical}", "revision": f"eq.{int(expected_revision)}", "select": "revision"},
            headers={"Prefer": "return=representation"},
            json={
                "state": state, "schema_version": schema_version, "revision": expected_revision + 1,
                "updated_at": datetime.now(UTC).isoformat(),
            },
        )
        if not rows:
            return None
        revision = rows[0].get("revision") if isinstance(rows[0], dict) else None
        if type(revision) is not int:
            raise PersistenceError("unexpected update response")
        return revision

    def _send(self, method: str, **kwargs) -> list:
        try:
            response = self._client.request(method, "/designs", **kwargs)
        except httpx2.HTTPError as exc:
            # Never log the request itself: its headers carry the secret key.
            log.warning("design store request failed: %s", type(exc).__name__)
            raise PersistenceError("the design store is unreachable") from exc
        if response.status_code >= 400:
            log.warning("design store answered HTTP %s to %s", response.status_code, method)
            raise PersistenceError(f"the design store answered HTTP {response.status_code}")
        try:
            body = response.json()
        except ValueError as exc:
            raise PersistenceError("the design store answered with invalid JSON") from exc
        if not isinstance(body, list):
            raise PersistenceError("unexpected design store response")
        return body


def _uuid(design_id: str) -> str | None:
    # Only a canonical UUID ever reaches a PostgREST filter; anything else cannot be a design.
    try:
        return str(uuid.UUID(design_id))
    except (TypeError, ValueError):
        return None


def _stored(row: object) -> StoredDesign:
    if not isinstance(row, dict):
        raise PersistenceError("unexpected design row")
    state, revision = row.get("state"), row.get("revision")
    if not isinstance(state, dict) or type(revision) is not int:
        raise PersistenceError("unexpected design row")
    return StoredDesign(id=str(row.get("id")), token_hash=str(row.get("token_hash")), state=state, revision=revision)
