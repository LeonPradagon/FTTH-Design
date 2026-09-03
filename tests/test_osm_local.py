"""Regression tests for OSM request configuration."""

import osmnx as ox
from osmnx._errors import InsufficientResponseError
from shapely.geometry import box
from unittest.mock import patch

from server.services.generator import osm_local


def test_osmnx_http_timeout_is_bounded_for_overpass_fallback():
    """Overpass fallback must not inherit OSMnx's 180-second default."""
    assert osm_local.OSM_REQUEST_TIMEOUT_SECONDS == 15
    assert ox.settings.requests_timeout == 15


def test_osm_cache_keys_are_unique_for_disconnected_geometries():
    first = box(112.40, -7.50, 112.41, -7.49)
    second = box(112.42, -7.48, 112.43, -7.47)

    assert osm_local._geometry_cache_hash(first) != osm_local._geometry_cache_hash(second)


def test_empty_osm_feature_area_is_not_treated_as_provider_failure():
    with patch.object(
        ox,
        "features_from_polygon",
        side_effect=InsufficientResponseError("No matching features"),
    ):
        features = osm_local._safe_native_features(box(106.0, -6.0, 106.01, -5.99), {"building": True})

    assert features.empty


def test_native_osm_xml_buildings_are_parsed():
    xml = b"""<osm>
      <node id="1" lat="-7.35" lon="112.72" />
      <node id="2" lat="-7.35" lon="112.721" />
      <node id="3" lat="-7.351" lon="112.721" />
      <node id="4" lat="-7.351" lon="112.72" />
      <way id="10">
        <nd ref="1" /><nd ref="2" /><nd ref="3" /><nd ref="4" /><nd ref="1" />
        <tag k="building" v="yes" />
      </way>
    </osm>"""

    features = osm_local._buildings_from_osm_xml(xml)

    assert len(features) == 1
    assert features.iloc[0].geometry.geom_type == "Polygon"
