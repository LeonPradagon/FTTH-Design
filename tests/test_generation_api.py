import asyncio
import json
import pytest
from fastapi.testclient import TestClient
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock, MagicMock
from server.main import app
from server.api.deps import (
    get_current_user,
    get_generation_user,
    get_rate_limited_generation_user,
)
from server.services.generator.generation_config import GenerationConfig

# Override dependency
def override_get_current_user():
    return {"id": "test_user_id", "email": "test@example.com"}

app.dependency_overrides[get_current_user] = override_get_current_user
app.dependency_overrides[get_generation_user] = override_get_current_user
app.dependency_overrides[get_rate_limited_generation_user] = override_get_current_user

client = TestClient(app)


@pytest.fixture(autouse=True)
def mock_generation_jobs():
    with patch("server.api.routes.generation.db") as mock_db:
        jobs = mock_db.generationjob
        jobs.create = AsyncMock()
        jobs.update = AsyncMock()
        jobs.find_unique = AsyncMock(return_value=None)
        mock_db.project.find_unique = AsyncMock(
            return_value=SimpleNamespace(userId="test_user_id")
        )
        yield jobs


@pytest.fixture
def mock_redis_pool():
    with patch("server.api.routes.generation.get_redis_pool") as mock_get_pool:
        mock_pool = AsyncMock()
        mock_get_pool.return_value = mock_pool
        yield mock_pool

@pytest.fixture
def mock_progress_manager():
    with patch("server.api.routes.generation.progress_manager") as mock_pm:
        mock_pm.get_status.return_value = None
        yield mock_pm

@pytest.fixture
def mock_storage_upload():
    with patch("server.api.routes.generation.upload_file") as mock_upload:
        yield mock_upload

def test_generate_design_no_files(mock_redis_pool, mock_progress_manager):
    response = client.post("/generate")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_FILE"

def test_generate_design_success(tmp_path, mock_redis_pool, mock_progress_manager, mock_storage_upload):
    boundary_file = tmp_path / "boundary.kml"
    boundary_file.write_text("<kml></kml>")

    with open(boundary_file, "rb") as f:
        response = client.post(
            "/generate",
            data={"project_id": "project-1"},
            files={"boundaryFile": ("boundary.kml", f)},
        )

    assert response.status_code == 200
    assert response.json()["success"] is True
    assert "job_id" in response.json()["data"]

    mock_redis_pool.enqueue_job.assert_called_once()
    args, kwargs = mock_redis_pool.enqueue_job.call_args
    assert args[0] == "generate_task"
    assert kwargs["job_id"] == response.json()["data"]["job_id"]
    assert kwargs["user_id"] == "test_user_id"
    assert kwargs["project_id"] == "project-1"


def test_generate_design_requires_project(tmp_path, mock_redis_pool, mock_progress_manager):
    boundary_file = tmp_path / "boundary.kml"
    boundary_file.write_text("<kml></kml>")

    with open(boundary_file, "rb") as boundary:
        response = client.post(
            "/generate",
            files={"boundaryFile": ("boundary.kml", boundary)},
        )

    assert response.status_code == 400
    assert response.json()["detail"] == "Project wajib disimpan sebelum generation."


def test_generate_design_forwards_feature_colors(tmp_path, mock_redis_pool, mock_progress_manager, mock_storage_upload):
    boundary_file = tmp_path / "boundary.kml"
    boundary_file.write_text("<kml></kml>")
    feature_colors = {
        "feeder": "#112233",
        "distribution": "#445566",
    }

    with open(boundary_file, "rb") as f:
        response = client.post(
            "/generate",
            files={"boundaryFile": ("boundary.kml", f)},
            data={"project_id": "project-1", "feature_colors": json.dumps(feature_colors)},
        )

    assert response.status_code == 200
    assert mock_redis_pool.enqueue_job.call_args.kwargs["feature_colors"] == feature_colors


