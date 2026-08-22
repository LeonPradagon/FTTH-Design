"""Tests for core generator logic (saving/loading state)."""

import pytest
import os
import json
import tempfile
import networkx as nx
from shapely.geometry import box
from backend.services.generator.core_logic import (
    save_design_state,
    load_design_state,
    load_network_state,
    generate_homepass_from_state,
    _fetch_osm_tiled,
)
from unittest.mock import patch
from backend.services.generator.models import ODC, ODP, Splitter

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
    assert state["distribution_segments"]["ODP-001"] == [list(point) for point in distribution["ODP-001"]]

    output = tmp_path / "homepass.kmz"
    with patch("backend.services.generator.core_logic.export_kmz") as export, patch(
        "backend.services.generator.core_logic.export_csv"
    ):
        generate_homepass_from_state(output, tmp_path / "homepass.csv", cache_dir=tmp_path)
    export.assert_called_once()
    kwargs = export.call_args.kwargs
    assert kwargs["road_graph"] is None
    assert kwargs["road_feeder"] is False
    assert kwargs["road_drop"] is False
    assert kwargs["distribution_segments"] == {"ODP-001": [list(point) for point in distribution["ODP-001"]]}


def test_legacy_cache_is_rejected_for_homepass(sample_odc, tmp_path):
    save_design_state({"name": "POP", "lat": 0, "lon": 0}, [sample_odc], cache_dir=tmp_path)
    with pytest.raises(Exception, match="generator lama|belum lengkap"):
        load_network_state(cache_dir=tmp_path)


def test_tiled_osm_normalizes_mixed_graph_types(tmp_path):
    undirected = nx.Graph()
    undirected.add_edge(1, 2, highway="residential", length=10)
    directed = nx.DiGraph()
    directed.add_edge(2, 3, highway="residential", length=10)
    with patch("backend.services.generator.core_logic._build_generation_tiles", return_value=[box(0, 0, 1, 1), box(1, 0, 2, 1)]), \
         patch("backend.services.generator.core_logic.fetch_houses_in_boundary", side_effect=[[(0.1, 0.1)], [(1.2, 2.1)]]), \
         patch("backend.services.generator.core_logic.fetch_road_graph", side_effect=[undirected, directed]):
        houses, graph = _fetch_osm_tiled(box(0, 0, 2, 1), {"lat": 0.5, "lon": 0.5}, cache_dir=tmp_path)

    assert len(houses) == 1
    assert isinstance(graph, nx.MultiDiGraph)
    assert graph.is_directed()
    assert graph.number_of_edges() == 3
