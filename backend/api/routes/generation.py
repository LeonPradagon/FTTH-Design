"""FTTH Design Generator — generation API endpoints.

All endpoints return the standard response envelope:
``{"success": true/false, "data": {...}, "meta": {...}, "error": {...}}``.
"""

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, BackgroundTasks
from fastapi.responses import FileResponse, StreamingResponse, RedirectResponse
import os
import shutil
import asyncio
import json
import mimetypes
from typing import Optional

from arq import create_pool
from arq.connections import RedisSettings

from backend.core.logging import logger
from backend.core.errors import (
    FTTHError,
    InvalidFileError,
    ExportFailedError,
    DesignStateNotFoundError,
)
from backend.core.response import success_response
from backend.api.deps import get_current_user, get_optional_user
from backend.services.user_storage import (
    create_user_filename,
    get_user_cache_dir,
    get_user_storage_dir,
    resolve_user_file,
    user_file_url,
    upload_file,
    get_presigned_url,
)

from backend.services.generator.generation_config import GenerationConfig
from backend.services.generator.progress import progress_manager
from backend.services.generator.core_logic import cleanup_old_files, _parse_config_from_form

router = APIRouter()

redis_pool = None

async def get_redis_pool():
    global redis_pool
    if redis_pool is None:
        redis_pool = await create_pool(RedisSettings.from_dsn(os.getenv("REDIS_URL", "redis://localhost:6379/0")))
    return redis_pool


@router.post("/generate")
async def generate_design(
    boundaryFile: Optional[UploadFile] = File(None),
    popFile: Optional[UploadFile] = File(None),
    config: Optional[str] = Form(None),
    job_id: Optional[str] = Form(None),
    project_id: Optional[str] = Form(None),
    current_user: dict = Depends(get_optional_user),
):
    """Generate a full FTTH network design asynchronously."""
    if not job_id:
        import uuid
        job_id = str(uuid.uuid4())
        
    progress_manager.create_job(job_id)
        
    try:
        user_dir = get_user_cache_dir(current_user["id"])
        cleanup_old_files(user_dir)
    
        if not boundaryFile or not boundaryFile.filename:
            raise InvalidFileError(message="Boundary KML/KMZ wajib diunggah.")
    
        gen_config = _parse_config_from_form(config)
    
        boundary_path = user_dir / create_user_filename("boundary", "kml")
        pop_path = None
        has_custom_pop = False
    
        with open(boundary_path, "wb") as buffer:
            shutil.copyfileobj(boundaryFile.file, buffer)
        # Upload input to MinIO
        upload_file(current_user["id"], boundary_path.name, boundary_path)
    
        if popFile and popFile.filename:
            pop_path = user_dir / create_user_filename("pop", "kml")
            with open(pop_path, "wb") as buffer:
                shutil.copyfileobj(popFile.file, buffer)
            # Upload input to MinIO
            upload_file(current_user["id"], pop_path.name, pop_path)
            has_custom_pop = True
    
        output_kmz_name = create_user_filename("design_ftth", "kmz")
        output_kml_name = create_user_filename("design_ftth", "kml")
        output_csv_name = create_user_filename("design_ftth", "csv")
        
        output_kmz_path = user_dir / output_kmz_name
        output_csv_path = user_dir / output_csv_name
    
        logger.info(f"Enqueuing generate_task for job {job_id}")
        pool = await get_redis_pool()
        await pool.enqueue_job(
            "generate_task",
            str(boundary_path),
            str(pop_path) if pop_path else None,
            str(output_kmz_path),
            str(output_csv_path),
            has_custom_pop,
            str(user_dir),
            gen_config.model_dump(),
            job_id,
            project_id,
            current_user["id"],
            output_kml_name,
            output_kmz_name,
            output_csv_name,
            _job_id=job_id
        )
    
        return success_response(
            data={
                "message": "Generation job accepted.",
                "job_id": job_id,
            }
        )
    except Exception as e:
        progress_manager.error(job_id, str(e))
        raise

