from fastapi import APIRouter, HTTPException, UploadFile, File, Depends
from pydantic import BaseModel
from typing import List, Optional, Any
import os
import shutil
import time
from prisma import Json

from ...database import db
from ..deps import get_current_user

router = APIRouter(prefix="/api")

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

@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Uploads a file (like a KML) and returns its permanent URL."""
    try:
        os.makedirs("dashboard/public/data/imports", exist_ok=True)
        # Create a unique filename to avoid overwrites
        timestamp = int(time.time())
        safe_filename = f"{timestamp}_{file.filename}"
        file_location = f"dashboard/public/data/imports/{safe_filename}"
        
        with open(file_location, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        return {"url": f"/data/imports/{safe_filename}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to upload file: {str(e)}")

@router.post("/projects")
async def create_project(project: ProjectCreate, current_user: dict = Depends(get_current_user)):
    db_project = await db.project.create(
        data={
            "name": project.name,
            "layers": Json(project.layers),
            "filters": Json(project.filters),
            "feature_colors": Json(project.feature_colors),
            "userId": current_user["id"]
        }
    )
    return db_project

@router.get("/projects")
async def read_projects(skip: int = 0, limit: int = 100, current_user: dict = Depends(get_current_user)):
    # Admin can see all, user can see only theirs
    where_clause = {}
    if current_user.get("role") != "admin":
        where_clause = {"userId": current_user["id"]}

    projects = await db.project.find_many(
        where=where_clause,
        skip=skip,
        take=limit,
        order={"updated_at": "desc"}
    )
    return projects

@router.get("/projects/{project_id}")
async def read_project(project_id: str, current_user: dict = Depends(get_current_user)):
    project = await db.project.find_unique(where={"id": project_id})
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
        
    if current_user.get("role") != "admin" and project.userId != current_user["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")
        
    return project

@router.put("/projects/{project_id}")
async def update_project(project_id: str, project_update: ProjectUpdate, current_user: dict = Depends(get_current_user)):
    project = await db.project.find_unique(where={"id": project_id})
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
        
    if current_user.get("role") != "admin" and project.userId != current_user["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")
    
    update_data = project_update.dict(exclude_unset=True)
    if "layers" in update_data and update_data["layers"] is not None:
        update_data["layers"] = Json(update_data["layers"])
    if "filters" in update_data and update_data["filters"] is not None:
        update_data["filters"] = Json(update_data["filters"])
    if "feature_colors" in update_data and update_data["feature_colors"] is not None:
        update_data["feature_colors"] = Json(update_data["feature_colors"])

    updated_project = await db.project.update(
        where={"id": project_id},
        data=update_data
    )
    return updated_project

@router.delete("/projects/{project_id}")
async def delete_project(project_id: str, current_user: dict = Depends(get_current_user)):
    project = await db.project.find_unique(where={"id": project_id})
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
        
    if current_user.get("role") != "admin" and project.userId != current_user["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")
        
    try:
        await db.project.delete(where={"id": project_id})
        return {"message": "Project deleted successfully"}
    except Exception:
        raise HTTPException(status_code=404, detail="Project not found")
