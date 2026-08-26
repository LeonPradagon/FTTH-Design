import mimetypes
import re
from pathlib import Path
from typing import BinaryIO, Iterator
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from server.api.deps import get_current_user, get_generation_user
from server.api.upload_validation import validate_design_upload
from server.core.logging import logger
from server.core.response import success_response
from server.services.user_storage import user_file_url, user_object_key
from server.storage.base import ObjectNotFoundError, ObjectStorage, StoredObject
from server.storage.dependencies import get_object_storage


router = APIRouter()


def _safe_filename(filename: str | None) -> str:
    basename = Path(filename or "upload").name
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "-", basename).strip(".-_")
    return sanitized[:180] or "upload"


def _iter_body(body: BinaryIO, chunk_size: int = 64 * 1024) -> Iterator[bytes]:
    try:
        while chunk := body.read(chunk_size):
            yield chunk
    finally:
        body.close()


@router.post("/api/upload")
async def upload_file(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_generation_user),
    storage: ObjectStorage = Depends(get_object_storage),
):
    filename = f"{uuid4().hex[:10]}_{_safe_filename(validate_design_upload(file))}"
    object_key = user_object_key(current_user["id"], filename)
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"

    try:
        await file.seek(0)
        await run_in_threadpool(
            storage.upload,
            object_key,
            file.file,
            content_type=content_type,
            content_disposition=f'inline; filename="{filename}"',
        )
    except Exception as exc:
        logger.exception("Failed to upload object %s", object_key)
        raise HTTPException(status_code=500, detail="Failed to upload file") from exc

    return success_response(data={"url": user_file_url(filename)})


async def _download_object(object_key: str, storage: ObjectStorage):
    try:
        stored_object: StoredObject = await run_in_threadpool(
            storage.download,
            object_key,
        )
    except ObjectNotFoundError as exc:
        raise HTTPException(status_code=404, detail="File not found") from exc

    headers: dict[str, str] = {}
    if stored_object.content_length is not None:
        headers["Content-Length"] = str(stored_object.content_length)
    if stored_object.content_disposition:
        headers["Content-Disposition"] = stored_object.content_disposition

    return StreamingResponse(
        _iter_body(stored_object.body),
        media_type=stored_object.content_type or "application/octet-stream",
        headers=headers,
    )


@router.get("/api/files/{filename}")
async def download_user_file(
    filename: str,
    current_user: dict = Depends(get_generation_user),
    storage: ObjectStorage = Depends(get_object_storage),
):
    return await _download_object(
        user_object_key(current_user["id"], filename),
        storage,
    )


@router.get("/data/{object_key:path}")
async def download_file(
    object_key: str,
    current_user: dict = Depends(get_current_user),
    storage: ObjectStorage = Depends(get_object_storage),
):
    user_prefix = user_object_key(current_user["id"], "file").rsplit("/", 1)[0] + "/"
    if not object_key.startswith(user_prefix):
        raise HTTPException(status_code=404, detail="File not found")
    return await _download_object(object_key, storage)
