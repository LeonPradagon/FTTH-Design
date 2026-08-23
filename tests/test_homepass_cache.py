from server.api.routes import generation
from server.core.errors import DesignStateNotFoundError


def test_homepass_cache_falls_back_to_default_scope_when_project_is_created_late(
    monkeypatch, tmp_path
):
    project_cache = tmp_path / "project-cache"
    default_cache = tmp_path / "default-cache"

    def fake_cache_dir(_user_id, project_id=None, _batch_id=None, _item_id=None):
        return project_cache if project_id else default_cache

    def fake_load(cache_dir=None):
        if cache_dir == project_cache:
            raise DesignStateNotFoundError(
                message="Cache Network Core belum tersedia. Jalankan Generate Design terlebih dahulu."
            )
        return ({}, [], {})

    monkeypatch.setattr(generation, "get_generation_cache_dir", fake_cache_dir)
    monkeypatch.setattr(generation, "load_network_state", fake_load)

    resolved = generation._resolve_homepass_cache_dir(
        "user-1", "project-created-after-generate", None, None
    )

    assert resolved == default_cache