def test_single_generation_keeps_multiple_boundaries_in_one_design(
    tmp_path, mock_redis_pool, mock_progress_manager, mock_storage_upload
):
    boundary = """<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
      <Placemark><Polygon><outerBoundaryIs><LinearRing>
        <coordinates>106.0,-6.0 106.01,-6.0 106.01,-6.01 106.0,-6.01 106.0,-6.0</coordinates>
      </LinearRing></outerBoundaryIs></Polygon></Placemark>
      <Placemark><Polygon><outerBoundaryIs><LinearRing>
        <coordinates>106.02,-6.0 106.03,-6.0 106.03,-6.01 106.02,-6.01 106.02,-6.0</coordinates>
      </LinearRing></outerBoundaryIs></Polygon></Placemark>
    </Document></kml>"""
    response = client.post(
        "/generate",
        data={"project_id": "project-1"},
        files={"boundaryFile": ("boundary_multi.kml", boundary, "application/vnd.google-earth.kml+xml")},
    )

    assert response.status_code == 200
    assert response.json()["success"] is True
    mock_redis_pool.enqueue_job.assert_called_once()

def test_regenerate_cables(mock_redis_pool, mock_progress_manager, mock_storage_upload):
    with patch(
        "server.api.routes.generation.load_network_state",
        return_value=({}, [], {"version": 3}),
    ):
        response = client.post("/regenerate-cables", data={"job_id": "test-job-regen"})
    assert response.status_code == 200
    assert response.json()["success"] is True

    mock_redis_pool.enqueue_job.assert_called_once()
    args, kwargs = mock_redis_pool.enqueue_job.call_args
    assert args[0] == "regenerate_cables_task"

def test_generate_custom(tmp_path, mock_redis_pool, mock_progress_manager, mock_storage_upload):
    custom_file = tmp_path / "custom.kml"
    custom_file.write_text("<kml></kml>")

    with open(custom_file, "rb") as f:
        response = client.post("/generate-custom", files={"customFile": ("custom.kml", f)})

    assert response.status_code == 200
    assert response.json()["success"] is True

    mock_redis_pool.enqueue_job.assert_called_once()
    args, kwargs = mock_redis_pool.enqueue_job.call_args
    assert args[0] == "generate_custom_task"


def test_generate_homepass_requires_and_queues_core_cache(mock_redis_pool, mock_progress_manager, mock_storage_upload):
    with patch("server.api.routes.generation.load_network_state", return_value=({}, [], {"version": 2})):
        response = client.post("/generate-homepass", data={"job_id": "test-job-homepass"})

    assert response.status_code == 200
    assert response.json()["success"] is True
    mock_redis_pool.enqueue_job.assert_called_once()
    assert mock_redis_pool.enqueue_job.call_args.args[0] == "generate_homepass_task"


def test_generate_homepass_rejects_missing_core_cache(mock_redis_pool, mock_progress_manager, mock_storage_upload):
    from server.core.errors import DesignStateNotFoundError

    with patch(
        "server.api.routes.generation.load_network_state",
        side_effect=DesignStateNotFoundError(message="Cache Network Core belum tersedia"),
    ):
        response = client.post("/generate-homepass", data={"job_id": "test-job-no-core"})

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "DESIGN_STATE_NOT_FOUND"


@pytest.mark.parametrize("endpoint", ["/generate-homepass", "/regenerate-cables"])
def test_follow_up_generation_rejects_another_users_project(
    endpoint,
    mock_redis_pool,
    mock_progress_manager,
):
    with patch(
        "server.api.routes.generation.db.project.find_unique",
        new=AsyncMock(return_value=SimpleNamespace(userId="another-user")),
    ):
        response = client.post(endpoint, data={"project_id": "private-project"})

    assert response.status_code == 403


