"""FTTH Design Generator — project management API endpoints.

All endpoints return the standard response envelope:
``{"success": true/false, "data": {...}, "error": {...}}``.
"""

from fastapi import APIRouter, HTTPException, UploadFile, File, Depends
from pydantic import BaseModel
from typing import List, Optional, Any
import os
import shutil
from prisma import Json

from ...database import db
from ..deps import get_current_user, get_optional_user
from backend.core.errors import InvalidFileError
from backend.core.response import success_response
from backend.services.user_storage import create_user_filename, get_user_storage_dir, user_file_url

router = APIRouter(prefix="/api")

DEFAULT_FEATURE_COLORS = {
    "pop": "#eab308",
    "odc": "#ef4444",
    "odp": "#3b82f6",
    "house": "#6b7280",
    "feeder": "#ef4444",
    "distribution": "#8b5cf6",
}

LEGACY_DEFAULT_FEATURE_COLORS = {
    "pop": "#ef4444",
    "odc": "#3b82f6",
    "odp": "#10b981",
    "house": "#6b7280",
    "feeder": "#ef4444",
    "distribution": "#3b82f6",
}


def get_allowed_feature_colors(requested_colors: dict, current_user: dict) -> dict:
    if current_user.get("role") == "admin":
        uses_legacy_defaults = all(
            str(requested_colors.get(key, "")).lower() == color
            for key, color in LEGACY_DEFAULT_FEATURE_COLORS.items()
        )
        if uses_legacy_defaults:
            return DEFAULT_FEATURE_COLORS.copy()
        return {**DEFAULT_FEATURE_COLORS, **requested_colors}
    return DEFAULT_FEATURE_COLORS.copy()


class ProjectCreate(BaseModel):
    name: str
    layers: list
    filters: dict
    feature_colors: dict

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    layers: Optional[list] = None
    filters: Optional[dict] = None
    feature_colors: Optional[dict] = None

from backend.services.user_storage import create_user_filename, get_user_storage_dir, user_file_url, upload_file as minio_upload_file

@router.post("/upload")
async def upload_file(file: UploadFile = File(...), current_user: dict = Depends(get_optional_user)):
    """Uploads a file (like a KML) and returns its permanent URL."""
    try:
        user_dir = get_user_storage_dir(current_user["id"])
        extension = os.path.splitext(file.filename or "upload.kml")[1] or ".kml"
        safe_filename = create_user_filename("import", extension)
        file_location = user_dir / safe_filename
        
        with open(file_location, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        # Upload to MinIO so presigned URLs work later
        minio_upload_file(current_user["id"], safe_filename, file_location)
            
        return success_response(data={"url": user_file_url(safe_filename)})
    except Exception as e:
        raise InvalidFileError(
            message=f"Failed to upload file: {str(e)}",
        )

@router.post("/projects")
async def create_project(project: ProjectCreate, current_user: dict = Depends(get_current_user)):
    db_project = await db.project.create(
        data={
            "name": project.name,
            "layers": Json(project.layers),
            "filters": Json(project.filters),
            "feature_colors": Json(get_allowed_feature_colors(project.feature_colors, current_user)),
            "userId": current_user["id"]
        }
    )
    return success_response(data=_serialize_project(db_project))

@router.get("/projects")
async def read_projects(skip: int = 0, limit: int = 100, current_user: dict = Depends(get_current_user)):
    projects = await db.project.find_many(
        where={"userId": current_user["id"]},
        skip=skip,
        take=limit,
        order={"updated_at": "desc"}
    )
    return success_response(data=[_serialize_project(p) for p in projects])

@router.get("/projects/{project_id}")
async def read_project(project_id: str, current_user: dict = Depends(get_current_user)):
    project = await db.project.find_unique(where={"id": project_id})
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
        
    if project.userId != current_user["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")
        
    return success_response(data=_serialize_project(project))

@router.put("/projects/{project_id}")
async def update_project(project_id: str, project_update: ProjectUpdate, current_user: dict = Depends(get_current_user)):
    project = await db.project.find_unique(where={"id": project_id})
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
        
    if project.userId != current_user["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")
    
    update_data = project_update.dict(exclude_unset=True)
    if "layers" in update_data and update_data["layers"] is not None:
        update_data["layers"] = Json(update_data["layers"])
    if "filters" in update_data and update_data["filters"] is not None:
        update_data["filters"] = Json(update_data["filters"])
    if current_user.get("role") != "admin":
        update_data["feature_colors"] = Json(DEFAULT_FEATURE_COLORS.copy())
    elif "feature_colors" in update_data and update_data["feature_colors"] is not None:
        update_data["feature_colors"] = Json(
            get_allowed_feature_colors(update_data["feature_colors"], current_user)
        )

    updated_project = await db.project.update(
        where={"id": project_id},
        data=update_data
    )
    return success_response(data=_serialize_project(updated_project))

@router.delete("/projects/{project_id}")
async def delete_project(project_id: str, current_user: dict = Depends(get_current_user)):
    project = await db.project.find_unique(where={"id": project_id})
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
        
    if project.userId != current_user["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")
        
    try:
        await db.project.delete(where={"id": project_id})
        return success_response(data={"message": "Project deleted successfully"})
    except Exception:
        raise HTTPException(status_code=404, detail="Project not found")


def _serialize_project(project) -> dict:
    """Convert a Prisma Project record to a plain dict for JSON serialisation."""
    return {
        "id": project.id,
        "name": project.name,
        "layers": project.layers,
        "filters": project.filters,
        "feature_colors": project.feature_colors,
        "userId": project.userId,
        "created_at": project.created_at.isoformat() if project.created_at else None,
        "updated_at": project.updated_at.isoformat() if project.updated_at else None,
    }
