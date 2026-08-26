"""FTTH Design Generator — generation API endpoints.

All endpoints return the standard response envelope:
``{"success": true/false, "data": {...}, "meta": {...}, "error": {...}}``.
"""

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse
import os
import shutil
import asyncio
import json
import re
import uuid
from typing import Optional
from pathlib import Path

from arq import create_pool
from arq.connections import RedisSettings
from arq.jobs import Job

from server.core.logging import logger
from server.core.errors import (
    InvalidFileError,
    DesignStateNotFoundError,
)
from server.core.response import success_response
from server.api.deps import get_current_user, get_generation_user
from server.database import db
from server.services.user_storage import (
    create_user_filename,
    get_user_cache_dir,
    user_file_url,
    upload_file,
    get_generation_cache_dir,
)

from server.services.generator.generation_config import GenerationConfig
from server.services.generator.progress import progress_manager
from server.services.generator.core_logic import (
    cleanup_old_files,
    _parse_config_from_form,
    load_network_state,
)
from server.services.generator.kml_parser import read_boundary, read_points
from shapely.geometry import Point

router = APIRouter()


async def _require_project_access(project_id: str | None, current_user: dict) -> None:
    if not project_id:
        return
    project = await db.project.find_unique(where={"id": project_id})
    if not project:
        raise HTTPException(status_code=404, detail="Project tidak ditemukan.")
    if current_user.get("role") != "admin" and project.userId != current_user["id"]:
        raise HTTPException(status_code=403, detail="Project tidak dapat diakses.")


async def _enqueue_generation_job(
    function: str,
    *,
    job_id: str,
    user_id: str,
    project_id: str | None = None,
    batch_id: str | None = None,
    item_id: str | None = None,
    **arguments,
) -> None:
    await db.generationjob.create(
        data={
            "id": job_id,
            "userId": user_id,
            "projectId": project_id,
            "batchId": batch_id,
            "itemId": item_id,
            "status": "QUEUED",
            "stage": "QUEUED",
            "progress": 1,
        }
    )
    try:
        if not progress_manager.get_status(job_id):
            progress_manager.create_job(job_id, user_id=user_id, batch_id=batch_id)
            progress_manager.update(job_id, "QUEUED", "Menunggu worker memproses job...", 1)
        pool = await get_redis_pool()
        arguments.update(job_id=job_id, user_id=user_id)
        if function == "generate_task":
            arguments.update(project_id=project_id, batch_id=batch_id)
        await pool.enqueue_job(
            function,
            **arguments,
            _job_id=job_id,
        )
    except Exception as exc:
        progress_manager.error(job_id, str(exc))
        await db.generationjob.update(
            where={"id": job_id},
            data={"status": "FAILED", "stage": "QUEUE_ERROR", "progress": 100, "error": str(exc)},
        )
        raise


def _batch_slug(filename: str) -> str:
    stem = Path(filename).stem.lower()
    stem = re.sub(r"(boundary|pop|olt|polygon|point)", " ", stem)
    stem = re.sub(r"[^a-z0-9]+", "-", stem).strip("-")
    return stem or "design"


def _parse_feature_colors_from_form(colors_json: Optional[str]) -> dict:
    """Parse the current UI colors passed along with an export request."""
    if not colors_json:
        return {}
    try:
        colors = json.loads(colors_json)
    except json.JSONDecodeError as exc:
        raise InvalidFileError(
            message=f"Invalid feature colors JSON: {exc}",
            details={"raw": colors_json[:200]},
        ) from exc
    return colors if isinstance(colors, dict) else {}


def _is_boundary_file(filename: str) -> bool:
    lowered = filename.lower()
    return not _is_pop_file(filename) and any(token in lowered for token in ("boundary", "polygon", "area"))


def _is_pop_file(filename: str) -> bool:
    return any(token in filename.lower() for token in ("pop", "olt", "sentral"))


def _can_access_job(state: dict, current_user: dict) -> bool:
    return (
        current_user.get("role") == "admin"
        or state.get("user_id") == current_user["id"]
    )


