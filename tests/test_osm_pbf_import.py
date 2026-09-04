"""Unit tests for PBF importer normalization without requiring PostGIS."""

import geopandas as gpd
from shapely.geometry import LineString, Point, Polygon

from server.scripts.import_osm_pbf import _edge_rows, _insert_many, _node_rows, _poi_rows


class _RecordingCursor:
    def __init__(self, connection):
        self.connection = connection
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def executemany(self, statement, rows):
        self.calls.append((statement, list(rows)))


class _RecordingConnection:
    def __init__(self):
        self.commit_count = 0
        self.cursor_instance = _RecordingCursor(self)

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.commit_count += 1


def test_insert_many_does_not_commit_each_batch():
    connection = _RecordingConnection()

    _insert_many(connection, "INSERT test VALUES (%s)", [(1,), (2,), (3,)], chunk_size=2)

    assert [len(call[1]) for call in connection.cursor_instance.calls] == [2, 1]
    assert connection.commit_count == 0


def test_importer_normalizes_network_rows():
    nodes = gpd.GeoDataFrame(
        [{"id": 1, "geometry": Point(106.8, -6.2)}, {"id": 2, "geometry": Point(106.81, -6.2)}],
        geometry="geometry",
        crs="EPSG:4326",
    )
    edges = gpd.GeoDataFrame(
        [{
            "id": 10,
            "u": 1,
            "v": 2,
            "highway": "residential",
            "length": 100.0,
            "geometry": LineString([(106.8, -6.2), (106.81, -6.2)]),
        }],
        geometry="geometry",
        crs="EPSG:4326",
    )

    node_rows = _node_rows("2026-test", nodes)
    edge_rows = _edge_rows("2026-test", edges)

    assert len(node_rows) == 2
    assert edge_rows[0][0:5] == ("2026-test", "10:0", 1, 2, 0)
    assert edge_rows[0][7] == 100.0


def test_importer_classifies_supported_pois():
    pois = gpd.GeoDataFrame(
        [{"id": 1, "railway": "station", "name": "Station", "geometry": Point(106.8, -6.2)},
         {"id": 2, "office": "company", "name": "Office", "geometry": Point(106.81, -6.2)},
         {"id": 3, "building": "yes", "geometry": Polygon([(106.8, -6.2), (106.801, -6.2), (106.801, -6.199), (106.8, -6.199)])}],
        geometry="geometry",
        crs="EPSG:4326",
    )

    rows = _poi_rows("2026-test", pois)

    assert [row[2] for row in rows] == ["station", "office"]
