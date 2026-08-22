"""Tests for core generator logic (saving/loading state)."""

import pytest
import os
import json
import tempfile
from backend.services.generator.core_logic import save_design_state, load_design_state
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
