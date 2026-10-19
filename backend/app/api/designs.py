"""Saved designs behind private links (Phase 7).

A link is `/#d=<uuid>.<token>`. The uuid finds the row; the 256-bit token, stored only as a SHA-256
hash, is what grants access, so a wrong token and an unknown design look the same (404). Every save is
validated by the domain engine, and saving changes is optimistic: `If-Match: "<revision>"` must still
be the stored revision, otherwise 409."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from functools import lru_cache
from typing import Annotated, TypeVar

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, ValidationError

from app.api.agent import error
from app.config import Settings, get_settings
from app.domain.apply import apply_ops
from app.domain.catalog import load_catalog
from app.domain.errors import DomainError
from app.persistence import repository_for
from app.persistence.repository import DesignRepository, PersistenceError, StoredDesign
from app.services import tokens
from app.services.rate_limit import RateLimiter

router = APIRouter(prefix="/api/designs")

# A valid design is far smaller (the schema caps every list); the cap stops oversized bodies early.
MAX_BODY_BYTES = 256_000
# ASSUMPTION: a flood guard for the shared database, per server process (not a per-customer quota).
MAX_CREATES_PER_MINUTE = 30
DESIGN_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
BEARER = re.compile(r"Bearer ([A-Za-z0-9_-]{43})")
IF_MATCH = re.compile(r'"?([1-9][0-9]{0,8})"?')

MESSAGES = {
    "PERSISTENCE_UNAVAILABLE": "Saving is not available on this server.",
    "STORE_ERROR": "Saving is temporarily unavailable. Please try again in a moment.",
    "TOO_LARGE": "This design is too large to save.",
    "INVALID_REQUEST": 'The request body must be JSON in the form {"design": {...}}.',
    "RATE_LIMITED": "Too many designs are being saved right now. Please try again in a minute.",
    "UNAUTHORIZED": "This design link is missing its access key.",
    "NOT_FOUND": "This design link is not valid, or the design no longer exists.",
    "REVISION_REQUIRED": 'Saving changes needs the revision you started from (If-Match: "<revision>").',
    "CONFLICT": "This design was changed somewhere else after you opened it.",
    "STORED_DESIGN_INVALID": "This saved design can no longer be opened by this version of the designer.",
}

_TOO_LARGE = object()
_NOT_JSON = object()
T = TypeVar("T")


class SaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    design: dict


class _Reject(Exception):
    def __init__(
        self, status: int, code: str, headers: dict[str, str] | None = None, *,
        message: str | None = None, path: str | None = None,
    ) -> None:
        super().__init__(code)
        self.response = error(status, code, message or MESSAGES[code], path)
        self.response.headers.update(headers or {})


async def json_body(request: Request) -> object:
    """The parsed JSON body, or a marker when it is too large or is not JSON."""
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            return _TOO_LARGE
        chunks.append(chunk)
    try:
        return json.loads(b"".join(chunks))
    except (ValueError, RecursionError):
        return _NOT_JSON


def get_repository(settings: Annotated[Settings, Depends(get_settings)]) -> DesignRepository | None:
    return repository_for(settings)


@lru_cache
def get_create_limiter() -> RateLimiter:
    return RateLimiter(MAX_CREATES_PER_MINUTE, 60)


Body = Annotated[object, Depends(json_body)]
Repository = Annotated[DesignRepository | None, Depends(get_repository)]
AuthorizationHeader = Annotated[str | None, Header()]


@router.post("")
def create_design(body: Body, repo: Repository, limiter: Annotated[RateLimiter, Depends(get_create_limiter)]):
    try:
        store = _available(repo)
        design = _validated(body)
        if not limiter.allow():
            raise _Reject(429, "RATE_LIMITED", {"Retry-After": "60"})
        token = tokens.new_token()
        row = _call(store.create, token_hash=tokens.hash_token(token), state=design, schema_version=design["schemaVersion"])
    except _Reject as reject:
        return reject.response
    return _ok({"designId": row.id, "accessToken": token, "revision": row.revision}, row.revision, status=201)


@router.get("/{design_id}")
def open_design(design_id: str, repo: Repository, authorization: AuthorizationHeader = None):
    try:
        store = _available(repo)
        row = _authorized(store, design_id, _bearer(authorization))
        design = _still_valid(row)
    except _Reject as reject:
        return reject.response
    return _ok({"design": design, "revision": row.revision}, row.revision)


@router.put("/{design_id}")
def save_design(
    design_id: str, body: Body, repo: Repository,
    authorization: AuthorizationHeader = None, if_match: Annotated[str | None, Header()] = None,
):
    try:
        store = _available(repo)
        token = _bearer(authorization)
        expected = _expected_revision(if_match)
        design = _validated(body)
        row = _authorized(store, design_id, token)
        if row.revision != expected:
            raise _Reject(409, "CONFLICT")
        revision = _call(
            store.update, row.id, expected_revision=expected, state=design, schema_version=design["schemaVersion"]
        )
        if revision is None:  # another save won the race between the read and this write
            raise _Reject(409, "CONFLICT")
    except _Reject as reject:
        return reject.response
    return _ok({"revision": revision}, revision)


def _available(repo: DesignRepository | None) -> DesignRepository:
    if repo is None:
        raise _Reject(503, "PERSISTENCE_UNAVAILABLE")
    return repo


def _validated(body: object) -> dict:
    """Parse and fully validate the design (no ops), exactly as the engine does for every edit."""
    if body is _TOO_LARGE:
        raise _Reject(413, "TOO_LARGE")
    if body is _NOT_JSON:
        raise _Reject(422, "INVALID_REQUEST")
    try:
        request = SaveRequest.model_validate(body)
    except ValidationError:
        raise _Reject(422, "INVALID_REQUEST") from None
    try:
        return apply_ops(request.design, [], load_catalog())
    except DomainError as exc:
        raise _Reject(422, exc.code, message=exc.message, path=exc.path) from None


def _bearer(authorization: str | None) -> str:
    match = BEARER.fullmatch(authorization or "")
    if match is None:
        raise _Reject(401, "UNAUTHORIZED", {"WWW-Authenticate": "Bearer"})
    return match.group(1)


def _expected_revision(if_match: str | None) -> int:
    match = IF_MATCH.fullmatch((if_match or "").strip())
    if match is None:
        raise _Reject(428, "REVISION_REQUIRED")
    return int(match.group(1))


def _authorized(store: DesignRepository, design_id: str, token: str) -> StoredDesign:
    if DESIGN_ID.fullmatch(design_id) is None:
        raise _Reject(404, "NOT_FOUND")
    row = _call(store.get, design_id)
    if row is None or not tokens.matches(token, row.token_hash):
        raise _Reject(404, "NOT_FOUND")
    return row


def _still_valid(row: StoredDesign) -> dict:
    try:
        return apply_ops(row.state, [], load_catalog())
    except DomainError:
        raise _Reject(422, "STORED_DESIGN_INVALID") from None


def _call(operation: Callable[..., T], *args, **kwargs) -> T:
    try:
        return operation(*args, **kwargs)
    except PersistenceError:
        raise _Reject(503, "STORE_ERROR") from None


def _ok(data: dict, revision: int, status: int = 200) -> JSONResponse:
    # Responses carry the access token or a private design: never cache them.
    headers = {"Cache-Control": "no-store", "ETag": f'"{revision}"'}
    return JSONResponse(status_code=status, content={"success": True, "data": data}, headers=headers)
