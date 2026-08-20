import os
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from backend.core.config import settings
from backend.database import db

security = HTTPBearer()

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    try:
        session = await db.session.find_first(
            where={"token": token},
            include={"user": True}
        )
        if not session:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Session")
        if not session.user:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Session")
            
        return {"id": session.user.id, "role": getattr(session.user, "role", "user"), "email": session.user.email}
    except Exception as db_err:
        if isinstance(db_err, HTTPException):
            raise
        print(f"DB Query Exception: {type(db_err).__name__}: {str(db_err)}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Database query failed: {str(db_err)}")
