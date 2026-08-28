from io import BytesIO

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.api.deps import (
    get_current_user,
    get_generation_user,
    get_rate_limited_generation_user,
)
from server.api.routes.files import router
from server.storage.dependencies import get_object_storage
from server.tests.fakes import InMemoryObjectStorage


def create_test_client(storage: InMemoryObjectStorage) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    current_user = {
        "id": "test-user",
        "role": "engineer",
    }
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_generation_user] = lambda: current_user
    app.dependency_overrides[get_rate_limited_generation_user] = lambda: current_user
    app.dependency_overrides[get_object_storage] = lambda: storage
    return TestClient(app)


def test_uploaded_file_is_available_from_its_compatible_data_url() -> None:
    storage = InMemoryObjectStorage()
    client = create_test_client(storage)

    upload_response = client.post(
        "/api/upload",
        files={
            "file": (
                "../../Site Plan.kml",
                b"<kml>site</kml>",
                "text/html",
            )
        },
    )

    assert upload_response.status_code == 200
    object_url = upload_response.json()["data"]["url"]
    assert object_url.startswith("/api/files/")
    assert object_url.endswith("Site-Plan.kml")
    assert ".." not in object_url

    download_response = client.get(object_url)
    assert download_response.status_code == 200
    assert download_response.content == b"<kml>site</kml>"
    assert (
        download_response.headers["content-type"]
        == "application/vnd.google-earth.kml+xml"
    )


def test_legacy_data_url_cannot_cross_user_namespaces() -> None:
    client = create_test_client(InMemoryObjectStorage())

    response = client.get("/data/users/another-user/private.kmz")

    assert response.status_code == 404


def test_legacy_import_data_url_remains_available_for_saved_projects() -> None:
    storage = InMemoryObjectStorage()
    storage.upload(
        "imports/old-project/boundary.kml",
        BytesIO(b"<kml>boundary</kml>"),
        content_type="application/vnd.google-earth.kml+xml",
    )
    client = create_test_client(storage)

    response = client.get("/data/imports/old-project/boundary.kml")

    assert response.status_code == 200
    assert response.content == b"<kml>boundary</kml>"


def test_file_endpoint_falls_back_to_legacy_raw_user_namespace() -> None:
    storage = InMemoryObjectStorage()
    storage.upload(
        "test-user/old-design.kmz",
        BytesIO(b"legacy-design"),
        content_type="application/vnd.google-earth.kmz",
    )
    client = create_test_client(storage)

    response = client.get("/api/files/old-design.kmz")

    assert response.status_code == 200
    assert response.content == b"legacy-design"
