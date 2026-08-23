import hashlib
import mimetypes
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from urllib.parse import quote

from server.storage.dependencies import get_object_storage

USER_CACHE_ROOT = Path(os.getenv("USER_CACHE_ROOT", "/tmp/ftth_cache")).resolve()

def _safe_scope(value: str) -> str:
    """Return a filesystem-safe, non-sensitive scope identifier."""
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:32]

def get_user_cache_dir(user_id: str) -> Path:
    """Return an opaque, account-specific cache directory for local processing."""
    account_key = _safe_scope(user_id)
    cache_dir = USER_CACHE_ROOT / account_key
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def get_generation_cache_dir(user_id: str, project_id: str | None = None,
                             batch_id: str | None = None,
                             item_id: str | None = None) -> Path:
    """Return an isolated cache directory for one generation scope."""
    path = get_user_cache_dir(user_id)
    for value in (project_id or "default-project", batch_id or "single-job", item_id or "single-item"):
        path = path / _safe_scope(value)
    path.mkdir(parents=True, exist_ok=True)
    return path

def get_user_storage_dir(user_id: str) -> Path:
    """Deprecated: Alias for get_user_cache_dir for backward compatibility during processing."""
    return get_user_cache_dir(user_id)

def create_user_filename(prefix: str, extension: str) -> str:
    safe_prefix = re.sub(r"[^a-zA-Z0-9_-]+", "_", prefix).strip("_") or "file"
    safe_extension = extension.lower().lstrip(".")
    return f"{safe_prefix}_{int(time.time())}_{uuid.uuid4().hex[:10]}.{safe_extension}"


def user_object_key(user_id: str, filename: str) -> str:
    if not filename or Path(filename).name != filename:
        raise ValueError("Invalid filename")
    return f"users/{_safe_scope(user_id)}/{filename}"


def upload_file(user_id: str, filename: str, local_path: Path) -> None:
    """Upload a local file through the configured S3-compatible storage."""
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    with local_path.open("rb") as source:
        get_object_storage().upload(
            user_object_key(user_id, filename),
            source,
            content_type=content_type,
            content_disposition=f'inline; filename="{filename}"',
        )


def download_file(user_id: str, filename: str, local_path: Path) -> None:
    stored = get_object_storage().download(user_object_key(user_id, filename))
    try:
        with local_path.open("wb") as destination:
            shutil.copyfileobj(stored.body, destination)
    finally:
        stored.body.close()

def user_file_url(filename: str) -> str:
    if not filename or Path(filename).name != filename:
        raise ValueError("Invalid filename")
    return f"/api/files/{quote(filename)}"

def resolve_user_file(user_id: str, filename: str) -> Path:
    """Deprecated: used by legacy local file download endpoint."""
    if not filename or Path(filename).name != filename:
        raise ValueError("Invalid filename")
    
    user_dir = get_user_cache_dir(user_id)
    file_path = (user_dir / filename).resolve()
    if file_path.parent != user_dir:
        raise ValueError("Invalid filename")
    return file_path
