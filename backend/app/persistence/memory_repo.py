"""In-memory design store for local development and E2E runs. Everything is lost on restart."""

from __future__ import annotations

import copy
import threading
import uuid
from dataclasses import replace

from app.persistence.repository import PersistenceError, StoredDesign

MAX_DESIGNS = 1000  # bounds memory for a long-running local or E2E server


class MemoryDesignRepository:
    def __init__(self, max_designs: int = MAX_DESIGNS) -> None:
        self._rows: dict[str, StoredDesign] = {}
        self._max_designs = max_designs
        self._lock = threading.Lock()

    def create(self, *, token_hash: str, state: dict, schema_version: int) -> StoredDesign:
        with self._lock:
            if len(self._rows) >= self._max_designs:
                raise PersistenceError("the in-memory design store is full")
            row = StoredDesign(id=str(uuid.uuid4()), token_hash=token_hash, state=copy.deepcopy(state), revision=1)
            self._rows[row.id] = row
            return replace(row, state=copy.deepcopy(row.state))

    def get(self, design_id: str) -> StoredDesign | None:
        with self._lock:
            row = self._rows.get(design_id)
            return None if row is None else replace(row, state=copy.deepcopy(row.state))

    def update(self, design_id: str, *, expected_revision: int, state: dict, schema_version: int) -> int | None:
        with self._lock:
            row = self._rows.get(design_id)
            if row is None or row.revision != expected_revision:
                return None
            self._rows[design_id] = replace(row, state=copy.deepcopy(state), revision=row.revision + 1)
            return row.revision + 1
