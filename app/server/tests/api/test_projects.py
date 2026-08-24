import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ.setdefault("BETTER_AUTH_SECRET", "test-secret-that-is-at-least-32-characters")

from server.api.deps import get_optional_user
from server.api.routes.projects import router


def _client(user: dict) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_optional_user] = lambda: user
    return TestClient(app)


def test_viewer_can_list_projects_without_mutation_access() -> None:
    fake_db = SimpleNamespace(
        project=SimpleNamespace(find_many=AsyncMock(return_value=[])),
    )

    with patch("server.api.routes.projects.db", fake_db):
        response = _client({"id": "viewer-1", "role": "viewer"}).get(
            "/api/projects"
        )

    assert response.status_code == 200
    assert fake_db.project.find_many.await_args.kwargs["where"] == {}


def test_project_update_audits_old_and_new_values() -> None:
    old_project = SimpleNamespace(
        id="project-1",
        name="Old name",
        layers=[],
        filters={},
        feature_colors={},
        generation_config={},
        userId="engineer-1",
        created_at=None,
        updated_at=None,
    )
    updated_project = SimpleNamespace(**{**vars(old_project), "name": "New name"})
    transaction = SimpleNamespace(
        project=SimpleNamespace(update=AsyncMock(return_value=updated_project)),
        auditlog=SimpleNamespace(create=AsyncMock()),
    )
    transaction_context = MagicMock()
    transaction_context.__aenter__ = AsyncMock(return_value=transaction)
    transaction_context.__aexit__ = AsyncMock(return_value=None)
    fake_db = SimpleNamespace(
        project=SimpleNamespace(find_unique=AsyncMock(return_value=old_project)),
        tx=MagicMock(return_value=transaction_context),
    )
    with patch("server.api.routes.projects.db", fake_db):
        response = _client({"id": "engineer-1", "role": "engineer"}).put(
            "/api/projects/project-1",
            json={"name": "New name"},
        )

    assert response.status_code == 200
    audit_data = transaction.auditlog.create.await_args.kwargs["data"]
    assert audit_data["action"] == "UPDATE_PROJECT"
    assert audit_data["details"].data["old"]["name"] == "Old name"
    assert audit_data["details"].data["new"]["name"] == "New name"


def test_project_config_is_saved_without_requiring_new_prisma_client() -> None:
    config = {"odc_capacity": 8, "max_distribution_length_m": 750}
    created_project = SimpleNamespace(
        id="project-1",
        name="Design",
        layers=[],
        filters={"__generation_config__": config},
        feature_colors={},
        userId="engineer-1",
        created_at=None,
        updated_at=None,
    )
    transaction = SimpleNamespace(
        project=SimpleNamespace(create=AsyncMock(return_value=created_project)),
        auditlog=SimpleNamespace(create=AsyncMock()),
    )
    transaction_context = MagicMock()
    transaction_context.__aenter__ = AsyncMock(return_value=transaction)
    transaction_context.__aexit__ = AsyncMock(return_value=None)
    fake_db = SimpleNamespace(tx=MagicMock(return_value=transaction_context))

    with patch("server.api.routes.projects.db", fake_db):
        response = _client({"id": "engineer-1", "role": "engineer"}).post(
            "/api/projects",
            json={
                "name": "Design",
                "layers": [],
                "filters": {},
                "feature_colors": {},
                "generation_config": config,
            },
        )

    assert response.status_code == 200
    create_data = transaction.project.create.await_args.kwargs["data"]
    assert "generation_config" not in create_data
    assert create_data["filters"].data["__generation_config__"] == config
    assert response.json()["data"]["filters"] == {}
    assert response.json()["data"]["generation_config"] == config


def test_engineer_cannot_delete_project() -> None:
    response = _client({"id": "engineer-1", "role": "engineer"}).delete(
        "/api/projects/project-1"
    )

    assert response.status_code == 403