async def _get_job_state(job_id: str) -> dict | None:
    state = progress_manager.get_status(job_id)
    if state and state.get("user_id"):
        return state
    job = await db.generationjob.find_unique(where={"id": job_id})
    if not job:
        return state
    if state:
        state["user_id"] = job.userId
        if job.batchId:
            state["batch_id"] = job.batchId
        return state
    state = {
        "user_id": job.userId,
        "stage": job.stage or job.status,
        "message": job.error or job.status,
        "percent": job.progress,
        "done": job.status in {"COMPLETED", "FAILED", "CANCELED"},
    }
    if job.batchId:
        state["batch_id"] = job.batchId
    if job.result is not None:
        state["result"] = job.result
    return state


def _resolve_homepass_cache_dir(
    user_id: str,
    project_id: Optional[str],
    batch_id: Optional[str],
    item_id: Optional[str],
) -> Path:
    """Find the Network Core cache that belongs to this generation scope.

    A single design can finish before the asynchronous project auto-save has
    created a project ID. In that case the core is stored under the default
    project scope, while Homepass may already send the newly-created project
    ID. Try the exact project scope first, then the equivalent default scope
    without crossing the user's cache namespace.
    """
    candidates = [
        get_generation_cache_dir(user_id, project_id, batch_id, item_id),
    ]
    if project_id:
        candidates.append(get_generation_cache_dir(user_id, None, batch_id, item_id))

    last_error = None
    for index, candidate in enumerate(candidates):
        state_path = candidate / "design_state.json"
        try:
            load_network_state(cache_dir=candidate)
            return candidate
        except DesignStateNotFoundError as exc:
            last_error = exc
            # Do not hide a corrupt/incomplete project-specific cache by
            # silently switching to an older unrelated design. Fallback is
            # only for a scope whose state file does not exist.
            if index == 0 and state_path.exists():
                raise

    if last_error:
        raise last_error
    raise DesignStateNotFoundError(
        message="Cache Network Core belum tersedia. Jalankan Generate Design terlebih dahulu.",
    )

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
    mode: Optional[str] = Form(None),
    feature_colors: Optional[str] = Form(None),
    job_id: Optional[str] = Form(None),
    project_id: Optional[str] = Form(None),
    current_user: dict = Depends(get_generation_user),
):
    """Generate a full FTTH network design asynchronously."""
    if not job_id:
        import uuid
        job_id = str(uuid.uuid4())

    progress_manager.create_job(job_id, user_id=current_user["id"])

    try:
        await _require_project_access(project_id, current_user)
        user_dir = get_generation_cache_dir(current_user["id"], project_id)
        cleanup_old_files(user_dir)

        if not boundaryFile or not boundaryFile.filename:
            raise InvalidFileError(message="Boundary KML/KMZ wajib diunggah.")

        gen_config = _parse_config_from_form(config)
        parsed_feature_colors = _parse_feature_colors_from_form(feature_colors)
        # Existing API clients that omit mode keep the legacy full-export
        # behaviour. The dashboard explicitly sends CORE.
        effective_mode = (mode or ("FULL" if gen_config.include_homepass else "CORE")).upper()
        if effective_mode == "CORE":
            gen_config = gen_config.model_copy(update={"include_homepass": False})

        boundary_path = user_dir / create_user_filename("boundary", "kml")
        pop_path = None
        has_custom_pop = False

        with open(boundary_path, "wb") as buffer:
            shutil.copyfileobj(boundaryFile.file, buffer)
        upload_file(current_user["id"], boundary_path.name, boundary_path)

        if popFile and popFile.filename:
            pop_path = user_dir / create_user_filename("pop", "kml")
            with open(pop_path, "wb") as buffer:
                shutil.copyfileobj(popFile.file, buffer)
            upload_file(current_user["id"], pop_path.name, pop_path)
            has_custom_pop = True

        output_kmz_name = create_user_filename("design_ftth", "kmz")
        output_kml_name = create_user_filename("design_ftth", "kml")
        output_csv_name = create_user_filename("design_ftth", "csv")

        output_kmz_path = user_dir / output_kmz_name
        output_csv_path = user_dir / output_csv_name

        logger.info(f"Enqueuing generate_task for job {job_id}")
        progress_manager.update(job_id, "QUEUED", "Menunggu worker memproses job...", 1)
        await _enqueue_generation_job(
            "generate_task",
            job_id=job_id,
            user_id=current_user["id"],
            project_id=project_id,
            boundary_path=str(boundary_path),
            pop_path=str(pop_path) if pop_path else None,
            output_kmz_path=str(output_kmz_path),
            output_csv_path=str(output_csv_path),
            has_custom_pop=has_custom_pop,
            cache_dir=str(user_dir),
            gen_config_dict=gen_config.model_dump(),
            output_kml_name=output_kml_name,
            output_kmz_name=output_kmz_name,
            output_csv_name=output_csv_name,
            feature_colors=parsed_feature_colors,
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


@router.post("/generate/batch")
async def generate_batch(
    files: list[UploadFile] = File(...),
    project_id: Optional[str] = Form(None),
    config: Optional[str] = Form(None),
    force_refresh: bool = Form(False),
    feature_colors: Optional[str] = Form(None),
    current_user: dict = Depends(get_generation_user),
):
    """Create one isolated generation job per boundary/POP pair."""
    if not files:
        raise InvalidFileError(message="Minimal satu file boundary wajib diunggah.")
    max_files = int(os.getenv("MAX_BATCH_FILES", "100"))
    max_file_bytes = int(os.getenv("MAX_BATCH_FILE_BYTES", str(50 * 1024 * 1024)))
    if len(files) > max_files:
        raise HTTPException(status_code=413, detail=f"Maksimal {max_files} file per batch.")
    await _require_project_access(project_id, current_user)

    parsed_config = _parse_config_from_form(config)
    parsed_feature_colors = _parse_feature_colors_from_form(feature_colors)
    gen_config = parsed_config.model_copy(update={
        "include_homepass": False,
        "force_refresh_osm": force_refresh or parsed_config.force_refresh_osm,
    })
    batch_id = str(uuid.uuid4())
    batch_root = get_generation_cache_dir(current_user["id"], project_id, batch_id)
    input_dir = batch_root / "input"
    input_dir.mkdir(parents=True, exist_ok=True)
    saved_files: list[tuple[str, Path]] = []
    for upload in files:
        filename = Path(upload.filename or "upload.kml").name
        destination = input_dir / f"{uuid.uuid4().hex[:10]}_{filename}"
        with open(destination, "wb") as output:
            shutil.copyfileobj(upload.file, output)
        if destination.stat().st_size > max_file_bytes:
            destination.unlink(missing_ok=True)
            raise HTTPException(status_code=413, detail=f"Ukuran file maksimal {max_file_bytes // (1024 * 1024)} MB.")
        upload_file(current_user["id"], destination.name, destination)
        saved_files.append((filename, destination))

    boundary_files = [(name, path) for name, path in saved_files if _is_boundary_file(name)]
    pop_files = [(name, path) for name, path in saved_files if _is_pop_file(name)]
    classified_paths = {path for _, path in boundary_files + pop_files}
    for name, path in saved_files:
        if path in classified_paths:
            continue
        try:
            read_boundary(str(path))
            boundary_files.append((name, path))
            continue
        except Exception:
            pass
        try:
            read_points(str(path))
            pop_files.append((name, path))
        except Exception:
            logger.warning("File batch %s tidak dikenali sebagai boundary atau POP", name)
    if not boundary_files:
        raise InvalidFileError(message="Tidak ditemukan file boundary dalam batch.")

    pop_by_slug = {_batch_slug(name): (name, path) for name, path in pop_files}
    jobs: list[dict] = []
    for boundary_name, boundary_path in boundary_files:
        slug = _batch_slug(boundary_name)
        pop_match = pop_by_slug.get(slug)
        if not pop_match:
            # Spatial fallback: accept a single POP file located inside the boundary.
            try:
                polygon = read_boundary(str(boundary_path))
                candidates = []
                for pop_name, pop_path in pop_files:
                    points = read_points(str(pop_path))
                    if any(polygon.covers(Point(p["lon"], p["lat"])) for p in points):
                        candidates.append((pop_name, pop_path))
                if len(candidates) == 1:
                    pop_match = candidates[0]
            except Exception:
                pop_match = None
        if not pop_match:
            jobs.append({
                "job_id": f"skipped-{uuid.uuid4().hex[:10]}",
                "item_id": uuid.uuid4().hex[:12],
                "boundary_name": boundary_name,
                "design_name": slug,
                "status": "SKIPPED",
                "error": "POP pasangan tidak ditemukan.",
            })
            continue

        item_id = uuid.uuid4().hex[:12]
        item_dir = get_generation_cache_dir(current_user["id"], project_id, batch_id, item_id)
        item_input = item_dir / "input"
        item_input.mkdir(parents=True, exist_ok=True)
        boundary_item = item_input / "boundary.kml"
        pop_item = item_input / "pop.kml"
        shutil.copy2(boundary_path, boundary_item)
        shutil.copy2(pop_match[1], pop_item)
        job_id = str(uuid.uuid4())
        timestamp = __import__("datetime").datetime.now().strftime("%Y%m%d_%H%M")
        # The item suffix prevents same-named boundaries from overwriting each other.
        prefix = f"FTTH_{slug}_{timestamp}_{item_id[:6]}"
        jobs.append({
            "job_id": job_id,
            "item_id": item_id,
            "boundary_name": boundary_name,
            "design_name": slug,
            "status": "QUEUED",
            "boundary_path": str(boundary_item),
            "pop_path": str(pop_item),
            "cache_dir": str(item_dir),
            "output_kmz_name": f"{prefix}_core.kmz",
            "output_kml_name": f"{prefix}_core.kml",
            "output_csv_name": f"{prefix}_core.csv",
        })

    progress_manager.create_batch(batch_id, jobs, project_id=project_id, user_id=current_user["id"])
    with open(batch_root / "manifest.json", "w") as manifest_file:
        json.dump(
            {"project_id": project_id, "feature_colors": parsed_feature_colors, "jobs": jobs},
            manifest_file,
            indent=2,
        )
    for job in jobs:
        if job["status"] == "SKIPPED":
            progress_manager.update_batch_job(batch_id, job["job_id"], status="SKIPPED")
            continue
        output_dir = Path(job["cache_dir"]) / "core"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_kmz = output_dir / job["output_kmz_name"]
        output_csv = output_dir / job["output_csv_name"]
        await _enqueue_generation_job(
            "generate_task",
            job_id=job["job_id"],
            user_id=current_user["id"],
            project_id=project_id,
            batch_id=batch_id,
            item_id=job["item_id"],
            boundary_path=job["boundary_path"],
            pop_path=job["pop_path"],
            output_kmz_path=str(output_kmz),
            output_csv_path=str(output_csv),
            has_custom_pop=True,
            cache_dir=job["cache_dir"],
            gen_config_dict=gen_config.model_dump(),
            output_kml_name=job["output_kml_name"],
            output_kmz_name=job["output_kmz_name"],
            output_csv_name=job["output_csv_name"],
            batch_item_id=job["item_id"],
            feature_colors=parsed_feature_colors,
        )
    batch_state = progress_manager.get_batch(batch_id)
    # Keeps the endpoint deterministic in degraded Redis/test environments;
    # Redis remains the source of truth when available.
    if not isinstance(batch_state, dict):
        batch_state = {
            "batch_id": batch_id,
            "project_id": project_id,
            "status": "QUEUED",
            "total": len(jobs),
            "completed": 0,
            "failed": sum(job.get("status") in {"FAILED", "SKIPPED"} for job in jobs),
            "jobs": [{key: value for key, value in job.items() if key not in {"boundary_path", "pop_path", "cache_dir"}} for job in jobs],
        }
    return success_response(data=batch_state)


@router.get("/generate/batch/{batch_id}")
async def get_batch(batch_id: str, current_user: dict = Depends(get_current_user)):
    state = progress_manager.get_batch(batch_id)
    if not state:
        raise HTTPException(status_code=404, detail="Batch tidak ditemukan.")
    if not _can_access_job(state, current_user):
        raise HTTPException(status_code=403, detail="Batch tidak dapat diakses.")
    # Hydrate aggregate state from the authoritative per-job progress keys.
    for job in state.get("jobs", []):
        progress = progress_manager.get_status(job.get("job_id", ""))
        if not progress:
            continue
        status = "RUNNING"
        if progress.get("done"):
            status = (
                "COMPLETED"
                if progress.get("stage") == "COMPLETED"
                else ("CANCELED" if progress.get("stage") == "CANCELED" else "FAILED")
            )
        progress_manager.update_batch_job(
            batch_id,
            job["job_id"],
            status=status,
            stage=progress.get("stage"),
            message=progress.get("message"),
            percent=progress.get("percent", 0),
            result=progress.get("result"),
        )
    state = progress_manager.get_batch(batch_id) or state
    return success_response(data=state)


@router.get("/generate/batch/{batch_id}/progress")
async def get_batch_progress(batch_id: str, current_user: dict = Depends(get_current_user)):
    return await get_batch(batch_id, current_user)


@router.post("/generate/batch/{batch_id}/retry/{item_id}")
async def retry_batch_item(batch_id: str, item_id: str, current_user: dict = Depends(get_generation_user)):
    state = progress_manager.get_batch(batch_id)
    if not state:
        raise HTTPException(status_code=404, detail="Batch tidak ditemukan.")
    if not _can_access_job(state, current_user):
        raise HTTPException(status_code=403, detail="Batch tidak dapat diakses.")
    owner_id = state.get("user_id") or current_user["id"]
    manifest_dir = get_generation_cache_dir(owner_id, state.get("project_id"), batch_id)
    manifest_path = manifest_dir / "manifest.json"
    if not manifest_path.exists():
        raise HTTPException(status_code=404, detail="Manifest batch tidak ditemukan.")
    with open(manifest_path) as manifest_file:
        manifest = json.load(manifest_file)
    manifest_feature_colors = manifest.get("feature_colors", {})
    job = next((item for item in manifest.get("jobs", []) if item.get("item_id") == item_id), None)
    if not job or job.get("status") == "SKIPPED":
        raise HTTPException(status_code=404, detail="Item batch tidak dapat di-retry.")
    new_job_id = str(uuid.uuid4())
    output_dir = Path(job["cache_dir"]) / "core"
    await _enqueue_generation_job(
        "generate_task",
        job_id=new_job_id,
        user_id=owner_id,
        project_id=state.get("project_id"),
        batch_id=batch_id,
        item_id=item_id,
        boundary_path=job["boundary_path"],
        pop_path=job["pop_path"],
        output_kmz_path=str(output_dir / job["output_kmz_name"]),
        output_csv_path=str(output_dir / job["output_csv_name"]),
        has_custom_pop=True,
        cache_dir=job["cache_dir"],
        gen_config_dict=GenerationConfig(include_homepass=False).model_dump(),
        output_kml_name=job["output_kml_name"],
        output_kmz_name=job["output_kmz_name"],
        output_csv_name=job["output_csv_name"],
        batch_item_id=item_id,
        feature_colors=manifest_feature_colors,
    )
    progress_manager.update_batch_job(batch_id, job.get("job_id", ""), job_id=new_job_id, status="QUEUED", error=None)
    return success_response(data={"batch_id": batch_id, "item_id": item_id, "job_id": new_job_id})

@router.get("/generate/progress/{job_id}")
async def generate_progress(job_id: str, current_user: dict = Depends(get_current_user)):
    """Server-Sent Events endpoint for generation progress."""
    initial_state = await _get_job_state(job_id)
    if initial_state and not _can_access_job(initial_state, current_user):
        raise HTTPException(status_code=403, detail="Job tidak dapat diakses.")
    async def event_stream():
        last_data = None
        missing_attempts = 0
        while True:
            data = await _get_job_state(job_id)
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
            if not _can_access_job(data, current_user):
                yield f"data: {json.dumps({'error': 'Forbidden'})}\n\n"
                break

            if data != last_data:
                yield f"data: {json.dumps(data)}\n\n"
                last_data = data.copy()

            if data.get("done"):
                await asyncio.sleep(1)
                break

            # Keep the SSE connection active while a long export is running.
            # The browser ignores comment frames, but proxies see traffic.
            yield ": keep-alive\n\n"
            # One SSE connection is enough for live progress. Keep Redis
            # polling modest so many concurrent jobs do not create a second
            # source of request/Redis pressure.
            await asyncio.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/generate/status/{job_id}")
async def generate_status(job_id: str, current_user: dict = Depends(get_current_user)):
    """Return a refresh-safe snapshot without opening an SSE stream."""
    state = await _get_job_state(job_id)
    if not state:
        raise HTTPException(status_code=404, detail="Job tidak ditemukan.")
    if not _can_access_job(state, current_user):
        raise HTTPException(status_code=403, detail="Job tidak dapat diakses.")
    return success_response(data=state)


@router.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str, current_user: dict = Depends(get_generation_user)):
    state = await _get_job_state(job_id)
    if not state:
        raise HTTPException(status_code=404, detail="Job tidak ditemukan.")
    if not _can_access_job(state, current_user):
        raise HTTPException(status_code=403, detail="Job tidak dapat diakses.")
    if state.get("done"):
        raise HTTPException(status_code=409, detail="Job sudah selesai.")

    pool = await get_redis_pool()
    aborted = await Job(job_id, pool).abort(timeout=5)
    if not aborted:
        raise HTTPException(status_code=409, detail="Job tidak dapat dibatalkan.")

    progress_manager.cancel(job_id)
    await db.generationjob.update(
        where={"id": job_id},
        data={"status": "CANCELED", "stage": "CANCELED", "progress": 100},
    )
    if state.get("batch_id"):
        progress_manager.update_batch_job(
            state["batch_id"],
            job_id,
            status="CANCELED",
        )
    return success_response(data={"job_id": job_id, "status": "CANCELED"})


