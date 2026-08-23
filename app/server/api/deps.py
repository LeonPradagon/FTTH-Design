import os
import hmac
import hashlib
import time
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from server.core.config import settings
from server.database import db

from fastapi import Request

async def get_optional_user(request: Request):
    # The dedicated proxy secret is preferred.  BETTER_AUTH_SECRET is kept as
    # a development fallback because the local dashboard environment already
    # contains the shared Better Auth secret while older installations did not
    # yet define BACKEND_PROXY_SECRET on the frontend.
    dedicated_secret = os.getenv("BACKEND_PROXY_SECRET")
    fallback_secret = os.getenv("BETTER_AUTH_SECRET")
    proxy_secrets = [dedicated_secret or fallback_secret] if dedicated_secret or fallback_secret else []
    proxy_auth = request.headers.get("x-proxy-auth")
    if proxy_secrets:
        if not proxy_auth:
            return {"id": "anonymous", "role": "guest", "email": ""}
        try:
            user_id, timestamp, role, email, signature = proxy_auth.split("|", 4)
            payload = "|".join((user_id, timestamp, role, email))
            if abs(time.time() - int(timestamp)) > 60:
                return {"id": "anonymous", "role": "guest", "email": ""}
            valid_signature = any(
                hmac.compare_digest(
                    signature,
                    hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest(),
                )
                for secret in proxy_secrets
            )
            if not valid_signature:
                return {"id": "anonymous", "role": "guest", "email": ""}
            return {"id": user_id, "role": role or "user", "email": email}
        except (ValueError, TypeError):
            return {"id": "anonymous", "role": "guest", "email": ""}

    user_id = request.headers.get("x-user-id")
    if not user_id:
        return {"id": "anonymous", "role": "guest", "email": ""}

    return {
        "id": user_id,
        "role": request.headers.get("x-user-role", "user"),
        "email": request.headers.get("x-user-email", "")
    }

async def get_current_user(user: dict = Depends(get_optional_user)):
    if user["id"] == "anonymous":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return user


async def get_generation_user(user: dict = Depends(get_optional_user)):
    """Require an authenticated role that may change generation data."""
    if user["id"] == "anonymous":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    if user.get("role") not in {"admin", "engineer", "user"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Generation access is not allowed")
    return user


async def get_admin_user(user: dict = Depends(get_current_user)):
    """Require the administrator role for destructive or privileged actions."""
    if user.get("role") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access is required")
    return user
