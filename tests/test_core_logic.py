"""Tests for core generator logic (saving/loading state)."""

import pytest
import os
import json
import tempfile
import networkx as nx
from shapely.geometry import box
from server.services.generator.core_logic import (
    save_design_state,
    load_design_state,
    load_network_state,
    generate_homepass_from_state,
    _fetch_osm_tiled,
    _require_distribution_connectivity,
)
from server.core.errors import RoutingFailedError
from unittest.mock import patch
from server.services.generator.models import ODC, ODP, Splitter

def test_save_and_load_design_state(sample_odc):
    pop = {"name": "POP-001", "lat": -6.115, "lon": 106.148}
    odcs = [sample_odc]

    with tempfile.TemporaryDirectory() as cache_dir:
        # Save state
        save_design_state(pop, odcs, road_graph=None, cache_dir=cache_dir)

        # Verify file exists
        state_file = os.path.join(cache_dir, "design_state.json")
        assert os.path.exists(state_file)

        # Load state
        loaded_pop, loaded_odcs = load_design_state(cache_dir=cache_dir)

        # Assert POP
        assert loaded_pop["name"] == pop["name"]

        # Assert ODCs
        assert len(loaded_odcs) == 1
        assert loaded_odcs[0].id == sample_odc.id

        # Assert ODPs
        assert len(loaded_odcs[0].odps) == 1
        assert loaded_odcs[0].odps[0].id == sample_odc.odps[0].id


def test_network_cache_contains_routes_and_homepass_does_not_route(sample_odc, tmp_path):
    pop = {"name": "POP-001", "lat": -6.115, "lon": 106.148}
    feeder = [{"from_label": "POP", "to_label": "ODC-001", "coords": [(-6.115, 106.148), (-6.119, 106.149)]}]
    distribution = {"ODP-001": [(-6.119, 106.149), (-6.120, 106.150)]}
    save_design_state(pop, [sample_odc], cache_dir=tmp_path, feeder_segments=feeder, distribution_segments=distribution)

    loaded_pop, loaded_odcs, state = load_network_state(cache_dir=tmp_path)
    assert loaded_pop == pop
    cached_distribution = state["distribution_segments"]["ODP-001"]
    assert cached_distribution["source_id"] == "ODC-001"
    assert cached_distribution["target_id"] == "ODP-001"
    assert cached_distribution["coords"] == [list(point) for point in distribution["ODP-001"]]

    output = tmp_path / "homepass.kmz"
    with patch("server.services.generator.core_logic.export_kmz") as export, patch(
        "server.services.generator.core_logic.export_csv"
    ):
        generate_homepass_from_state(output, tmp_path / "homepass.csv", cache_dir=tmp_path)
    export.assert_called_once()
    kwargs = export.call_args.kwargs
    assert kwargs["road_graph"] is None
    assert kwargs["road_feeder"] is False
    assert kwargs["road_drop"] is False
    assert kwargs["distribution_segments"]["ODP-001"]["coords"] == [
        list(point) for point in distribution["ODP-001"]
    ]


def test_network_cache_repairs_connected_but_overlong_distribution(sample_odc, tmp_path):
    pop = {"name": "POP-001", "lat": -6.115, "lon": 106.148}
    feeder = [{
        "from_label": "POP-001",
        "to_label": "ODC-001",
        "coords": [(pop["lat"], pop["lon"]), (sample_odc.lat, sample_odc.lon)],
    }]
    source = (sample_odc.lat, sample_odc.lon)
    target = (sample_odc.odps[0].lat, sample_odc.odps[0].lon)
    stale_path = [source, (source[0] + 0.006, source[1]), target]
    save_design_state(
        pop,
        [sample_odc],
        cache_dir=tmp_path,
        feeder_segments=feeder,
        distribution_segments={"ODP-001": stale_path},
    )

    repaired = {
        "source_id": "ODC-001",
        "target_id": "ODP-001",
        "coords": [list(source), list(target)],
        "length_m": 100.0,
        "routing_cost": 100.0,
        "connected": True,
    }
    with patch("server.services.generator.core_logic.load_road_graph", return_value=object()), \
         patch("server.services.generator.core_logic.rebalance_odps_by_road_connectivity") as rebalance, \
         patch("server.services.generator.core_logic.build_distribution_tree", return_value={"ODP-001": repaired}) as build_tree:
        _, _, state = load_network_state(cache_dir=tmp_path)

    rebalance.assert_called_once()
    assert build_tree.call_args.kwargs["max_distance_m"] == 500.0
    assert state["distribution_segments"]["ODP-001"]["coords"] == [
        list(source),
        list(target),
    ]


def test_distribution_validation_rejects_stale_endpoint(sample_odc):
    distribution = {
        "ODP-001": {
            "source_id": "ODC-001",
            "target_id": "ODP-001",
            "coords": [
                [-6.119, 106.149],
                [-6.120, 106.151],  # target is over 100m away from the ODP
            ],
            "connected": True,
        }
    }

    with pytest.raises(RoutingFailedError, match="endpoint atau parent"):
        _require_distribution_connectivity([sample_odc], distribution)


def test_distribution_validation_rejects_parent_cycle(sample_odc):
    second = ODP(
        id="ODP-002",
        lat=-6.121,
        lon=106.151,
        houses=[],
        splitter=Splitter("1:10", "ODP"),
    )
    sample_odc.odps.append(second)
    distribution = {
        "ODP-001": {
            "source_id": "ODP-002",
            "target_id": "ODP-001",
            "coords": [[-6.121, 106.151], [-6.120, 106.150]],
            "connected": True,
        },
        "ODP-002": {
            "source_id": "ODP-001",
            "target_id": "ODP-002",
            "coords": [[-6.120, 106.150], [-6.121, 106.151]],
            "connected": True,
        },
    }

    with pytest.raises(RoutingFailedError, match="endpoint atau parent"):
        _require_distribution_connectivity([sample_odc], distribution)


def test_legacy_cache_is_rejected_for_homepass(sample_odc, tmp_path):
    save_design_state({"name": "POP", "lat": 0, "lon": 0}, [sample_odc], cache_dir=tmp_path)
    with pytest.raises(Exception, match="generator lama|belum lengkap"):
        load_network_state(cache_dir=tmp_path)


def test_tiled_osm_normalizes_mixed_graph_types(tmp_path):
    undirected = nx.Graph()
    undirected.add_edge(1, 2, highway="residential", length=10)
    directed = nx.DiGraph()
    directed.add_edge(2, 3, highway="residential", length=10)
    with patch("server.services.generator.core_logic._build_generation_tiles", return_value=[box(0, 0, 1, 1), box(1, 0, 2, 1)]), \
         patch("server.services.generator.core_logic.fetch_houses_in_boundary", side_effect=[[(0.1, 0.1)], [(1.2, 2.1)]]), \
         patch("server.services.generator.core_logic.fetch_road_graph", side_effect=[undirected, directed]):
        houses, graph = _fetch_osm_tiled(box(0, 0, 2, 1), {"lat": 0.5, "lon": 0.5}, cache_dir=tmp_path)

    assert len(houses) == 1
    assert isinstance(graph, nx.MultiDiGraph)
    assert graph.is_directed()
    assert graph.number_of_edges() == 3