@router.post("/generate-homepass")
async def generate_homepass(
    job_id: Optional[str] = Form(None),
    project_id: Optional[str] = Form(None),
    batch_id: Optional[str] = Form(None),
    item_id: Optional[str] = Form(None),
    feature_colors: Optional[str] = Form(None),
    current_user: dict = Depends(get_generation_user),
):
    """Generate HC and direct ODP-to-house lines from the last core cache."""
    await _require_project_access(project_id, current_user)
    if not job_id:
        import uuid
        job_id = str(uuid.uuid4())
    progress_manager.create_job(job_id, user_id=current_user["id"], batch_id=batch_id)
    try:
        parsed_feature_colors = _parse_feature_colors_from_form(feature_colors)
        user_dir = _resolve_homepass_cache_dir(
            current_user["id"], project_id, batch_id, item_id
        )
        cleanup_old_files(user_dir)
        # Validate/migrate synchronously so the UI gets a useful response for a
        # missing/legacy cache instead of waiting for a worker failure.
        progress_manager.update(job_id, "PARSING", "Memeriksa cache Network Core...", 5)
        output_kmz_name = create_user_filename("design_ftth_homepass", "kmz")
        output_csv_name = create_user_filename("design_ftth_homepass", "csv")
        output_kmz_path = user_dir / output_kmz_name
        output_csv_path = user_dir / output_csv_name

        progress_manager.update(job_id, "QUEUED", "Menunggu worker memproses Homepass...", 1)
        await _enqueue_generation_job(
            "generate_homepass_task",
            job_id=job_id,
            user_id=current_user["id"],
            project_id=project_id,
            batch_id=batch_id,
            item_id=item_id,
            output_kmz_path=str(output_kmz_path),
            output_csv_path=str(output_csv_path),
            cache_dir=str(user_dir),
            feature_colors=parsed_feature_colors,
        )
        return success_response(data={
            "message": "Homepass generation job accepted.",
            "job_id": job_id,
            "kmz_url": user_file_url(output_kmz_name),
            "csv_url": user_file_url(output_csv_name),
        })
    except Exception as e:
        progress_manager.error(job_id, str(e))
        raise


