import hashlib
import os
import re
import time
import uuid
from pathlib import Path
from minio import Minio
from datetime import timedelta

MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "localhost:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "admin")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "password123")
MINIO_SECURE = os.getenv("MINIO_SECURE", "false").lower() == "true"
BUCKET_NAME = "ftth-storage"

minio_client = Minio(
    MINIO_ENDPOINT,
    access_key=MINIO_ACCESS_KEY,
    secret_key=MINIO_SECRET_KEY,
    secure=MINIO_SECURE,
)

# Ensure bucket exists
try:
    if not minio_client.bucket_exists(BUCKET_NAME):
        minio_client.make_bucket(BUCKET_NAME)
except Exception as e:
    print(f"Warning: MinIO bucket check failed: {e}")

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

def upload_file(user_id: str, filename: str, local_path: Path):
    """Upload a local file to MinIO under the user's namespace."""
    object_name = f"{user_id}/{filename}"
    minio_client.fput_object(BUCKET_NAME, object_name, str(local_path))

def download_file(user_id: str, filename: str, local_path: Path):
    """Download a file from MinIO to local path."""
    object_name = f"{user_id}/{filename}"
    minio_client.fget_object(BUCKET_NAME, object_name, str(local_path))

def get_presigned_url(user_id: str, filename: str, expires_minutes: int = 60) -> str:
    """Generate a presigned URL to download a file from MinIO."""
    object_name = f"{user_id}/{filename}"
    url = minio_client.presigned_get_object(
        BUCKET_NAME, object_name, expires=timedelta(minutes=expires_minutes)
    )
    return url

def user_file_url(filename: str) -> str:
    """Still returns the local proxy URL, which will redirect to MinIO."""
    return f"/api/files/{filename}"

def resolve_user_file(user_id: str, filename: str) -> Path:
    """Deprecated: used by legacy local file download endpoint."""
    if not filename or Path(filename).name != filename:
        raise ValueError("Invalid filename")
    
    user_dir = get_user_cache_dir(user_id)
    file_path = (user_dir / filename).resolve()
    if file_path.parent != user_dir:
        raise ValueError("Invalid filename")
    return file_path
