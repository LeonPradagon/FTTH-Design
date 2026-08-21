import asyncio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from server.api.routes import files, generation, projects
from server.core.paths import DATA_DIR
from server.database import db
from server.storage.dependencies import get_object_storage


@asynccontextmanager
async def lifespan(app: FastAPI):
    await asyncio.to_thread(get_object_storage().ensure_bucket)
    await db.connect()
    try:
        yield
    finally:
        await db.disconnect()


DATA_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="FTTH Design Generator API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # For development, allow all origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(files.router)
app.include_router(generation.router)
app.include_router(projects.router)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server.main:app", host="0.0.0.0", port=8000, reload=True)
