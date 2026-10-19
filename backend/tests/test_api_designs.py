"""Saved designs API (Phase 7) against the in-memory store: links, access, optimistic saves, limits."""

import pytest
from fastapi.testclient import TestClient

from app.api.designs import MAX_BODY_BYTES, get_create_limiter, get_repository
from app.config import get_settings
from app.domain.defaults import basic_wardrobe
from app.main import create_app
from app.persistence.memory_repo import MemoryDesignRepository
from app.persistence.repository import PersistenceError
from app.services import tokens
from app.services.rate_limit import RateLimiter

UNKNOWN_ID = "00000000-0000-4000-8000-000000000000"


class SpyRepository(MemoryDesignRepository):
    def __init__(self):
        super().__init__()
        self.creates = 0

    def create(self, **kwargs):
        self.creates += 1
        return super().create(**kwargs)


@pytest.fixture
def repo():
    return SpyRepository()


def make_client(repo, limiter=None):
    app = create_app()
    app.dependency_overrides[get_repository] = lambda: repo
    app.dependency_overrides[get_create_limiter] = lambda: limiter or RateLimiter(1000, 60)
    return TestClient(app)


@pytest.fixture
def client(repo):
    return make_client(repo)


@pytest.fixture
def env(monkeypatch):
    """Set environment variables for a fresh app; settings are re-read and restored afterwards."""
    def apply(**values):
        for name, value in values.items():
            monkeypatch.setenv(name, value)
        get_settings.cache_clear()
    yield apply
    get_settings.cache_clear()


def bearer(token, revision=None):
    headers = {"Authorization": f"Bearer {token}"}
    if revision is not None:
        headers["If-Match"] = f'"{revision}"'
    return headers


def create(client, design=None):
    response = client.post("/api/designs", json={"design": design or basic_wardrobe()})
    assert response.status_code == 201, response.text
    data = response.json()["data"]
    return f"/api/designs/{data['designId']}", data["accessToken"], data


def wider(width=2400):
    design = basic_wardrobe()
    design["dimensions"]["width"] = width
    for compartment in design["compartments"]:
        compartment["width"] += (width - 2000) // 3
    design["compartments"][-1]["width"] += (width - 2000) % 3
    return design


# ---- create and open ----

def test_create_returns_a_private_link_and_stores_only_the_token_hash(client, repo):
    response = client.post("/api/designs", json={"design": basic_wardrobe()})
    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["etag"] == '"1"'
    data = response.json()["data"]
    assert set(data) == {"designId", "accessToken", "revision"} and data["revision"] == 1
    assert tokens.is_well_formed(data["accessToken"])
    stored = repo.get(data["designId"])
    assert stored.token_hash == tokens.hash_token(data["accessToken"])
    assert data["accessToken"] not in repr(stored)
    assert stored.state == basic_wardrobe()


def test_the_link_reopens_the_saved_design(client):
    url, token, _ = create(client, wider())
    response = client.get(url, headers=bearer(token))
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"success": True, "data": {"design": wider(), "revision": 1}}


def test_wrong_token_unknown_and_malformed_ids_look_the_same(client):
    url, token, data = create(client)
    responses = [
        client.get(url, headers=bearer(tokens.new_token())),
        client.get(f"/api/designs/{UNKNOWN_ID}", headers=bearer(token)),
        client.get("/api/designs/not-a-uuid", headers=bearer(token)),
        client.get(f"/api/designs/{data['designId'].upper()}", headers=bearer(token)),
    ]
    assert {r.status_code for r in responses} == {404}
    assert {r.json()["error"]["code"] for r in responses} == {"NOT_FOUND"}
    assert len({r.text for r in responses}) == 1


@pytest.mark.parametrize("headers", [
    {}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer short"},
    {"Authorization": "Bearer " + "a" * 44}, {"Authorization": "bearer " + "a" * 43},
])
def test_a_missing_or_malformed_access_key_is_401(client, headers):
    url, _, _ = create(client)
    response = client.get(url, headers=headers)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.json()["error"]["code"] == "UNAUTHORIZED"


# ---- saving changes ----

def test_saving_changes_bumps_the_revision(client):
    url, token, _ = create(client)
    response = client.put(url, json={"design": wider()}, headers=bearer(token, 1))
    assert response.status_code == 200
    assert response.json() == {"success": True, "data": {"revision": 2}}
    assert response.headers["etag"] == '"2"'
    assert client.get(url, headers=bearer(token)).json()["data"] == {"design": wider(), "revision": 2}
    unquoted = {**bearer(token), "If-Match": "2"}
    assert client.put(url, json={"design": basic_wardrobe()}, headers=unquoted).json()["data"]["revision"] == 3


def test_a_stale_save_is_409_and_changes_nothing(client):
    url, token, _ = create(client)
    assert client.put(url, json={"design": wider(2400)}, headers=bearer(token, 1)).status_code == 200
    stale = client.put(url, json={"design": wider(2600)}, headers=bearer(token, 1))
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "CONFLICT"
    assert client.get(url, headers=bearer(token)).json()["data"] == {"design": wider(2400), "revision": 2}


