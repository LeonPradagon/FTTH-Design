import unittest
from unittest.mock import patch

import networkx as nx
from shapely.geometry import LineString
from shapely.geometry import box

from backend.services.generator.osm_local import (
    NativeOsmApiError,
    _fetch_native_graph,
    _filter_driveable_edges,
    _safe_native_graph,
)
from backend.services.generator.routing import (
    ROUTE_PROFILE_DISTRIBUTION,
    ROUTE_PROFILE_FEEDER,
    route_along_road,
)


def _add_bidirectional_edge(graph, start, end, length, highway, osmid):
    start_xy = (graph.nodes[start]["x"], graph.nodes[start]["y"])
    end_xy = (graph.nodes[end]["x"], graph.nodes[end]["y"])
    graph.add_edge(
        start,
        end,
        length=length,
        highway=highway,
        osmid=osmid,
        geometry=LineString([start_xy, end_xy]),
    )
    graph.add_edge(
        end,
        start,
        length=length,
        highway=highway,
        osmid=osmid,
        geometry=LineString([end_xy, start_xy]),
    )


class RoadRoutingTests(unittest.TestCase):
    def test_feeder_prefers_main_road_and_distribution_prefers_shortest_road(self):
        graph = nx.MultiDiGraph(crs="EPSG:4326")
        for node, (x, y) in {
            "start": (0.0, 0.0),
            "end": (0.01, 0.0),
            "upper_left": (0.0, 0.001),
            "upper_right": (0.01, 0.001),
        }.items():
            graph.add_node(node, x=x, y=y)

        _add_bidirectional_edge(
            graph, "start", "end", 1000, "residential", 1
        )
        _add_bidirectional_edge(
            graph, "start", "upper_left", 100, "primary", 2
        )
        _add_bidirectional_edge(
            graph, "upper_left", "upper_right", 1000, "primary", 3
        )
        _add_bidirectional_edge(
            graph, "upper_right", "end", 100, "primary", 4
        )

        distribution = route_along_road(
            graph,
            (0.0, 0.0),
            (0.0, 0.01),
            profile=ROUTE_PROFILE_DISTRIBUTION,
        )
        feeder = route_along_road(
            graph,
            (0.0, 0.0),
            (0.0, 0.01),
            profile=ROUTE_PROFILE_FEEDER,
        )

        self.assertTrue(all(abs(lat) < 1e-12 for lat, _lon in distribution))
        self.assertIn((0.001, 0.0), feeder)
        self.assertIn((0.001, 0.01), feeder)

    def test_parallel_edges_are_not_treated_as_the_same_road(self):
        graph = nx.MultiGraph(crs="EPSG:4326")
        graph.add_node("a", x=0.0, y=0.0)
        graph.add_node("b", x=0.01, y=0.0)
        graph.add_edge(
            "a",
            "b",
            key=0,
            length=1000,
            highway="residential",
            osmid=10,
            geometry=LineString([(0.0, 0.0), (0.01, 0.0)]),
        )
        graph.add_edge(
            "a",
            "b",
            key=1,
            length=1200,
            highway="residential",
            osmid=11,
            geometry=LineString([(0.0, 0.0), (0.005, 0.002), (0.01, 0.0)]),
        )

        path = route_along_road(graph, (0.0, 0.004), (0.002, 0.005))

        self.assertTrue((0.0, 0.0) in path or (0.0, 0.01) in path)

    def test_non_vehicle_edges_are_removed(self):
        graph = nx.MultiDiGraph(crs="EPSG:4326")
        for index in range(4):
            graph.add_node(index, x=float(index), y=0.0)
        graph.add_edge(0, 1, highway="residential", length=1)
        graph.add_edge(1, 2, highway="footway", length=1)
        graph.add_edge(2, 3, railway="rail", length=1)

        filtered = _filter_driveable_edges(graph)

        self.assertEqual(list(filtered.edges()), [(0, 1)])

    def test_native_osm_recursively_splits_dense_tiles(self):
        requested_bounds = []

        def fetch_xml(bounds):
            requested_bounds.append(bounds)
            if bounds[2] - bounds[0] > 0.26:
                raise NativeOsmApiError(400, "too many nodes", bounds)
            return repr(bounds).encode("ascii")

        def graph_from_xml(xml_data):
            tile_id = xml_data.decode("ascii")
            graph = nx.MultiDiGraph(crs="EPSG:4326")
            graph.add_node(f"{tile_id}-a", x=0.0, y=0.0)
            graph.add_node(f"{tile_id}-b", x=0.001, y=0.0)
            graph.add_edge(
                f"{tile_id}-a",
                f"{tile_id}-b",
                length=1,
                highway="residential",
            )
            return graph

        with (
            patch(
                "backend.services.generator.osm_local._fetch_osm_xml",
                side_effect=fetch_xml,
            ),
            patch(
                "backend.services.generator.osm_local._graph_from_xml_bytes",
                side_effect=graph_from_xml,
            ),
        ):
            graph = _fetch_native_graph((0.0, 0.0, 1.0, 1.0))

        self.assertEqual(graph.number_of_edges(), 16)
        self.assertEqual(len(requested_bounds), 21)  # 1 + 4 + 16 requests.

    def test_native_failure_falls_back_to_overpass(self):
        overpass_graph = nx.MultiDiGraph(crs="EPSG:4326")
        overpass_graph.add_node(1, x=0.0, y=0.0)
        overpass_graph.add_node(2, x=0.001, y=0.0)
        overpass_graph.add_edge(1, 2, length=1, highway="residential")

        with (
            patch(
                "backend.services.generator.osm_local._fetch_native_graph",
                side_effect=NativeOsmApiError(
                    400, "too many nodes", (0.0, 0.0, 1.0, 1.0)
                ),
            ),
            patch(
                "backend.services.generator.osm_local.ox.graph_from_polygon",
                return_value=overpass_graph,
            ) as overpass_fetch,
        ):
            graph = _safe_native_graph(box(0.0, 0.0, 1.0, 1.0))

        self.assertEqual(graph.number_of_edges(), 1)
        overpass_fetch.assert_called_once()


if __name__ == "__main__":
    unittest.main()
