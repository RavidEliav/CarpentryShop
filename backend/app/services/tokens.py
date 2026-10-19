"""Share-link access tokens. A token is 256 random bits, shown to the customer once, stored only as
its SHA-256 hash, and checked in constant time. The design id alone grants nothing."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets

TOKEN_BYTES = 32
# secrets.token_urlsafe(32) is always 43 base64url characters.
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")


def new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def is_well_formed(token: str) -> bool:
    return TOKEN_PATTERN.fullmatch(token) is not None


def matches(token: str, stored_hash: str) -> bool:
    return hmac.compare_digest(hash_token(token).encode(), stored_hash.encode())