def test_a_save_that_loses_the_race_after_the_read_is_409(client, repo):
    url, token, _ = create(client)
    repo.update = lambda *args, **kwargs: None  # another save landed between the read and the write
    response = client.put(url, json={"design": wider()}, headers=bearer(token, 1))
    assert response.status_code == 409


@pytest.mark.parametrize("if_match", [None, "", "abc", "0", '"-1"', 'W/"1"', '"1", "2"', "1" * 10])
def test_saving_changes_needs_a_valid_if_match(client, if_match):
    url, token, _ = create(client)
    headers = bearer(token) if if_match is None else {**bearer(token), "If-Match": if_match}
    response = client.put(url, json={"design": wider()}, headers=headers)
    assert response.status_code == 428
    assert response.json()["error"]["code"] == "REVISION_REQUIRED"


def test_saving_changes_needs_the_right_token(client):
    url, _, _ = create(client)
    assert client.put(url, json={"design": wider()}, headers=bearer(tokens.new_token(), 1)).status_code == 404
    assert client.put(url, json={"design": wider()}, headers={"If-Match": '"1"'}).status_code == 401


# ---- validation and limits ----

def test_invalid_designs_are_refused_with_the_domain_error_and_nothing_is_stored(client, repo):
    broken = basic_wardrobe()
    broken["dimensions"]["width"] = 10
    response = client.post("/api/designs", json={"design": broken})
    assert response.status_code == 422
    body = response.json()
    assert body["success"] is False and body["error"]["path"]
    assert repo.creates == 0
    url, token, _ = create(client)
    assert client.put(url, json={"design": broken}, headers=bearer(token, 1)).status_code == 422
    assert client.get(url, headers=bearer(token)).json()["data"]["revision"] == 1


@pytest.mark.parametrize("content", [
    b"not json", b"[]", b'"text"', b'{"design": "x"}', b'{"design": {}, "extra": 1}', b"[" * 50_000,
], ids=["not-json", "array", "string", "design-not-object", "extra-key", "deeply-nested"])
def test_bodies_must_be_json_with_only_a_design(client, repo, content):
    response = client.post("/api/designs", content=content, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert response.json()["success"] is False
    assert repo.creates == 0


def test_oversized_bodies_are_refused(client, repo):
    content = b'{"design": "' + b"x" * MAX_BODY_BYTES + b'"}'
    response = client.post("/api/designs", content=content, headers={"Content-Type": "application/json"})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "TOO_LARGE"
    assert repo.creates == 0


def test_creating_designs_is_rate_limited(repo):
    client = make_client(repo, RateLimiter(2, 60))
    create(client)
    create(client)
    response = client.post("/api/designs", json={"design": basic_wardrobe()})
    assert response.status_code == 429
    assert response.headers["retry-after"] == "60"
    assert repo.creates == 2


def test_store_failures_are_503_without_details():
    class Broken(MemoryDesignRepository):
        def create(self, **kwargs):
            raise PersistenceError("db password is hunter2")

    response = make_client(Broken()).post("/api/designs", json={"design": basic_wardrobe()})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "STORE_ERROR"
    assert "hunter2" not in response.text


def test_a_stored_design_that_no_longer_validates_is_refused(client, repo):
    token = tokens.new_token()
    row = repo.create(token_hash=tokens.hash_token(token), state={"schemaVersion": 99}, schema_version=1)
    response = client.get(f"/api/designs/{row.id}", headers=bearer(token))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "STORED_DESIGN_INVALID"


def test_cors_allows_the_frontend_to_send_the_access_key_and_revision(client):
    url, _, _ = create(client)
    response = client.options(url, headers={
        "Origin": "http://localhost:5173", "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "authorization,if-match,content-type",
    })
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


# ---- configuration ----

def test_saving_is_unavailable_in_production_without_supabase(env):
    env(APP_ENV="production", SUPABASE_URL="", SUPABASE_SECRET_KEY="")
    client = TestClient(create_app())
    assert client.get("/api/health").json()["data"]["persistence"] is False
    response = client.post("/api/designs", json={"design": basic_wardrobe()})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PERSISTENCE_UNAVAILABLE"


def test_local_development_saves_in_memory(env):
    env(APP_ENV="local", SUPABASE_URL="", SUPABASE_SECRET_KEY="")
    client = TestClient(create_app())
    assert client.get("/api/health").json()["data"]["persistence"] is True
    url, token, _ = create(client)
    assert client.get(url, headers=bearer(token)).status_code == 200


def test_a_plain_http_supabase_url_stops_the_server_from_starting(env):
    env(APP_ENV="production", SUPABASE_URL="http://proj.supabase.co", SUPABASE_SECRET_KEY="sb_secret_x")
    with pytest.raises(RuntimeError, match="https"):
        create_app()
