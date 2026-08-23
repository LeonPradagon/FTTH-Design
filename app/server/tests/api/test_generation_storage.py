from pathlib import Path
from unittest.mock import patch

from server.services.user_storage import upload_file, user_file_url
from server.tests.fakes import InMemoryObjectStorage


def test_generated_file_uses_configured_storage_and_user_namespace(tmp_path: Path) -> None:
    artifact = tmp_path / "design.kmz"
    artifact.write_bytes(b"generated")
    storage = InMemoryObjectStorage()

    with patch(
        "server.services.user_storage.get_object_storage",
        return_value=storage,
    ):
        upload_file("user-123", artifact.name, artifact)

    assert len(storage.objects) == 1
    object_key = next(iter(storage.objects))
    assert object_key.startswith("users/")
    assert "user-123" not in object_key
    assert object_key.endswith("/design.kmz")
    assert user_file_url(artifact.name) == "/api/files/design.kmz"
