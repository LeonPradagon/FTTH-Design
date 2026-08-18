from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os

from backend.api.routes import generation
from backend.core.logging import logger

os.makedirs("dashboard/public/data", exist_ok=True)

app = FastAPI(title="FTTH Design API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # For development, allow all origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files for frontend to fetch immediately
app.mount("/data", StaticFiles(directory="dashboard/public/data"), name="data")

# Include routers
app.include_router(generation.router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
