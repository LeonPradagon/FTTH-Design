from fastapi import APIRouter, Depends, HTTPException
from typing import List, Optional

from prisma import Json
from backend.database import db
from backend.core.response import success_response, error_response
from backend.api.deps import get_current_user

router = APIRouter(prefix="/api/projects/{project_id}/versions")

@router.get("")
async def list_versions(project_id: str, current_user: dict = Depends(get_current_user)):
    """List all design versions for a project."""
    project = await db.project.find_unique(where={"id": project_id})
    if not project or project.userId != current_user["id"]:
        return error_response("PROJECT_NOT_FOUND", "Project not found or access denied", http_status=404)
        
    versions = await db.designversion.find_many(
        where={"projectId": project_id},
        order={"version": "desc"}
    )
    
    # Exclude heavy JSON payloads from list view to keep it fast
    version_list = []
    for v in versions:
        v_dict = v.model_dump()
        v_dict.pop("metadata", None)
        v_dict.pop("validation", None)
        version_list.append(v_dict)
        
    return success_response(data=version_list)


@router.get("/{version}")
async def get_version(project_id: str, version: int, current_user: dict = Depends(get_current_user)):
    """Get details of a specific design version."""
    project = await db.project.find_unique(where={"id": project_id})
    if not project or project.userId != current_user["id"]:
        return error_response("PROJECT_NOT_FOUND", "Project not found or access denied", http_status=404)
        
    design_version = await db.designversion.find_unique(
        where={"projectId_version": {"projectId": project_id, "version": version}}
    )
    
    if not design_version:
        return error_response("VERSION_NOT_FOUND", f"Version {version} not found", http_status=404)
        
    return success_response(data=design_version.model_dump())


@router.delete("/{version}")
async def delete_version(project_id: str, version: int, current_user: dict = Depends(get_current_user)):
    """Delete a specific design version."""
    project = await db.project.find_unique(where={"id": project_id})
    if not project or project.userId != current_user["id"]:
        return error_response("PROJECT_NOT_FOUND", "Project not found or access denied", http_status=404)
        
    try:
        await db.designversion.delete(
            where={"projectId_version": {"projectId": project_id, "version": version}}
        )
        
        await db.auditlog.create(
            data={
                "userId": current_user["id"],
                "action": "DELETE_VERSION",
                "projectId": project_id,
                "details": Json({"version": version})
            }
        )
        return success_response(data={"message": f"Version {version} deleted successfully"})
    except Exception as e:
        return error_response("DELETE_FAILED", str(e))

@router.get("/compare/versions")
async def compare_versions(project_id: str, v1: int, v2: int, current_user: dict = Depends(get_current_user)):
    """Compare two design versions."""
    project = await db.project.find_unique(where={"id": project_id})
    if not project or project.userId != current_user["id"]:
        return error_response("PROJECT_NOT_FOUND", "Project not found or access denied", http_status=404)
        
    version1 = await db.designversion.find_unique(
        where={"projectId_version": {"projectId": project_id, "version": v1}}
    )
    version2 = await db.designversion.find_unique(
        where={"projectId_version": {"projectId": project_id, "version": v2}}
    )
    
    if not version1 or not version2:
        return error_response("VERSION_NOT_FOUND", "One or both versions not found", http_status=404)
        
    v1_stats = version1.stats or {}
    v2_stats = version2.stats or {}
    
    diff = {
        "odc_count_diff": v2_stats.get("odc_count", 0) - v1_stats.get("odc_count", 0),
        "odp_count_diff": v2_stats.get("odp_count", 0) - v1_stats.get("odp_count", 0),
        "customer_count_diff": v2_stats.get("customer_count", 0) - v1_stats.get("customer_count", 0),
        "feeder_length_km_diff": v2_stats.get("feeder_length_km", 0) - v1_stats.get("feeder_length_km", 0),
        "config_diff": {} # Implement deep diff if necessary
    }
    
    return success_response(data={
        "v1": version1.model_dump(),
        "v2": version2.model_dump(),
        "diff": diff
    })

@router.post("/{version}/duplicate")
async def duplicate_version(project_id: str, version: int, current_user: dict = Depends(get_current_user)):
    """Duplicate a design version."""
    project = await db.project.find_unique(where={"id": project_id})
    if not project or project.userId != current_user["id"]:
        return error_response("PROJECT_NOT_FOUND", "Project not found or access denied", http_status=404)
        
    src_version = await db.designversion.find_unique(
        where={"projectId_version": {"projectId": project_id, "version": version}}
    )
    
    if not src_version:
        return error_response("VERSION_NOT_FOUND", f"Version {version} not found", http_status=404)
        
    last_version = await db.designversion.find_first(
        where={"projectId": project_id},
        order={"version": "desc"}
    )
    next_version = (last_version.version + 1) if last_version else 1
    
    data_dict = src_version.model_dump()
    data_dict.pop("id")
    data_dict.pop("createdAt")
    data_dict["version"] = next_version
    
    data_dict["config"] = Json(data_dict["config"])
    data_dict["metadata"] = Json(data_dict["metadata"])
    data_dict["validation"] = Json(data_dict["validation"])
    data_dict["stats"] = Json(data_dict["stats"])
    
    new_version = await db.designversion.create(data=data_dict)
    
    await db.auditlog.create(
        data={
            "userId": current_user["id"],
            "action": "DUPLICATE_VERSION",
            "projectId": project_id,
            "details": Json({"src_version": version, "new_version": next_version})
        }
    )
    
    return success_response(data=new_version.model_dump())
