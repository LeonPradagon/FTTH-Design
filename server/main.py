from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
from contextlib import asynccontextmanager

from server.api.routes import generation, projects
from server.core.logging import logger
from server.core.paths import DATA_DIR
from server.database import db

@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    yield
    await db.disconnect()

DATA_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="FTTH Design Generator API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # For development, allow all origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files for frontend to fetch immediately
app.mount("/data", StaticFiles(directory=str(DATA_DIR)), name="data")

# Include routers
app.include_router(generation.router)
app.include_router(projects.router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server.main:app", host="0.0.0.0", port=8000, reload=True)
