from app.services import tokens
from app.services.rate_limit import RateLimiter


def test_tokens_are_256_bit_urlsafe_and_unique():
    issued = {tokens.new_token() for _ in range(200)}
    assert len(issued) == 200
    assert all(tokens.is_well_formed(token) for token in issued)


def test_only_the_hash_is_needed_to_verify_a_token():
    token = tokens.new_token()
    stored = tokens.hash_token(token)
    assert stored != token
    assert len(stored) == 64
    assert tokens.matches(token, stored)
    assert not tokens.matches(tokens.new_token(), stored)


def test_malformed_tokens_are_rejected():
    for bad in ["", "short", "x" * 42, "x" * 44, "a" * 42 + "!", "a" * 42 + "\u05d0"]:
        assert not tokens.is_well_formed(bad)


def test_rate_limiter_allows_a_burst_then_recovers_after_the_window():
    now = [0.0]
    limiter = RateLimiter(2, 60, clock=lambda: now[0])
    assert limiter.allow() and limiter.allow()
    assert not limiter.allow()
    now[0] = 59.9
    assert not limiter.allow()
    now[0] = 60.0
    assert limiter.allow()
