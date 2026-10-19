import pytest

from app.domain.defaults import basic_wardrobe
from app.persistence.memory_repo import MemoryDesignRepository
from app.persistence.repository import PersistenceError

HASH = "a" * 64


def test_create_then_get_returns_an_isolated_copy():
    repo = MemoryDesignRepository()
    design = basic_wardrobe()
    row = repo.create(token_hash=HASH, state=design, schema_version=1)
    assert row.revision == 1
    design["dimensions"]["width"] = 1  # the caller's object is not the stored one
    stored = repo.get(row.id)
    assert stored is not None and stored.state == basic_wardrobe()
    stored.state["dimensions"]["width"] = 2
    assert repo.get(row.id).state == basic_wardrobe()


def test_update_is_compare_and_set_on_the_revision():
    repo = MemoryDesignRepository()
    row = repo.create(token_hash=HASH, state=basic_wardrobe(), schema_version=1)
    edited = basic_wardrobe()
    edited["dimensions"]["depth"] = 550
    assert repo.update(row.id, expected_revision=1, state=edited, schema_version=1) == 2
    assert repo.update(row.id, expected_revision=1, state=basic_wardrobe(), schema_version=1) is None
    stored = repo.get(row.id)
    assert stored.revision == 2 and stored.state["dimensions"]["depth"] == 550


def test_unknown_ids_are_none():
    repo = MemoryDesignRepository()
    assert repo.get("00000000-0000-4000-8000-000000000000") is None
    assert repo.update("00000000-0000-4000-8000-000000000000", expected_revision=1, state={}, schema_version=1) is None


def test_the_store_is_bounded():
    repo = MemoryDesignRepository(max_designs=2)
    repo.create(token_hash=HASH, state={}, schema_version=1)
    repo.create(token_hash=HASH, state={}, schema_version=1)
    with pytest.raises(PersistenceError):
        repo.create(token_hash=HASH, state={}, schema_version=1)
