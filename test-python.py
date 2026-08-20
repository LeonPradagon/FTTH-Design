import asyncio
from backend.database import db
from backend.api.deps import get_current_user
from fastapi.security import HTTPAuthorizationCredentials

async def test():
    await db.connect()
    try:
        cred = HTTPAuthorizationCredentials(scheme="Bearer", credentials="jfRpfSXl2JYn3IEpYlv9uJS132Omh3vC")
        user = await get_current_user(cred)
        print("User:", user)
        
        where_clause = {}
        if user.get("role") != "admin":
            where_clause = {"userId": user["id"]}
            
        projects = await db.project.find_many(
            where=where_clause,
            skip=0,
            take=100,
            order={"updated_at": "desc"}
        )
        print("Projects:", projects)
    except Exception as e:
        print("Error:", e)
    finally:
        await db.disconnect()

if __name__ == "__main__":
    asyncio.run(test())
