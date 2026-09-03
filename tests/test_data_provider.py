"""Tests for automatic online/local OSM source selection."""

from shapely.geometry import box
from unittest.mock import patch

from server.services.generator.core_logic import _fetch_generation_data
from server.services.generator.data_provider import (
    SourceDecision,
    boundary_area_km2,
    boundary_tile_count,
    choose_source,
)


def test_small_boundary_uses_online_source_by_default(monkeypatch):
    monkeypatch.delenv("OSM_SOURCE_MODE", raising=False)
    decision = choose_source(box(106.80, -6.20, 106.81, -6.19))

    assert decision.source == "online"
    assert decision.tile_count == 1
    assert decision.area_km2 < 25


def test_large_boundary_uses_local_source_by_default(monkeypatch):
    monkeypatch.delenv("OSM_SOURCE_MODE", raising=False)
    decision = choose_source(box(106.70, -6.40, 106.90, -6.10))

    assert decision.source == "local"
    assert decision.tile_count > 4
    assert decision.area_km2 > 25


def test_source_mode_can_be_overridden(monkeypatch):
    boundary = box(106.70, -6.40, 106.90, -6.10)
    monkeypatch.setenv("OSM_SOURCE_MODE", "online")
    assert choose_source(boundary).source == "online"
    monkeypatch.setenv("OSM_SOURCE_MODE", "local")
    assert choose_source(boundary).source == "local"


def test_area_and_tile_selection_are_positive():
    boundary = box(106.70, -6.40, 106.90, -6.10)
    assert boundary_area_km2(boundary) > 0
    assert boundary_tile_count(boundary) == 24


def test_online_failure_retries_the_complete_generation_from_local(monkeypatch):
    monkeypatch.delenv("OSM_SOURCE_MODE", raising=False)
    monkeypatch.setenv("OSM_LOCAL_FALLBACK_ON_ONLINE_FAILURE", "true")
    boundary = box(106.80, -6.20, 106.81, -6.19)
    decision = SourceDecision("online", "test", 1.0, 1)
    metadata = {"source": "osm_postgis", "dataset_id": "2026-test", "timestamp": "2026-01-01"}
    graph = object()

    with patch("server.services.generator.core_logic._fetch_osm_tiled", side_effect=RuntimeError("timeout")), \
         patch("server.services.generator.core_logic.local_source_metadata", return_value=metadata), \
         patch("server.services.generator.core_logic.osm_postgis.fetch_houses_in_boundary", return_value=[(1.0, 2.0)]) as houses, \
         patch("server.services.generator.core_logic.osm_postgis.fetch_road_graph", return_value=graph) as roads:
        result = _fetch_generation_data(boundary, {"lat": -6.2, "lon": 106.8}, decision)

    assert result[0:2] == ([(1.0, 2.0)], graph)
    assert result[2]["source"] == "osm_postgis"
    assert result[2]["dataset_id"] == "2026-test"
    assert result[2]["reason"] == "fallback penuh setelah online gagal: timeout"
    houses.assert_called_once()
    roads.assert_called_once()


def test_explicit_online_mode_does_not_silently_switch_to_local(monkeypatch):
    monkeypatch.setenv("OSM_SOURCE_MODE", "online")
    boundary = box(106.80, -6.20, 106.81, -6.19)
    decision = SourceDecision("online", "explicit", 1.0, 1)

    with patch("server.services.generator.core_logic._fetch_osm_tiled", side_effect=RuntimeError("timeout")), \
         patch("server.services.generator.core_logic.osm_postgis.fetch_houses_in_boundary") as houses:
        try:
            _fetch_generation_data(boundary, {"lat": -6.2, "lon": 106.8}, decision)
        except RuntimeError as exc:
            assert str(exc) == "timeout"
        else:
            raise AssertionError("online error should be raised")
    houses.assert_not_called()
