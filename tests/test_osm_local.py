"""Regression tests for OSM request configuration."""

import osmnx as ox
from shapely.geometry import box

from server.services.generator import osm_local


def test_osmnx_http_timeout_is_bounded_for_overpass_fallback():
    """Overpass fallback must not inherit OSMnx's 180-second default."""
    assert osm_local.OSM_REQUEST_TIMEOUT_SECONDS == 15
    assert ox.settings.requests_timeout == 15


def test_osm_cache_keys_are_unique_for_disconnected_geometries():
    first = box(112.40, -7.50, 112.41, -7.49)
    second = box(112.42, -7.48, 112.43, -7.47)

    assert osm_local._geometry_cache_hash(first) != osm_local._geometry_cache_hash(second)
