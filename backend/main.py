from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
from contextlib import asynccontextmanager

from backend.api.routes import generation, projects, versions, audit
from backend.core.logging import logger
from backend.core.errors import FTTHError
from backend.core.response import error_response
from backend.database import db

import subprocess
import sys

worker_process = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global worker_process
    # Jalankan worker di background (lokal) saat uvicorn start
    worker_process = subprocess.Popen(
        [sys.executable, "-m", "arq", "backend.worker.WorkerSettings"],
        env=os.environ.copy()
    )
    logger.info("Local arq worker started.")
    
    await db.connect()
    yield
    await db.disconnect()
    
    if worker_process:
        worker_process.terminate()
        worker_process.wait()
        logger.info("Local arq worker terminated.")

os.makedirs("dashboard/public/data", exist_ok=True)

app = FastAPI(title="FTTH Design Generator API", lifespan=lifespan)


# ── Global exception handlers ──────────────────────────────────────


@app.exception_handler(FTTHError)
async def ftth_error_handler(request: Request, exc: FTTHError):
    """Translate any FTTHError subclass into the standard error envelope."""
    logger.warning(
        "FTTHError [%s] %s — %s", exc.code, exc.message, exc.details or ""
    )
    return error_response(
        code=exc.code,
        message=exc.message,
        details=exc.details if exc.details else None,
        http_status=exc.http_status,
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception):
    """Catch-all for unexpected exceptions — log full traceback."""
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return error_response(
        code="INTERNAL_ERROR",
        message="An unexpected error occurred.",
        http_status=500,
    )


# The Next.js proxy normally talks to this service server-to-server, but keep
# direct browser access safe for local tooling as well.  Production deployments
# should set CORS_ORIGINS to a comma-separated allow-list.
cors_origins = [origin.strip() for origin in os.getenv(
    "CORS_ORIGINS",
    "http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000,http://127.0.0.1:3001",
).split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files for frontend to fetch immediately
app.mount("/data", StaticFiles(directory="dashboard/public/data"), name="data")

# Include routers
app.include_router(projects.router)
app.include_router(generation.router)
app.include_router(versions.router)
app.include_router(audit.router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
