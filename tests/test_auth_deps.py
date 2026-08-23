import asyncio
import hashlib
import hmac
import time

from starlette.requests import Request

from backend.api.deps import get_optional_user


def _request_with_proxy_auth(value: str | None) -> Request:
    headers = []
    if value is not None:
        headers.append((b"x-proxy-auth", value.encode("utf-8")))
    return Request({"type": "http", "headers": headers})


def test_proxy_auth_accepts_better_auth_secret_fallback(monkeypatch):
    monkeypatch.delenv("BACKEND_PROXY_SECRET", raising=False)
    monkeypatch.setenv("BETTER_AUTH_SECRET", "development-auth-secret")

    payload = f"user-1|{int(time.time())}|user|user@example.com"
    signature = hmac.new(
        b"development-auth-secret", payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    user = asyncio.run(get_optional_user(_request_with_proxy_auth(f"{payload}|{signature}")))

    assert user == {"id": "user-1", "role": "user", "email": "user@example.com"}


def test_proxy_auth_without_signature_is_anonymous(monkeypatch):
    monkeypatch.setenv("BACKEND_PROXY_SECRET", "proxy-secret")
    monkeypatch.setenv("BETTER_AUTH_SECRET", "auth-secret")

    user = asyncio.run(get_optional_user(_request_with_proxy_auth(None)))

    assert user["id"] == "anonymous"


def test_proxy_auth_accepts_mismatched_legacy_development_secret(monkeypatch):
    monkeypatch.setenv("BACKEND_PROXY_SECRET", "production-proxy-secret")
    monkeypatch.setenv("BETTER_AUTH_SECRET", "development-auth-secret")

    payload = f"user-2|{int(time.time())}|user|legacy@example.com"
    signature = hmac.new(
        b"development-auth-secret", payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    user = asyncio.run(get_optional_user(_request_with_proxy_auth(f"{payload}|{signature}")))

    assert user["id"] == "user-2"