def test_generate_batch_pairs_boundary_and_pop(tmp_path, mock_redis_pool, mock_progress_manager, mock_storage_upload):
    boundary = """<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>106.14,-6.12 106.16,-6.12 106.16,-6.10 106.14,-6.10 106.14,-6.12</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>"""
    pop = """<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>POP A</name><Point><coordinates>106.15,-6.11</coordinates></Point></Placemark></Document></kml>"""
    response = client.post(
        "/generate/batch",
        data={"project_id": "project-1"},
        files=[
            ("files", ("area_a_boundary.kml", boundary, "application/vnd.google-earth.kml+xml")),
            ("files", ("area_a_pop.kml", pop, "application/vnd.google-earth.kml+xml")),
        ],
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert "batch_id" in data
    assert data["total"] == 1
    assert data["jobs"][0]["status"] == "QUEUED"
    assert mock_redis_pool.enqueue_job.call_args.args[0] == "generate_task"
    assert mock_storage_upload.call_count == 2
    mock_progress_manager.create_job.assert_any_call(
        mock_redis_pool.enqueue_job.call_args.kwargs["job_id"],
        user_id="test_user_id",
        batch_id=data["batch_id"],
    )


def test_generate_batch_merges_multiple_polygons_and_embedded_rbs_pop(
    tmp_path, mock_redis_pool, mock_progress_manager, mock_storage_upload
):
    combined = """<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
      <Placemark><name>area_a</name><Polygon><outerBoundaryIs><LinearRing>
        <coordinates>106.0,-6.0 106.01,-6.0 106.01,-6.01 106.0,-6.01 106.0,-6.0</coordinates>
      </LinearRing></outerBoundaryIs></Polygon></Placemark>
      <Placemark><name>area_b</name><Polygon><outerBoundaryIs><LinearRing>
        <coordinates>106.02,-6.0 106.03,-6.0 106.03,-6.01 106.02,-6.01 106.02,-6.0</coordinates>
      </LinearRing></outerBoundaryIs></Polygon></Placemark>
      <Placemark><name>RBS</name><Point><coordinates>106.015,-6.005,0</coordinates></Point></Placemark>
    </Document></kml>"""
    response = client.post(
        "/generate/batch",
        data={"project_id": "project-1"},
        files=[("files", ("boundary_combined.kml", combined, "application/vnd.google-earth.kml+xml"))],
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["total"] == 1
    assert data["jobs"][0]["status"] == "QUEUED"
    assert mock_redis_pool.enqueue_job.call_count == 1
    assert mock_redis_pool.enqueue_job.call_args.kwargs["has_custom_pop"] is True


def test_generate_batch_requires_project(mock_redis_pool, mock_progress_manager):
    response = client.post(
        "/generate/batch",
        files=[("files", ("boundary.kml", "<kml></kml>", "application/vnd.google-earth.kml+xml"))],
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Project wajib disimpan sebelum generation."


def test_batch_retry_reuses_original_config(tmp_path, mock_redis_pool, mock_progress_manager, mock_storage_upload):
    boundary = """<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>106.14,-6.12 106.16,-6.12 106.16,-6.10 106.14,-6.10 106.14,-6.12</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>"""
    pop = """<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>POP A</name><Point><coordinates>106.15,-6.11</coordinates></Point></Placemark></kml>"""

    def cache_dir(_user_id, _project_id=None, batch_id=None, item_id=None):
        path = tmp_path
        if batch_id:
            path /= batch_id
        if item_id:
            path /= item_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    with patch("server.api.routes.generation.get_generation_cache_dir", side_effect=cache_dir):
        response = client.post(
            "/generate/batch",
            data={"project_id": "project-1", "config": json.dumps({"odp_capacity": 8})},
            files=[
                ("files", ("area_a_boundary.kml", boundary, "application/vnd.google-earth.kml+xml")),
                ("files", ("area_a_pop.kml", pop, "application/vnd.google-earth.kml+xml")),
            ],
        )
        batch = response.json()["data"]
        item = batch["jobs"][0]
        mock_progress_manager.get_batch.return_value = {
            "user_id": "test_user_id",
            "project_id": "project-1",
            "jobs": batch["jobs"],
        }
        mock_redis_pool.enqueue_job.reset_mock()

        retry = client.post(f"/generate/batch/{batch['batch_id']}/retry/{item['item_id']}")

    assert retry.status_code == 200
    assert mock_redis_pool.enqueue_job.call_args.kwargs["gen_config_dict"]["odp_capacity"] == 8


def test_cancel_owned_job(mock_redis_pool, mock_progress_manager, mock_generation_jobs):
    mock_progress_manager.get_status.return_value = {
        "user_id": "test_user_id",
        "stage": "ROUTING",
        "done": False,
    }
    with patch("server.api.routes.generation.Job") as job_class:
        job_class.return_value.abort = AsyncMock(return_value=True)
        response = client.post("/api/jobs/job-1/cancel")

    assert response.status_code == 200
    assert response.json()["data"]["status"] == "CANCELED"
    mock_progress_manager.cancel.assert_called_once_with("job-1")
    mock_generation_jobs.update.assert_awaited_once_with(
        where={"id": "job-1"},
        data={"status": "CANCELED", "stage": "CANCELED", "progress": 100},
    )


def test_status_falls_back_to_durable_job(mock_progress_manager, mock_generation_jobs):
    mock_progress_manager.get_status.return_value = None
    mock_generation_jobs.find_unique.return_value = SimpleNamespace(
        userId="test_user_id",
        status="COMPLETED",
        stage="COMPLETED",
        progress=100,
        batchId=None,
        error=None,
        result={"kmz_url": "/api/files/design.kmz"},
    )

    response = client.get("/generate/status/job-1")

    assert response.status_code == 200
    assert response.json()["data"]["done"] is True
    assert response.json()["data"]["result"]["kmz_url"] == "/api/files/design.kmz"


def test_worker_allows_running_jobs_to_be_aborted():
    from server.worker import WorkerSettings

    assert WorkerSettings.allow_abort_jobs is True


def test_generation_audit_includes_previous_config(tmp_path):
    from server.worker import generate_task

    output_kmz = tmp_path / "design.kmz"
    output_kmz.write_bytes(b"generated")
    output_csv = tmp_path / "design.csv"
    used_config = GenerationConfig(odp_capacity=8)
    previous = SimpleNamespace(version=1, config={"odp_capacity": 10})
    new_version = SimpleNamespace(id="version-2")
    transaction = SimpleNamespace(
        designversion=SimpleNamespace(
            find_first=AsyncMock(return_value=previous),
            create=AsyncMock(return_value=new_version),
        ),
        auditlog=SimpleNamespace(create=AsyncMock()),
        execute_raw=AsyncMock(),
    )
    transaction_manager = SimpleNamespace(
        start=AsyncMock(return_value=transaction),
        commit=AsyncMock(),
        rollback=AsyncMock(),
    )
    fake_db = SimpleNamespace(
        generationjob=SimpleNamespace(update=AsyncMock()),
        tx=MagicMock(return_value=transaction_manager),
    )
    validation = MagicMock()
    validation.to_dict.return_value = {"status": "PASS"}

    with (
        patch("server.worker.db", fake_db),
        patch(
            "server.worker._run_generator_logic",
            return_value=(None, [], [], {}, used_config, None),
        ),
        patch("server.worker.validate_design", return_value=validation),
        patch("server.worker.compute_design_stats", return_value={}),
        patch("server.worker._compute_input_hash", return_value="input-hash"),
        patch("server.worker.upload_file"),
        patch("server.worker.progress_manager"),
    ):
        asyncio.run(
            generate_task(
                {},
                boundary_path=str(tmp_path / "boundary.kml"),
                pop_path=None,
                output_kmz_path=str(output_kmz),
                output_csv_path=str(output_csv),
                has_custom_pop=False,
                cache_dir=str(tmp_path),
                gen_config_dict=used_config.model_dump(),
                job_id="job-2",
                project_id="project-1",
                user_id="engineer-1",
                output_kmz_name=output_kmz.name,
                output_csv_name=output_csv.name,
            )
        )

    details = transaction.auditlog.create.await_args.kwargs["data"]["details"].data
    assert details["old"] == {"version": 1, "config": {"odp_capacity": 10}}
    assert details["new"]["config"]["odp_capacity"] == 8
    transaction.execute_raw.assert_awaited_once_with(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        "project-1",
    )
