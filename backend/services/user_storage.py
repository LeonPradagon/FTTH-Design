import hashlib
import os
import re
import time
import uuid
from pathlib import Path


USER_STORAGE_ROOT = Path(os.getenv("USER_STORAGE_ROOT", "storage/users")).resolve()


def get_user_storage_dir(user_id: str) -> Path:
    """Return an opaque, account-specific storage directory."""
    account_key = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:32]
    user_dir = USER_STORAGE_ROOT / account_key
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir


def get_user_cache_dir(user_id: str) -> Path:
    cache_dir = get_user_storage_dir(user_id) / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def create_user_filename(prefix: str, extension: str) -> str:
    safe_prefix = re.sub(r"[^a-zA-Z0-9_-]+", "_", prefix).strip("_") or "file"
    safe_extension = extension.lower().lstrip(".")
    return f"{safe_prefix}_{int(time.time())}_{uuid.uuid4().hex[:10]}.{safe_extension}"


def resolve_user_file(user_id: str, filename: str) -> Path:
    """Resolve a filename inside one account and reject path traversal."""
    if not filename or Path(filename).name != filename:
        raise ValueError("Invalid filename")

    user_dir = get_user_storage_dir(user_id)
    file_path = (user_dir / filename).resolve()
    if file_path.parent != user_dir:
        raise ValueError("Invalid filename")
    return file_path


def user_file_url(filename: str) -> str:
    return f"/api/files/{filename}"
