import os
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from backend.core.config import settings
from backend.database import db

security = HTTPBearer()

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    print(f"\n--- AUTH DEBUG START ---")
    print(f"RECEIVED TOKEN: '{token}'")
    try:
        # Try JWT decode first
        payload = jwt.decode(token, settings.better_auth_secret, algorithms=["HS256"])
        user_info = payload.get("user", payload)
        if "email" not in user_info:
            print("JWT decoded, but no email found in payload")
            raise ValueError("Invalid JWT Payload")
        print("AUTH SUCCESS VIA JWT")
        return {"id": user_info["id"], "role": user_info.get("role", "user"), "email": user_info["email"]}
        
    except jwt.ExpiredSignatureError:
        print("JWT Expired")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token Expired")
    except Exception as jwt_err:
        print(f"JWT Decode Failed: {type(jwt_err).__name__}: {str(jwt_err)}")
        # Fallback to Database Session (Opaque Token)
        try:
            print(f"Attempting DB fallback with token: '{token}'")
            session = await db.session.find_first(
                where={"token": token},
                include={"user": True}
            )
            if not session:
                print("DB Fallback Failed: Session not found in DB")
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Session")
            if not session.user:
                print("DB Fallback Failed: Session has no associated user")
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Session")
                
            print(f"AUTH SUCCESS VIA DB FALLBACK for user: {session.user.email}")
            return {"id": session.user.id, "role": getattr(session.user, "role", "user"), "email": session.user.email}
        except Exception as db_err:
            if isinstance(db_err, HTTPException):
                raise
            print(f"DB Query Exception: {type(db_err).__name__}: {str(db_err)}")
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Database fallback failed: {str(db_err)}")
