from fastapi import APIRouter, Depends
from prisma import Json

from server.api.deps import get_current_user, get_generation_user
from server.core.response import error_response, success_response
from server.database import db

router = APIRouter(prefix="/api/projects/{project_id}/versions")


async def _can_access_project(project_id: str, current_user: dict) -> bool:
    project = await db.project.find_unique(where={"id": project_id})
    return bool(
        project
        and (
            current_user.get("role") == "admin"
            or project.userId == current_user["id"]
        )
    )


@router.get("")
async def list_versions(project_id: str, current_user: dict = Depends(get_current_user)):
    """List all design versions for a project."""
    if not await _can_access_project(project_id, current_user):
        return error_response("PROJECT_NOT_FOUND", "Project not found or access denied", http_status=404)

    versions = await db.designversion.find_many(
        where={"projectId": project_id},
        order={"version": "desc"},
    )

    version_list = []
    for version in versions:
        data = version.model_dump()
        data.pop("metadata", None)
        version_list.append(data)

    return success_response(data=version_list)


@router.get("/compare/versions")
async def compare_versions(
    project_id: str,
    v1: int,
    v2: int,
    current_user: dict = Depends(get_current_user),
):
    """Compare two design versions."""
    if not await _can_access_project(project_id, current_user):
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
        "config_diff": {},
    }

    return success_response(
        data={
            "v1": version1.model_dump(),
            "v2": version2.model_dump(),
            "diff": diff,
        }
    )


@router.get("/{version}")
async def get_version(
    project_id: str,
    version: int,
    current_user: dict = Depends(get_current_user),
):
    """Get details of a specific design version."""
    if not await _can_access_project(project_id, current_user):
        return error_response("PROJECT_NOT_FOUND", "Project not found or access denied", http_status=404)

    design_version = await db.designversion.find_unique(
        where={"projectId_version": {"projectId": project_id, "version": version}}
    )
    if not design_version:
        return error_response("VERSION_NOT_FOUND", f"Version {version} not found", http_status=404)

    return success_response(data=design_version.model_dump())


@router.delete("/{version}")
async def delete_version(
    project_id: str,
    version: int,
    current_user: dict = Depends(get_generation_user),
):
    """Delete a specific design version."""
    if not await _can_access_project(project_id, current_user):
        return error_response("PROJECT_NOT_FOUND", "Project not found or access denied", http_status=404)

    design_version = await db.designversion.find_unique(
        where={"projectId_version": {"projectId": project_id, "version": version}}
    )
    if not design_version:
        return error_response("VERSION_NOT_FOUND", f"Version {version} not found", http_status=404)

    async with db.tx() as transaction:
        await transaction.designversion.delete(
            where={"projectId_version": {"projectId": project_id, "version": version}}
        )
        await transaction.auditlog.create(
            data={
                "userId": current_user["id"],
                "action": "DELETE_VERSION",
                "projectId": project_id,
                "versionId": design_version.id,
                "details": Json({"version": version}),
            }
        )

    return success_response(data={"message": f"Version {version} deleted successfully"})


@router.post("/{version}/duplicate")
async def duplicate_version(
    project_id: str,
    version: int,
    current_user: dict = Depends(get_generation_user),
):
    """Duplicate a design version and its persisted spatial records."""
    if not await _can_access_project(project_id, current_user):
        return error_response("PROJECT_NOT_FOUND", "Project not found or access denied", http_status=404)

    async with db.tx() as transaction:
        source = await transaction.designversion.find_unique(
            where={"projectId_version": {"projectId": project_id, "version": version}}
        )
        if not source:
            return error_response("VERSION_NOT_FOUND", f"Version {version} not found", http_status=404)

        last_version = await transaction.designversion.find_first(
            where={"projectId": project_id},
            order={"version": "desc"},
        )
        next_version = last_version.version + 1 if last_version else 1

        data = source.model_dump()
        data.pop("id")
        data.pop("createdAt")
        data["version"] = next_version
        for field in ("config", "metadata", "validation", "stats"):
            data[field] = Json(data[field])

        duplicate = await transaction.designversion.create(data=data)
        await transaction.execute_raw(
            'INSERT INTO "design_odc" ("id", "designVersionId", "label", "location") '
            'SELECT gen_random_uuid(), $1, "label", "location" FROM "design_odc" '
            'WHERE "designVersionId" = $2',
            duplicate.id,
            source.id,
        )
        await transaction.execute_raw(
            'INSERT INTO "design_odp" ("id", "designVersionId", "odcId", "label", "location") '
            'SELECT gen_random_uuid(), $1, new_odc."id", old_odp."label", old_odp."location" '
            'FROM "design_odp" AS old_odp '
            'JOIN "design_odc" AS old_odc ON old_odc."id" = old_odp."odcId" '
            'JOIN "design_odc" AS new_odc ON new_odc."designVersionId" = $1 '
            'AND new_odc."label" = old_odc."label" '
            'WHERE old_odp."designVersionId" = $2',
            duplicate.id,
            source.id,
        )
        await transaction.execute_raw(
            'INSERT INTO "design_cable" '
            '("id", "designVersionId", "type", "sourceLabel", "targetLabel", "length", "path") '
            'SELECT gen_random_uuid(), $1, "type", "sourceLabel", "targetLabel", "length", "path" '
            'FROM "design_cable" WHERE "designVersionId" = $2',
            duplicate.id,
            source.id,
        )
        await transaction.auditlog.create(
            data={
                "userId": current_user["id"],
                "action": "DUPLICATE_VERSION",
                "projectId": project_id,
                "versionId": duplicate.id,
                "details": Json({"src_version": version, "new_version": next_version}),
            }
        )

    return success_response(data=duplicate.model_dump())
