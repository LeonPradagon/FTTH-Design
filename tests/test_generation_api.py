import pytest
from fastapi.testclient import TestClient
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock
from server.main import app
from server.api.deps import get_current_user, get_generation_user

# Override dependency
def override_get_current_user():
    return {"id": "test_user_id", "email": "test@example.com"}

app.dependency_overrides[get_current_user] = override_get_current_user
app.dependency_overrides[get_generation_user] = override_get_current_user

client = TestClient(app)


@pytest.fixture(autouse=True)
def mock_generation_jobs():
    with patch("server.api.routes.generation.db") as mock_db:
        jobs = mock_db.generationjob
        jobs.create = AsyncMock()
        jobs.update = AsyncMock()
        jobs.find_unique = AsyncMock(return_value=None)
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
        response = client.post("/generate", files={"boundaryFile": ("boundary.kml", f)})

    assert response.status_code == 200
    assert response.json()["success"] is True
    assert "job_id" in response.json()["data"]

    mock_redis_pool.enqueue_job.assert_called_once()
    args, kwargs = mock_redis_pool.enqueue_job.call_args
    assert args[0] == "generate_task"
    assert kwargs["job_id"] == response.json()["data"]["job_id"]
    assert kwargs["user_id"] == "test_user_id"
    assert kwargs["project_id"] is None

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


def test_generate_batch_pairs_boundary_and_pop(tmp_path, mock_redis_pool, mock_progress_manager, mock_storage_upload):
    boundary = """<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>106.14,-6.12 106.16,-6.12 106.16,-6.10 106.14,-6.10 106.14,-6.12</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>"""
    pop = """<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>POP A</name><Point><coordinates>106.15,-6.11</coordinates></Point></Placemark></Document></kml>"""
    response = client.post(
        "/generate/batch",
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
    mock_progress_manager.create_job.assert_any_call(
        mock_redis_pool.enqueue_job.call_args.kwargs["job_id"],
        user_id="test_user_id",
        batch_id=data["batch_id"],
    )


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
