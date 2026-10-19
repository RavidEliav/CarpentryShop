"""The saved-design store contract, shared by the Supabase and in-memory implementations."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class StoredDesign:
    id: str
    token_hash: str
    state: dict
    revision: int


class PersistenceError(Exception):
    """The store failed or answered unexpectedly. Details are logged, never shown to the customer."""


class DesignRepository(Protocol):
    def create(self, *, token_hash: str, state: dict, schema_version: int) -> StoredDesign: ...

    def get(self, design_id: str) -> StoredDesign | None: ...

    def update(self, design_id: str, *, expected_revision: int, state: dict, schema_version: int) -> int | None:
        """Write only if the stored revision still equals `expected_revision`; return the new
        revision, or None when the revision moved on (or the row is gone)."""
        ...
