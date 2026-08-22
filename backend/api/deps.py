import os
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from backend.core.config import settings
from backend.database import db

from fastapi import Request

async def get_optional_user(request: Request):
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
