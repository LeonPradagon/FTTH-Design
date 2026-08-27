import os
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ.setdefault("BETTER_AUTH_SECRET", "test-secret-that-is-at-least-32-characters")

from server.api.deps import get_optional_user
from server.api.routes.audit import router as audit_router
from server.api.routes.versions import router as versions_router
from server.storage.dependencies import get_object_storage
from server.tests.fakes import InMemoryObjectStorage


def _client(user: dict, *routers) -> TestClient:
    app = FastAPI()
    for router in routers:
        app.include_router(router)
    app.dependency_overrides[get_optional_user] = lambda: user
    return TestClient(app)


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("delete", "/api/projects/project-1/versions/1"),
        ("post", "/api/projects/project-1/versions/1/duplicate"),
        ("post", "/api/projects/project-1/versions/1/rollback"),
    ],
)
def test_viewer_cannot_mutate_versions(method: str, path: str) -> None:
    client = _client({"id": "viewer-1", "role": "viewer"}, versions_router)

    response = getattr(client, method)(path)

    assert response.status_code == 403


def test_engineer_cannot_delete_version() -> None:
    response = _client({"id": "engineer-1", "role": "engineer"}, versions_router).delete(
        "/api/projects/project-1/versions/1"
    )

    assert response.status_code == 403


def test_admin_can_list_another_users_versions_with_validation() -> None:
    version = MagicMock(version=1)
    version.model_dump.return_value = {
        "id": "version-1",
        "config": {"odp_capacity": 10},
        "metadata": {
            "input_hash": "large-payload",
            "artifacts": {"kmz": "users/scope/design.kmz"},
        },
        "validation": {"status": "PASS"},
        "stats": {"odc_count": 2},
    }
    fake_db = SimpleNamespace(
        project=SimpleNamespace(
            find_unique=AsyncMock(return_value=SimpleNamespace(userId="owner-1"))
        ),
        designversion=SimpleNamespace(find_many=AsyncMock(return_value=[version])),
    )
    client = _client({"id": "admin-1", "role": "admin"}, versions_router)

    with patch("server.api.routes.versions.db", fake_db):
        response = client.get("/api/projects/project-1/versions")

    assert response.status_code == 200
    assert response.json()["data"][0]["validation"] == {"status": "PASS"}
    assert "metadata" not in response.json()["data"][0]
    assert response.json()["data"][0]["artifacts"]["kmz"].endswith(
        "/versions/1/export/kmz"
    )


def test_compare_route_is_not_shadowed_by_integer_version_route() -> None:
    first = MagicMock(stats={"odc_count": 2})
    first.model_dump.return_value = {"version": 1}
    second = MagicMock(stats={"odc_count": 5})
    second.model_dump.return_value = {"version": 2}
    fake_db = SimpleNamespace(
        project=SimpleNamespace(
            find_unique=AsyncMock(return_value=SimpleNamespace(userId="user-1"))
        ),
        designversion=SimpleNamespace(
            find_unique=AsyncMock(side_effect=[first, second])
        ),
    )
    client = _client({"id": "user-1", "role": "user"}, versions_router)

    with patch("server.api.routes.versions.db", fake_db):
        response = client.get(
            "/api/projects/project-1/versions/compare/versions?v1=1&v2=2"
        )

    assert response.status_code == 200
    assert response.json()["data"]["diff"]["odc_count_diff"] == 3


@pytest.mark.parametrize(
    ("operation", "action"),
    [("duplicate", "DUPLICATE_VERSION"), ("rollback", "ROLLBACK_VERSION")],
)
def test_version_copy_copies_spatial_records_in_the_same_transaction(
    operation: str,
    action: str,
) -> None:
    source = MagicMock(id="version-1")
    source.model_dump.return_value = {
        "id": "version-1",
        "projectId": "project-1",
        "version": 1,
        "config": {},
        "metadata": {},
        "validation": {},
        "stats": {},
        "status": "COMPLETED",
        "createdAt": "2026-08-23T00:00:00Z",
    }
    duplicate = MagicMock(id="version-2")
    duplicate.model_dump.return_value = {"id": "version-2", "version": 2}
    transaction = SimpleNamespace(
        designversion=SimpleNamespace(
            find_unique=AsyncMock(return_value=source),
            find_first=AsyncMock(return_value=SimpleNamespace(version=1)),
            create=AsyncMock(return_value=duplicate),
        ),
        execute_raw=AsyncMock(),
        auditlog=SimpleNamespace(create=AsyncMock()),
    )
    transaction_context = MagicMock()
    transaction_context.__aenter__ = AsyncMock(return_value=transaction)
    transaction_context.__aexit__ = AsyncMock(return_value=None)
    fake_db = SimpleNamespace(
        project=SimpleNamespace(
            find_unique=AsyncMock(return_value=SimpleNamespace(userId="user-1"))
        ),
        tx=MagicMock(return_value=transaction_context),
    )
    client = _client({"id": "user-1", "role": "user"}, versions_router)

    with patch("server.api.routes.versions.db", fake_db):
        response = client.post(f"/api/projects/project-1/versions/1/{operation}")

    assert response.status_code == 200
    assert transaction.execute_raw.await_count == 4
    transaction.execute_raw.assert_any_await(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        "project-1",
    )
    transaction.auditlog.create.assert_awaited_once()
    assert transaction.auditlog.create.await_args.kwargs["data"]["action"] == action


def test_version_artifact_can_be_exported_from_object_storage() -> None:
    storage = InMemoryObjectStorage()
    storage.upload("users/scope/design.kmz", BytesIO(b"saved-version"))
    version = SimpleNamespace(
        metadata={"artifacts": {"kmz": "users/scope/design.kmz"}}
    )
    fake_db = SimpleNamespace(
        project=SimpleNamespace(
            find_unique=AsyncMock(return_value=SimpleNamespace(userId="user-1"))
        ),
        designversion=SimpleNamespace(find_unique=AsyncMock(return_value=version)),
    )
    client = _client({"id": "user-1", "role": "engineer"}, versions_router)
    client.app.dependency_overrides[get_object_storage] = lambda: storage

    with patch("server.api.routes.versions.db", fake_db):
        response = client.get("/api/projects/project-1/versions/1/export/kmz")

    assert response.status_code == 200
    assert response.content == b"saved-version"


def test_admin_can_read_another_users_project_audit() -> None:
    log = MagicMock()
    log.model_dump.return_value = {"action": "GENERATE"}
    fake_db = SimpleNamespace(
        project=SimpleNamespace(
            find_unique=AsyncMock(return_value=SimpleNamespace(userId="owner-1"))
        ),
        auditlog=SimpleNamespace(find_many=AsyncMock(return_value=[log])),
    )
    client = _client({"id": "admin-1", "role": "admin"}, audit_router)

    with patch("server.api.routes.audit.db", fake_db):
        response = client.get("/api/projects/project-1/audit")

    assert response.status_code == 200
    assert response.json()["data"] == [{"action": "GENERATE"}]
