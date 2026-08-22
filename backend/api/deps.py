import os
import hmac
import hashlib
import time
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from backend.core.config import settings
from backend.database import db

from fastapi import Request

async def get_optional_user(request: Request):
    proxy_secret = os.getenv("BACKEND_PROXY_SECRET")
    proxy_auth = request.headers.get("x-proxy-auth")
    if proxy_secret:
        if not proxy_auth:
            return {"id": "anonymous", "role": "guest", "email": ""}
        try:
            user_id, timestamp, role, email, signature = proxy_auth.split("|", 4)
            payload = "|".join((user_id, timestamp, role, email))
            expected = hmac.new(proxy_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
            if abs(time.time() - int(timestamp)) > 60 or not hmac.compare_digest(signature, expected):
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
    """Require authenticated identity for generation in production."""
    if os.getenv("REQUIRE_AUTH", "false").lower() == "true" and user["id"] == "anonymous":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return user
