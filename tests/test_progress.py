import pytest
import json
from unittest.mock import MagicMock, patch
from backend.services.generator.progress import ProgressManager

@pytest.fixture
def mock_redis():
    with patch("backend.services.generator.progress.redis.from_url") as mock:
        yield mock.return_value

def test_create_job(mock_redis):
    pm = ProgressManager()
    pm.create_job("test_job")
    mock_redis.setex.assert_called_once()
    args, _ = mock_redis.setex.call_args
    assert args[0] == "job_progress:test_job"
    state = json.loads(args[2])
    assert state["stage"] == "STARTING"
    assert state["percent"] == 0
    assert not state["done"]

def test_update_job(mock_redis):
    pm = ProgressManager()
    pm.update("test_job", "CLUSTERING", "Doing something...", 50)
    mock_redis.setex.assert_called_once()
    args, _ = mock_redis.setex.call_args
    state = json.loads(args[2])
    assert state["stage"] == "CLUSTERING"
    assert state["percent"] == 50

def test_get_status(mock_redis):
    mock_redis.get.return_value = json.dumps({"stage": "ROUTING", "percent": 75, "done": False, "message": "Routing..."})
    pm = ProgressManager()
    status = pm.get_status("test_job")
    assert status is not None
    assert status["stage"] == "ROUTING"
    assert status["percent"] == 75

def test_complete(mock_redis):
    pm = ProgressManager()
    pm.complete("test_job")
    args, _ = mock_redis.setex.call_args
    state = json.loads(args[2])
    assert state["stage"] == "COMPLETED"
    assert state["percent"] == 100
    assert state["done"] is True

def test_error(mock_redis):
    pm = ProgressManager()
    pm.error("test_job", "Something went wrong")
    args, _ = mock_redis.setex.call_args
    state = json.loads(args[2])
    assert state["stage"] == "ERROR"
    assert state["message"] == "Something went wrong"
    assert state["done"] is True

def test_cleanup(mock_redis):
    pm = ProgressManager()
    pm.cleanup("test_job")
    mock_redis.delete.assert_called_once_with("job_progress:test_job")