@router.get("/generate/progress/{job_id}")
async def generate_progress(job_id: str):
    """Server-Sent Events endpoint for generation progress."""
    async def event_stream():
        last_data = None
        missing_attempts = 0
        while True:
            data = progress_manager.get_status(job_id)
            if not data:
                # A client can connect just before the POST handler has created
                # the Redis state (for example after network/proxy reordering).
                # Wait briefly instead of treating that transient state as a
                # permanently invalid job.
                missing_attempts += 1
                if missing_attempts >= 20:
                    yield f"data: {json.dumps({'error': 'Job not found'})}\n\n"
                    break
                await asyncio.sleep(0.5)
                continue

            missing_attempts = 0
                
            if data != last_data:
                yield f"data: {json.dumps(data)}\n\n"
                last_data = data.copy()
                
            if data.get("done"):
                await asyncio.sleep(1)
                break

            # Keep the SSE connection active while a long export is running.
            # The browser ignores comment frames, but proxies see traffic.
            yield ": keep-alive\n\n"
            await asyncio.sleep(0.5)
            
    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/regenerate-cables")
async def regenerate_cables(
    job_id: Optional[str] = Form(None),
    current_user: dict = Depends(get_optional_user)
):
    if not job_id:
        import uuid
        job_id = str(uuid.uuid4())
    progress_manager.create_job(job_id)

    try:
        user_dir = get_user_cache_dir(current_user["id"])
        cleanup_old_files(user_dir)
        output_kmz_name = create_user_filename("design_ftth_regen", "kmz")
        output_kml_name = create_user_filename("design_ftth_regen", "kml")
        output_csv_name = create_user_filename("design_ftth_regen", "csv")
        output_kmz_path = user_dir / output_kmz_name
        output_csv_path = user_dir / output_csv_name

        pool = await get_redis_pool()
        await pool.enqueue_job(
            "regenerate_cables_task",
            str(output_kmz_path),
            True,
            str(output_csv_path),
            str(user_dir),
            job_id,
            current_user["id"],
            _job_id=job_id
        )

        return success_response(
            data={
                "message": "Regenerate cables job accepted.",
                "job_id": job_id,
                "url": user_file_url(output_kml_name),
                "kmz_url": user_file_url(output_kmz_name),
                "csv_url": user_file_url(output_csv_name),
            },
        )
    except Exception as e:
        progress_manager.error(job_id, str(e))
        raise


@router.post("/generate-custom")
async def generate_custom(
    customFile: UploadFile = File(...),
    job_id: Optional[str] = Form(None),
    current_user: dict = Depends(get_optional_user),
):
    if not job_id:
        import uuid
        job_id = str(uuid.uuid4())
    progress_manager.create_job(job_id)

    try:
        user_dir = get_user_cache_dir(current_user["id"])
        cleanup_old_files(user_dir)
        custom_path = user_dir / create_user_filename("custom_mapping", "kml")
        output_kmz_name = create_user_filename("design_ftth_custom", "kmz")
        output_kml_name = create_user_filename("design_ftth_custom", "kml")
        output_csv_name = create_user_filename("design_ftth_custom", "csv")
        output_kmz_path = user_dir / output_kmz_name
        output_csv_path = user_dir / output_csv_name

        with open(custom_path, "wb") as buffer:
            shutil.copyfileobj(customFile.file, buffer)
        # Upload input to MinIO
        upload_file(current_user["id"], custom_path.name, custom_path)

        pool = await get_redis_pool()
        await pool.enqueue_job(
            "generate_custom_task",
            str(custom_path),
            str(output_kmz_path),
            True,
            str(output_csv_path),
            str(user_dir),
            job_id,
            current_user["id"],
            _job_id=job_id
        )

        return success_response(
            data={
                "message": "Custom generation job accepted.",
                "job_id": job_id,
                "url": user_file_url(output_kml_name),
                "kmz_url": user_file_url(output_kmz_name),
                "csv_url": user_file_url(output_csv_name),
            },
        )
    except Exception as e:
        progress_manager.error(job_id, str(e))
        raise


@router.get("/api/files/{filename}")
async def get_user_file(
    filename: str, current_user: dict = Depends(get_optional_user)
):
    """Serve presigned URL for MinIO object."""
    try:
        url = get_presigned_url(current_user["id"], filename)
        return RedirectResponse(url=url)
    except Exception as e:
        raise InvalidFileError(message=f"File not found or storage error: {e}")
