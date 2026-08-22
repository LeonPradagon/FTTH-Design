from fastapi import APIRouter, Depends, HTTPException
from typing import List, Optional

from backend.database import db
from backend.core.response import success_response, error_response
from backend.api.deps import get_current_user

router = APIRouter(prefix="/api")

@router.get("/projects/{project_id}/audit")
async def get_project_audit(project_id: str, current_user: dict = Depends(get_current_user)):
    """Get audit logs for a specific project."""
    project = await db.project.find_unique(where={"id": project_id})
    if not project or project.userId != current_user["id"]:
        return error_response("PROJECT_NOT_FOUND", "Project not found or access denied", http_status=404)
        
    logs = await db.auditlog.find_many(
        where={"projectId": project_id},
        order={"createdAt": "desc"}
    )
    
    return success_response(data=[log.model_dump() for log in logs])


@router.get("/audit")
async def get_all_audit(current_user: dict = Depends(get_current_user)):
    """Get all audit logs (Admin only)."""
    if current_user.get("role") != "admin":
        return error_response("UNAUTHORIZED", "Admin access required", http_status=403)
        
    logs = await db.auditlog.find_many(
        order={"createdAt": "desc"},
        take=100 # limit to 100 for performance
    )
    
    return success_response(data=[log.model_dump() for log in logs])
