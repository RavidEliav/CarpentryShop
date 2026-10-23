"""Saved designs behind a secret link (/#d=<id>.<token>). There are no accounts: the token is the
only credential. It is shown once, stored only as a SHA-256 hash and compared in constant time.
Saves use optimistic concurrency: PUT names the revision it started from (If-Match) and gets 409
if someone saved in between."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import secrets
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.api.agent import error
from app.api.export import read_capped
from app.domain.apply import apply_ops
from app.domain.catalog import load_catalog
from app.domain.errors import DomainError
from app.domain.schema import SAFE_TEXT_PATTERN
from app.persistence.repository import StorageError, get_repository

router = APIRouter(prefix="/api")
logger = logging.getLogger(__name__)

# A maximal valid design is under 256 kB (see export.py).
MAX_BODY_BYTES = 300_000
# ASSUMPTION: a configurable default; the UI does not ask for a project name yet.
DEFAULT_NAME = "Wardrobe"
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")  # secrets.token_urlsafe(32): 256 bits
REVISION_PATTERN = re.compile(r"^[1-9][0-9]{0,8}$")  # ASCII only: str.isdigit() also accepts "²"
NO_STORE = {"Cache-Control": "no-store"}

MESSAGES = {
    "INVALID_REQUEST": {"he": "הבקשה אינה תקינה.", "en": "The request is not valid."},
    "TOO_LARGE": {"he": "העיצוב גדול מדי לשמירה.", "en": "The design is too large to save."},
    "NOT_FOUND": {"he": "לא מצאנו עיצוב בקישור הזה.", "en": "No design was found at this link."},
    "STALE": {"he": "העיצוב נשמר בינתיים ממקום אחר. טען את הקישור מחדש.",
              "en": "This design was saved elsewhere in the meantime. Reload the link."},
    "STORAGE_UNAVAILABLE": {"he": "שמירה עדיין לא זמינה בשרת הזה.", "en": "Saving is not available on this server."},
    "STORAGE_ERROR": {"he": "השמירה נכשלה. נסה שוב בעוד רגע.", "en": "Saving failed. Please try again in a moment."},
}


class SaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    design: dict
    name: Annotated[str, Field(min_length=1, max_length=60, pattern=SAFE_TEXT_PATTERN)] = DEFAULT_NAME
    language: Literal["he", "en"] = "he"


def _fail(status: int, code: str, language: str) -> JSONResponse:
    return error(status, code, MESSAGES[code][language])


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _token_from(request: Request) -> str | None:
    scheme, _, token = request.headers.get("Authorization", "").partition(" ")
    return token if scheme.lower() == "bearer" and TOKEN_PATTERN.fullmatch(token) else None


def _design_id(raw: str) -> str | None:
    try:
        return str(uuid.UUID(raw))
    except ValueError:
        return None


async def _parse_save(request: Request) -> SaveRequest | JSONResponse:
    """The parsed request, or an error response. The design is fully validated by the domain engine."""
    body = await read_capped(request, MAX_BODY_BYTES)
    if body is None:
        return _fail(413, "TOO_LARGE", "he")
    try:
        raw = json.loads(body)
    except (ValueError, RecursionError):
        raw = None
    language = raw["language"] if isinstance(raw, dict) and raw.get("language") in ("he", "en") else "he"
    try:
        parsed = SaveRequest.model_validate(raw)
    except ValidationError:
        return _fail(422, "INVALID_REQUEST", language)
    try:
        design = apply_ops(parsed.design, [], load_catalog())
    except DomainError as exc:
        return error(422, exc.code, exc.message, exc.path)
    return parsed.model_copy(update={"design": design})


@router.post("/designs", status_code=201)
async def create_design(request: Request):
    repository = get_repository()
    if repository is None:
        return _fail(503, "STORAGE_UNAVAILABLE", "he")
    parsed = await _parse_save(request)
    if isinstance(parsed, JSONResponse):
        return parsed
    token = secrets.token_urlsafe(32)
    try:
        design_id, revision = await run_in_threadpool(repository.create, _hash(token), parsed.name, parsed.design)
    except StorageError:
        logger.exception("Saving a new design failed")
        return _fail(503, "STORAGE_ERROR", parsed.language)
    data = {"designId": design_id, "accessToken": token, "revision": revision}
    return JSONResponse(status_code=201, content={"success": True, "data": data}, headers=NO_STORE)


@router.get("/designs/{raw_id}")
async def get_design(raw_id: str, request: Request, language: Literal["he", "en"] = "he"):
    repository = get_repository()
    if repository is None:
        return _fail(503, "STORAGE_UNAVAILABLE", language)
    design_id, token = _design_id(raw_id), _token_from(request)
    if design_id is None or token is None:
        return _fail(404, "NOT_FOUND", language)
    try:
        saved = await run_in_threadpool(repository.get, design_id)
    except StorageError:
        logger.exception("Loading a design failed")
        return _fail(503, "STORAGE_ERROR", language)
    # One answer for "no such design" and "wrong token", so a link can't be probed.
    if saved is None or not hmac.compare_digest(saved.token_hash, _hash(token)):
        return _fail(404, "NOT_FOUND", language)
    try:
        design = apply_ops(saved.design, [], load_catalog())  # the catalog may have changed since the save
    except DomainError as exc:
        return error(422, exc.code, exc.message, exc.path)
    data = {"designId": design_id, "name": saved.name, "design": design, "revision": saved.revision}
    return JSONResponse(content={"success": True, "data": data}, headers=NO_STORE)


@router.put("/designs/{raw_id}")
async def update_design(raw_id: str, request: Request):
    repository = get_repository()
    if repository is None:
        return _fail(503, "STORAGE_UNAVAILABLE", "he")
    # Cheap header checks first: an unauthenticated request never reaches the full design validation.
    design_id, token = _design_id(raw_id), _token_from(request)
    if design_id is None or token is None:
        return _fail(404, "NOT_FOUND", "he")
    expected = request.headers.get("If-Match", "").strip('" ')
    if not REVISION_PATTERN.fullmatch(expected):
        return _fail(422, "INVALID_REQUEST", "he")
    parsed = await _parse_save(request)
    if isinstance(parsed, JSONResponse):
        return parsed
    try:
        saved = await run_in_threadpool(repository.get, design_id)
        if saved is None or not hmac.compare_digest(saved.token_hash, _hash(token)):
            return _fail(404, "NOT_FOUND", parsed.language)
        revision = await run_in_threadpool(
            repository.update, design_id, saved.token_hash, int(expected), parsed.name, parsed.design,
        )
    except StorageError:
        logger.exception("Saving a design failed")
        return _fail(503, "STORAGE_ERROR", parsed.language)
    if revision is None:
        return _fail(409, "STALE", parsed.language)
    return JSONResponse(content={"success": True, "data": {"designId": design_id, "revision": revision}}, headers=NO_STORE)

