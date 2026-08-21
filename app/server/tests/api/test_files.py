from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.api.routes.files import router
from server.storage.dependencies import get_object_storage
from server.tests.fakes import InMemoryObjectStorage


def create_test_client(storage: InMemoryObjectStorage) -> TestClient:
    app = FastAPI()
    app.include_router(router)
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
                "application/vnd.google-earth.kml+xml",
            )
        },
    )

    assert upload_response.status_code == 200
    object_url = upload_response.json()["url"]
    assert object_url.startswith("/data/imports/")
    assert object_url.endswith("/Site-Plan.kml")
    assert ".." not in object_url

    download_response = client.get(object_url)
    assert download_response.status_code == 200
    assert download_response.content == b"<kml>site</kml>"
    assert (
        download_response.headers["content-type"]
        == "application/vnd.google-earth.kml+xml"
    )
