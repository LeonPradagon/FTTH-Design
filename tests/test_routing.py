"""Tests for routing algorithms."""

import pytest
from backend.services.generator.routing import (
    build_feeder_chain,
    enforce_min_distance_between_odcs,
    order_odcs_chain,
)
from backend.services.generator.models import ODC, Splitter, ODP
from backend.utils.geometry import haversine_m

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