@router.post("/regenerate-cables")
async def regenerate_cables(
    job_id: Optional[str] = Form(None),
    project_id: Optional[str] = Form(None),
    batch_id: Optional[str] = Form(None),
    item_id: Optional[str] = Form(None),
    feature_colors: Optional[str] = Form(None),
    current_user: dict = Depends(get_generation_user)
):
    await _require_project_access(project_id, current_user)
    if not job_id:
        import uuid
        job_id = str(uuid.uuid4())
    progress_manager.create_job(job_id, user_id=current_user["id"], batch_id=batch_id)

    try:
        parsed_feature_colors = _parse_feature_colors_from_form(feature_colors)
        user_dir = _resolve_homepass_cache_dir(
            current_user["id"], project_id, batch_id, item_id
        )
        cleanup_old_files(user_dir)
        output_kmz_name = create_user_filename("design_ftth_regen", "kmz")
        output_csv_name = create_user_filename("design_ftth_regen", "csv")
        output_kmz_path = user_dir / output_kmz_name
        output_csv_path = user_dir / output_csv_name

        await _enqueue_generation_job(
            "regenerate_cables_task",
            job_id=job_id,
            user_id=current_user["id"],
            project_id=project_id,
            batch_id=batch_id,
            item_id=item_id,
            output_path=str(output_kmz_path),
            include_homepass=True,
            output_csv=str(output_csv_path),
            cache_dir=str(user_dir),
            feature_colors=parsed_feature_colors,
        )

        return success_response(
            data={
                "message": "Regenerate cables job accepted.",
                "job_id": job_id,
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
    feature_colors: Optional[str] = Form(None),
    current_user: dict = Depends(get_generation_user),
):
    if not job_id:
        import uuid
        job_id = str(uuid.uuid4())
    progress_manager.create_job(job_id, user_id=current_user["id"])

    try:
        parsed_feature_colors = _parse_feature_colors_from_form(feature_colors)
        user_dir = get_user_cache_dir(current_user["id"])
        cleanup_old_files(user_dir)
        custom_path = user_dir / create_user_filename("custom_mapping", "kml")
        output_kmz_name = create_user_filename("design_ftth_custom", "kmz")
        output_csv_name = create_user_filename("design_ftth_custom", "csv")
        output_kmz_path = user_dir / output_kmz_name
        output_csv_path = user_dir / output_csv_name

        with open(custom_path, "wb") as buffer:
            shutil.copyfileobj(customFile.file, buffer)
        upload_file(current_user["id"], custom_path.name, custom_path)

        await _enqueue_generation_job(
            "generate_custom_task",
            job_id=job_id,
            user_id=current_user["id"],
            custom_path=str(custom_path),
            output_kmz_path=str(output_kmz_path),
            include_homepass=True,
            output_csv=str(output_csv_path),
            cache_dir=str(user_dir),
            feature_colors=parsed_feature_colors,
        )

        return success_response(
            data={
                "message": "Custom generation job accepted.",
                "job_id": job_id,
                "kmz_url": user_file_url(output_kmz_name),
                "csv_url": user_file_url(output_csv_name),
            },
        )
    except Exception as e:
        progress_manager.error(job_id, str(e))
        raise
