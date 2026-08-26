"""FTTH Design Generator — project management API endpoints.

All endpoints return the standard response envelope:
``{"success": true/false, "data": {...}, "error": {...}}``.
"""

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from typing import Optional
from prisma import Json

from ...database import db
from ..deps import get_admin_user, get_current_user, get_generation_user
from server.core.response import success_response

router = APIRouter(prefix="/api")

DEFAULT_FEATURE_COLORS = {
    "pop": "#eab308",
    "odc": "#ff0000",
    "odp": "#0000ff",
    "house": "#6b7280",
    "feeder": "#ff0000",
    "distribution": "#aa00ff",
}

LEGACY_DEFAULT_FEATURE_COLORS = {
    "pop": "#ef4444",
    "odc": "#3b82f6",
    "odp": "#10b981",
    "house": "#6b7280",
    "feeder": "#ef4444",
    "distribution": "#3b82f6",
}

PREVIOUS_DEFAULT_FEATURE_COLORS = {
    "pop": "#eab308",
    "odc": "#ef4444",
    "odp": "#3b82f6",
    "house": "#6b7280",
    "feeder": "#ef4444",
    "distribution": "#8b5cf6",
}

# Kept inside the existing filters JSON for compatibility with local Prisma
# clients that were generated before Project.generation_config was added.
# The API strips this internal key before returning filters to the frontend.
GENERATION_CONFIG_FILTER_KEY = "__generation_config__"


def _json_dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _filters_without_internal_config(value) -> dict:
    return {
        key: item
        for key, item in _json_dict(value).items()
        if key != GENERATION_CONFIG_FILTER_KEY
    }


def _stored_generation_config(project) -> dict:
    schema_config = getattr(project, "generation_config", None)
    if isinstance(schema_config, dict) and schema_config:
        return schema_config
    return _json_dict(getattr(project, "filters", {})).get(GENERATION_CONFIG_FILTER_KEY, {}) or {}


def get_allowed_feature_colors(requested_colors: dict, current_user: dict) -> dict:
    if current_user.get("role") == "admin":
        uses_old_defaults = any(
            all(
                str(requested_colors.get(key, "")).lower() == color
                for key, color in palette.items()
            )
            for palette in (LEGACY_DEFAULT_FEATURE_COLORS, PREVIOUS_DEFAULT_FEATURE_COLORS)
        )
        if uses_old_defaults:
            return DEFAULT_FEATURE_COLORS.copy()
        return {**DEFAULT_FEATURE_COLORS, **requested_colors}
    return DEFAULT_FEATURE_COLORS.copy()


class ProjectCreate(BaseModel):
    name: str
    layers: list
    filters: dict
    feature_colors: dict
    generation_config: dict = Field(default_factory=dict)

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    layers: Optional[list] = None
    filters: Optional[dict] = None
    feature_colors: Optional[dict] = None
    generation_config: Optional[dict] = None

@router.post("/projects")
async def create_project(project: ProjectCreate, current_user: dict = Depends(get_generation_user)):
    filters = {
        **project.filters,
        GENERATION_CONFIG_FILTER_KEY: project.generation_config,
    }
    async with db.tx() as transaction:
        db_project = await transaction.project.create(
            data={
                "name": project.name,
                "layers": Json(project.layers),
                "filters": Json(filters),
                "feature_colors": Json(get_allowed_feature_colors(project.feature_colors, current_user)),
                "userId": current_user["id"]
            }
        )
        await transaction.auditlog.create(
            data={
                "userId": current_user["id"],
                "action": "CREATE_PROJECT",
                "projectId": db_project.id,
                "details": Json({"old": None, "new": _serialize_project(db_project)}),
            }
        )
    return success_response(data=_serialize_project(db_project))

@router.get("/projects")
async def read_projects(skip: int = 0, limit: int = 100, current_user: dict = Depends(get_current_user)):
    where = (
        {}
        if current_user.get("role") in {"admin", "viewer"}
        else {"userId": current_user["id"]}
    )
    projects = await db.project.find_many(
        where=where,
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

    if (
        current_user.get("role") not in {"admin", "viewer"}
        and project.userId != current_user["id"]
    ):
        raise HTTPException(status_code=403, detail="Forbidden")

    return success_response(data=_serialize_project(project))

@router.put("/projects/{project_id}")
async def update_project(project_id: str, project_update: ProjectUpdate, current_user: dict = Depends(get_generation_user)):
    project = await db.project.find_unique(where={"id": project_id})
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    if current_user.get("role") != "admin" and project.userId != current_user["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")

    old_project = _serialize_project(project)
    update_data = project_update.model_dump(exclude_unset=True)
    generation_config = update_data.pop("generation_config", None)
    if "layers" in update_data and update_data["layers"] is not None:
        update_data["layers"] = Json(update_data["layers"])
    if "filters" in update_data and update_data["filters"] is not None:
        filters = {
            **_json_dict(update_data["filters"]),
            **({GENERATION_CONFIG_FILTER_KEY: generation_config} if generation_config is not None else {}),
        }
        update_data["filters"] = Json(filters)
    elif generation_config is not None:
        filters = {
            **_json_dict(project.filters),
            GENERATION_CONFIG_FILTER_KEY: generation_config,
        }
        update_data["filters"] = Json(filters)
    if current_user.get("role") != "admin":
        update_data["feature_colors"] = Json(DEFAULT_FEATURE_COLORS.copy())
    elif "feature_colors" in update_data and update_data["feature_colors"] is not None:
        update_data["feature_colors"] = Json(
            get_allowed_feature_colors(update_data["feature_colors"], current_user)
        )

    async with db.tx() as transaction:
        updated_project = await transaction.project.update(
            where={"id": project_id},
            data=update_data
        )
        await transaction.auditlog.create(
            data={
                "userId": current_user["id"],
                "action": "UPDATE_PROJECT",
                "projectId": project_id,
                "details": Json({
                    "old": old_project,
                    "new": _serialize_project(updated_project),
                }),
            }
        )
    return success_response(data=_serialize_project(updated_project))

@router.delete("/projects/{project_id}")
async def delete_project(project_id: str, current_user: dict = Depends(get_admin_user)):
    project = await db.project.find_unique(where={"id": project_id})
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    async with db.tx() as transaction:
        await transaction.auditlog.create(
            data={
                "userId": current_user["id"],
                "action": "DELETE_PROJECT",
                "projectId": project_id,
                "details": Json({"old": _serialize_project(project), "new": None}),
            }
        )
        await transaction.project.delete(where={"id": project_id})
    return success_response(data={"message": "Project deleted successfully"})


def _serialize_project(project) -> dict:
    """Convert a Prisma Project record to a plain dict for JSON serialisation."""
    return {
        "id": project.id,
        "name": project.name,
        "layers": project.layers,
        "filters": _filters_without_internal_config(getattr(project, "filters", {})),
        "feature_colors": project.feature_colors,
        "generation_config": _stored_generation_config(project),
        "userId": project.userId,
        "created_at": project.created_at.isoformat() if project.created_at else None,
        "updated_at": project.updated_at.isoformat() if project.updated_at else None,
    }
