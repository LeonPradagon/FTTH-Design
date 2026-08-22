import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock, AsyncMock
from backend.main import app
from backend.api.deps import get_current_user
import uuid

# Override dependency
def override_get_current_user():
    return {"id": "test_user_id", "email": "test@example.com"}

app.dependency_overrides[get_current_user] = override_get_current_user

client = TestClient(app)

@pytest.fixture
def mock_redis_pool():
    with patch("backend.api.routes.generation.get_redis_pool") as mock_get_pool:
        mock_pool = AsyncMock()
        mock_get_pool.return_value = mock_pool
        yield mock_pool

@pytest.fixture
def mock_progress_manager():
    with patch("backend.api.routes.generation.progress_manager") as mock_pm:
        yield mock_pm

@pytest.fixture
def mock_minio():
    with patch("backend.services.user_storage.minio_client") as mock_client:
        mock_client.presigned_get_object.return_value = "http://mock-minio/presigned"
        yield mock_client

def test_generate_design_no_files(mock_redis_pool, mock_progress_manager):
    response = client.post("/generate")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_FILE"

def test_generate_design_success(tmp_path, mock_redis_pool, mock_progress_manager, mock_minio):
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

def test_regenerate_cables(mock_redis_pool, mock_progress_manager, mock_minio):
    response = client.post("/regenerate-cables", data={"job_id": "test-job-regen"})
    assert response.status_code == 200
    assert response.json()["success"] is True
    
    mock_redis_pool.enqueue_job.assert_called_once()
    args, kwargs = mock_redis_pool.enqueue_job.call_args
    assert args[0] == "regenerate_cables_task"

def test_generate_custom(tmp_path, mock_redis_pool, mock_progress_manager, mock_minio):
    custom_file = tmp_path / "custom.kml"
    custom_file.write_text("<kml></kml>")
    
    with open(custom_file, "rb") as f:
        response = client.post("/generate-custom", files={"customFile": ("custom.kml", f)})
        
    assert response.status_code == 200
    assert response.json()["success"] is True
    
    mock_redis_pool.enqueue_job.assert_called_once()
    args, kwargs = mock_redis_pool.enqueue_job.call_args
    assert args[0] == "generate_custom_task"
