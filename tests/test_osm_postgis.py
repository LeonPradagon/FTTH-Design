"""Unit tests for PostGIS provider row decoding."""

from unittest.mock import patch

from shapely import wkb
from shapely.geometry import LineString, Point, Polygon

from server.services.generator.osm_postgis import _load_geometries, fetch_road_graph


def test_load_geometries_decodes_single_column_database_rows():
    geometry = Point(106.825, -6.225)

    result = _load_geometries([(wkb.dumps(geometry),)])

    assert result == [geometry]


def test_local_road_graph_declares_its_postgis_coordinate_reference():
    line = LineString([(106.0, -6.0), (106.001, -6.0)])

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def execute(self, *_):
            pass

        def fetchall(self):
            return [("way:1", 1, 2, 0, wkb.dumps(line), "residential", 111.0, False, None,
                     106.0, -6.0, 106.001, -6.0)]

    class Connection:
        def cursor(self):
            return Cursor()

        def close(self):
            pass

    with patch("server.services.generator.osm_postgis.active_dataset_for_boundary", return_value={"dataset_id": "fixture"}), \
         patch("server.services.generator.osm_postgis._connect", return_value=Connection()):
        graph = fetch_road_graph(Polygon([(106, -6), (106.002, -6), (106.002, -5.999), (106, -5.999)]))

    assert graph.graph["crs"] == "EPSG:4326"
