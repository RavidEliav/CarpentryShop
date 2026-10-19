"""The Supabase store against a mocked Data API (no network)."""

import json

import httpx2
import pytest

from app.persistence.repository import PersistenceError
from app.persistence.supabase_repo import COLUMNS, SupabaseDesignRepository, check_url

DESIGN_ID = "3f1c2b4a-1111-4222-8333-444455556666"
HASH = "b" * 64
SECRET = "sb_secret_test_value_123"
ROW = {"id": DESIGN_ID, "token_hash": HASH, "state": {"schemaVersion": 1}, "revision": 1}


class Recorder:
    """A transport handler that records requests and replays canned responses (or raises)."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request):
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def repo(recorder, key=SECRET):
    return SupabaseDesignRepository("https://proj.supabase.co/", key, transport=httpx2.MockTransport(recorder))


def test_create_inserts_and_returns_the_row():
    recorder = Recorder(httpx2.Response(201, json=[ROW]))
    row = repo(recorder).create(token_hash=HASH, state={"schemaVersion": 1}, schema_version=1)
    assert (row.id, row.revision, row.state) == (DESIGN_ID, 1, {"schemaVersion": 1})
    request = recorder.requests[0]
    assert request.method == "POST"
    assert str(request.url).startswith("https://proj.supabase.co/rest/v1/designs?")
    assert request.url.params["select"] == COLUMNS
    assert request.headers["Prefer"] == "return=representation"
    assert json.loads(request.content) == {"token_hash": HASH, "state": {"schemaVersion": 1}, "schema_version": 1}


def test_new_secret_keys_travel_only_in_the_apikey_header():
    recorder = Recorder(httpx2.Response(200, json=[]))
    repo(recorder).get(DESIGN_ID)
    headers = recorder.requests[0].headers
    assert headers["apikey"] == SECRET
    assert "authorization" not in headers


def test_a_legacy_service_role_jwt_is_also_the_bearer():
    recorder = Recorder(httpx2.Response(200, json=[]))
    repo(recorder, key="eyJhbGciOiJIUzI1NiJ9.legacy.jwt").get(DESIGN_ID)
    assert recorder.requests[0].headers["authorization"] == "Bearer eyJhbGciOiJIUzI1NiJ9.legacy.jwt"


def test_get_filters_by_canonical_id():
    recorder = Recorder(httpx2.Response(200, json=[ROW]), httpx2.Response(200, json=[]))
    store = repo(recorder)
    assert store.get(DESIGN_ID.upper()).id == DESIGN_ID
    assert store.get(DESIGN_ID) is None
    assert recorder.requests[0].url.params["id"] == f"eq.{DESIGN_ID}"


def test_ids_that_are_not_uuids_never_reach_the_data_api():
    recorder = Recorder()
    store = repo(recorder)
    for bad in ["not-a-uuid", f"{DESIGN_ID},or(id.neq.0)", ""]:
        assert store.get(bad) is None
        assert store.update(bad, expected_revision=1, state={}, schema_version=1) is None
    assert recorder.requests == []


def test_update_is_a_conditional_patch():
    recorder = Recorder(httpx2.Response(200, json=[{"revision": 4}]), httpx2.Response(200, json=[]))
    store = repo(recorder)
    assert store.update(DESIGN_ID, expected_revision=3, state={"x": 1}, schema_version=1) == 4
    assert store.update(DESIGN_ID, expected_revision=3, state={"x": 1}, schema_version=1) is None
    request = recorder.requests[0]
    assert request.method == "PATCH"
    assert request.url.params["id"] == f"eq.{DESIGN_ID}"
    assert request.url.params["revision"] == "eq.3"
    body = json.loads(request.content)
    assert body["revision"] == 4 and body["state"] == {"x": 1} and body["updated_at"]


@pytest.mark.parametrize("response", [
    httpx2.Response(500, json={"message": "boom"}),
    httpx2.Response(401, json={"message": "Invalid API key"}),
    httpx2.Response(200, content=b"<html>not json</html>"),
    httpx2.Response(200, json={"not": "a list"}),
    httpx2.Response(200, json=[{"id": DESIGN_ID, "token_hash": HASH, "state": "text", "revision": 1}]),
    httpx2.ConnectError("connection refused"),
])
def test_store_failures_become_persistence_errors_without_leaking_the_key(response, caplog):
    with pytest.raises(PersistenceError):
        repo(Recorder(response)).get(DESIGN_ID)
    assert SECRET not in caplog.text


def test_unexpected_row_shapes_are_persistence_errors():
    with pytest.raises(PersistenceError):
        repo(Recorder(httpx2.Response(201, json=[]))).create(token_hash=HASH, state={}, schema_version=1)
    with pytest.raises(PersistenceError):
        repo(Recorder(httpx2.Response(200, json=["not a row"]))).get(DESIGN_ID)
    with pytest.raises(PersistenceError):
        repo(Recorder(httpx2.Response(200, json=[{"revision": "4"}]))).update(
            DESIGN_ID, expected_revision=3, state={}, schema_version=1
        )


def test_the_url_must_be_https_unless_it_is_a_local_stack():
    assert check_url("https://proj.supabase.co/") == "https://proj.supabase.co"
    assert check_url("http://127.0.0.1:54321") == "http://127.0.0.1:54321"
    for bad in [
        "http://proj.supabase.co", "ftp://x", "proj.supabase.co", "http://localhost.evil.com",
        "http://localhost:1@evil.com", "https://user:pass@proj.supabase.co", "https://",
    ]:
        with pytest.raises(RuntimeError):
            check_url(bad)
