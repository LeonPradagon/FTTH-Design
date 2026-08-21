import os
from pathlib import Path
from zipfile import ZipFile

from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ.setdefault("BETTER_AUTH_SECRET", "test-secret")

from server.api.routes import files, generation
from server.storage.dependencies import get_object_storage
from server.tests.fakes import InMemoryObjectStorage


def create_test_client(storage: InMemoryObjectStorage) -> TestClient:
    app = FastAPI()
    app.include_router(files.router)
    app.include_router(generation.router)
    app.dependency_overrides[get_object_storage] = lambda: storage
    return TestClient(app)


def write_generated_artifacts(output_kmz: str, output_csv: str) -> None:
    with ZipFile(output_kmz, "w") as archive:
        archive.writestr("design.kml", "<kml>generated</kml>")
    Path(output_csv).write_text("kind,count\nodp,2\n", encoding="utf-8")


def assert_published_artifacts(
    response,
    client: TestClient,
    scratch_root: Path,
) -> None:
    assert response.status_code == 200
    payload = response.json()
    artifact_urls = [payload["url"], payload["kmz_url"], payload["csv_url"]]
    assert all(url.startswith("/data/generated/") for url in artifact_urls)
    assert len({url.split("/")[3] for url in artifact_urls}) == 1
    assert client.get(payload["url"]).content == b"<kml>generated</kml>"
    assert client.get(payload["csv_url"]).content == b"kind,count\nodp,2\n"
    assert list(scratch_root.iterdir()) == []


def test_generated_artifacts_are_published_and_scratch_is_removed(
    monkeypatch,
    tmp_path: Path,
) -> None:
    def fake_generator(
        boundary_path: str,
        pop_path: str,
        output_kmz: str,
        output_csv: str,
        has_custom_pop: bool,
    ) -> None:
        del boundary_path, pop_path, has_custom_pop
        write_generated_artifacts(output_kmz, output_csv)

    storage = InMemoryObjectStorage()
    client = create_test_client(storage)

    monkeypatch.setattr(generation, "DATA_DIR", tmp_path)
    monkeypatch.setattr(generation, "_run_generator_logic", fake_generator)

    response = client.post("/generate")

    assert_published_artifacts(response, client, tmp_path)


def test_regenerated_artifacts_are_published(
    monkeypatch,
    tmp_path: Path,
) -> None:
    def fake_regenerator(
        *,
        output_path: str,
        include_homepass: bool,
        output_csv: str,
    ) -> None:
        del include_homepass
        write_generated_artifacts(output_path, output_csv)

    storage = InMemoryObjectStorage()
    client = create_test_client(storage)
    monkeypatch.setattr(generation, "DATA_DIR", tmp_path)
    monkeypatch.setattr(generation, "regenerate_cables_only", fake_regenerator)

    response = client.post("/regenerate-cables")

    assert_published_artifacts(response, client, tmp_path)


def test_custom_generated_artifacts_are_published(
    monkeypatch,
    tmp_path: Path,
) -> None:
    def fake_custom_generator(
        *,
        file_path: str,
        output_path: str,
        include_homepass: bool,
        output_csv: str,
    ) -> None:
        del file_path, include_homepass
        write_generated_artifacts(output_path, output_csv)

    storage = InMemoryObjectStorage()
    client = create_test_client(storage)
    monkeypatch.setattr(generation, "DATA_DIR", tmp_path)
    monkeypatch.setattr(
        generation,
        "generate_cables_from_custom_points",
        fake_custom_generator,
    )

    response = client.post(
        "/generate-custom",
        files={"customFile": ("mapping.kml", b"<kml />", "application/xml")},
    )

    assert_published_artifacts(response, client, tmp_path)
