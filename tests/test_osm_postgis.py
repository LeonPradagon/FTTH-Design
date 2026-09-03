"""Unit tests for PostGIS provider row decoding."""

from shapely import wkb
from shapely.geometry import Point

from server.services.generator.osm_postgis import _load_geometries


def test_load_geometries_decodes_single_column_database_rows():
    geometry = Point(106.825, -6.225)

    result = _load_geometries([(wkb.dumps(geometry),)])

    assert result == [geometry]
