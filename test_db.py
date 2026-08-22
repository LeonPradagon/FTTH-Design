import asyncio
from backend.database import db
async def main():
    await db.connect()
    projects = await db.project.find_many()
    print("Projects:", len(projects))
    await db.disconnect()
asyncio.run(main())
