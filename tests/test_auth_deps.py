import asyncio
import hashlib
import hmac
import time

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from server.api.deps import get_generation_user, get_optional_user


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


def test_proxy_auth_rejects_auth_secret_when_dedicated_proxy_secret_is_set(monkeypatch):
    monkeypatch.setenv("BACKEND_PROXY_SECRET", "production-proxy-secret")
    monkeypatch.setenv("BETTER_AUTH_SECRET", "development-auth-secret")

    payload = f"user-2|{int(time.time())}|user|legacy@example.com"
    signature = hmac.new(
        b"development-auth-secret", payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    user = asyncio.run(get_optional_user(_request_with_proxy_auth(f"{payload}|{signature}")))

    assert user["id"] == "anonymous"


def test_generation_requires_authentication_even_when_legacy_flag_is_set(monkeypatch):
    monkeypatch.setenv("ALLOW_ANONYMOUS_GENERATION", "true")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(get_generation_user({"id": "anonymous", "role": "guest"}))

    assert exc.value.status_code == 401


def test_viewer_cannot_start_generation():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(get_generation_user({"id": "viewer-1", "role": "viewer"}))

    assert exc.value.status_code == 403


def test_unknown_role_cannot_start_generation():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(get_generation_user({"id": "guest-1", "role": "guest"}))

    assert exc.value.status_code == 403
