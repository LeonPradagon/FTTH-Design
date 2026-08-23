"""Tests for routing algorithms."""

import pytest
import networkx as nx
from shapely.geometry import LineString, Point
from server.services.generator.routing import (
    build_feeder_chain,
    build_distribution_tree,
    enforce_min_distance_between_odcs,
    order_odcs_chain,
    prepare_road_graph,
    route_along_road,
    snap_to_road,
)
from server.services.generator.models import ODC, Splitter, ODP
from server.utils.geometry import haversine_m
from unittest.mock import patch


def test_prepare_road_graph_applies_selected_routing_strategy():
    graph = nx.MultiDiGraph()
    graph.add_node(1, x=0.0, y=0.0)
    graph.add_node(2, x=0.001, y=0.0)
    graph.add_node(3, x=0.002, y=0.0)
    graph.add_edge(1, 2, key=0, length=100.0, highway="primary")
    graph.add_edge(2, 3, key=0, length=80.0, highway="residential")

    prepare_road_graph(graph, "shortest")
    assert graph.edges[1, 2, 0]["routing_cost"] == 100.0
    assert graph.edges[2, 3, 0]["routing_cost"] == 80.0

    prepare_road_graph(graph, "priority_road")
    assert graph.edges[1, 2, 0]["routing_cost"] == 90.0
    assert graph.edges[2, 3, 0]["routing_cost"] == 140.0


def test_snap_to_road_enforces_configured_distance():
    line = LineString([(0.0, 0.001), (0.01, 0.001)])
    road_info = {
        "line": line,
        "t_deg": 0.0,
    }
    with patch("server.services.generator.routing.locate_on_road", return_value=road_info):
        with pytest.raises(ValueError, match="snapping limit"):
            snap_to_road(object(), 0.0, 0.0, max_distance_m=50.0)


def test_route_along_road_default_returns_coordinate_list():
    graph = nx.MultiDiGraph()
    graph.graph["ftth_road_profile"] = "road-priority-v4"
    line = LineString([(0.0, 0.0), (0.01, 0.0)])
    graph.add_node(1, x=0.0, y=0.0)
    graph.add_node(2, x=0.01, y=0.0)
    graph.add_edge(1, 2, key=0, geometry=line, length=1110.0, highway="primary")

    def fake_locate(_graph, lat, lon):
        return {
            "edge": (1, 2, 0),
            "line": line,
            "len_deg": line.length,
            "len_m": 1110.0,
            "t_deg": line.project(Point(lon, lat)),
        }

    with patch("server.services.generator.routing.locate_on_road", side_effect=fake_locate):
        path = route_along_road(
            graph,
            (0.0, 0.001),
            (0.0, 0.009),
            use_external_routing=False,
        )

    assert isinstance(path, list)
    assert path[0] == (0.0, 0.001)
    assert path[-1] == (0.0, 0.009)

def test_build_feeder_chain(sample_odc):
    # Single ODC
    odcs = [sample_odc]
    pop = {"name": "POP-001", "lat": -6.115, "lon": 106.148}
    
    chain, renumbered = build_feeder_chain(pop, odcs)
    # The chain should connect POP to the single ODC
    assert len(chain) == 1
    assert chain[0]["from_label"] == "POP-001"
    assert chain[0]["to_label"] == "ODC-001"
    
def test_order_odcs_chain(sample_odc):
    odcs = [sample_odc]
    pop = {"name": "POP-001", "lat": -6.115, "lon": 106.148}
    
    odc2 = ODC(
        id="ODC-002",
        lat=-6.118,
        lon=106.148,
        odps=[],
        splitter=Splitter(ratio="1:4", location="ODC"),
        closure_id="CL-002"
    )
    odcs.append(odc2)
    
    chain = order_odcs_chain(pop, odcs)
    assert len(chain) == 2

def test_enforce_min_distance_between_odcs(sample_odc):
    odc2 = ODC(
        id="ODC-002",
        lat=sample_odc.lat,
        lon=sample_odc.lon,
        odps=[],
        splitter=Splitter(ratio="1:4", location="ODC"),
        closure_id="CL-002"
    )
    
    odcs = [sample_odc, odc2]
    # Initially distance is 0
    
    # Enforce 100 meters
    moved_odcs = enforce_min_distance_between_odcs(odcs, min_dist_m=100.0)
    assert len(moved_odcs) == 2
    
    # Check if distance is now ~100m
    dist = haversine_m(moved_odcs[0].lat, moved_odcs[0].lon, moved_odcs[1].lat, moved_odcs[1].lon)
    assert 99.0 <= dist <= 101.0


def test_distribution_tree_uses_nearby_odp_as_upstream():
    odc = ODC(
        id="ODC-001",
        lat=0.0,
        lon=0.0,
        odps=[
            ODP(id="ODP-A", lat=0.001, lon=0.0),
            ODP(id="ODP-B", lat=0.002, lon=0.0),
        ],
        splitter=Splitter(ratio="1:4", location="ODC"),
    )

    def fake_route(_graph, source, target, **_kwargs):
        source_id = "ODC-001" if source == (0.0, 0.0) else ("ODP-A" if source == (0.001, 0.0) else "ODP-B")
        target_id = "ODP-A" if target == (0.001, 0.0) else ("ODP-B" if target == (0.002, 0.0) else "ODP-A")
        if {source_id, target_id} == {"ODC-001", "ODP-A"}:
            cost, length = 100.0, 100.0
        elif {source_id, target_id} == {"ODC-001", "ODP-B"}:
            cost, length = 300.0, 300.0
        else:
            cost, length = 50.0, 40.0
        return {"coords": [source, target], "length_m": length, "routing_cost": cost}

    with patch("server.services.generator.routing.route_along_road", side_effect=fake_route):
        segments = build_distribution_tree(odc, object(), max_distance_m=500.0)

    assert segments["ODP-A"]["source_id"] == "ODC-001"
    assert segments["ODP-B"]["source_id"] == "ODP-A"
    assert odc.odps[1].upstream_id == "ODP-A"
    assert all(segment["connected"] for segment in segments.values())


def test_distribution_tree_does_not_fabricate_unroutable_or_long_edges():
    odc = ODC(
        id="ODC-001",
        lat=0.0,
        lon=0.0,
        odps=[ODP(id="ODP-A", lat=0.001, lon=0.0), ODP(id="ODP-B", lat=0.002, lon=0.0)],
        splitter=Splitter(ratio="1:4", location="ODC"),
    )

    def fake_route(_graph, source, target, **_kwargs):
        if target == (0.002, 0.0):
            return {"coords": [source, target], "length_m": 600.0, "routing_cost": 600.0}
        return {"coords": [source, target], "length_m": 100.0, "routing_cost": 100.0}

    with patch("server.services.generator.routing.route_along_road", side_effect=fake_route):
        segments = build_distribution_tree(odc, object(), max_distance_m=500.0)

    assert segments["ODP-B"]["connected"] is False
    assert segments["ODP-B"]["coords"] == []
