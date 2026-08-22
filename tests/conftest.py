"""Shared pytest fixtures for FTTH Design Generator tests."""

import pytest

from backend.services.generator.generation_config import GenerationConfig
from backend.services.generator.models import Splitter, ODP, ODC


# ── Sample coordinates ──────────────────────────────────────────────


@pytest.fixture
def sample_houses():
    """20 houses arranged in a rough grid (Serang area)."""
    base_lat, base_lon = -6.12, 106.15
    houses = []
    for i in range(5):
        for j in range(4):
            houses.append(
                (base_lat + i * 0.001, base_lon + j * 0.001)
            )
    return houses


@pytest.fixture
def small_houses():
    """5 houses — useful for edge-case testing."""
    return [
        (-6.120, 106.150),
        (-6.121, 106.151),
        (-6.122, 106.150),
        (-6.120, 106.152),
        (-6.121, 106.150),
    ]


@pytest.fixture
def single_house():
    """Just one house."""
    return [(-6.120, 106.150)]


@pytest.fixture
def default_config():
    """Default GenerationConfig."""
    return GenerationConfig()


@pytest.fixture
def small_config():
    """Config with small capacities (useful for testing more clusters)."""
    return GenerationConfig(odp_capacity=3, odc_capacity=2)


@pytest.fixture
def sample_pop():
    """Sample POP/OLT location."""
    return {"name": "POP-001", "lat": -6.115, "lon": 106.148}


@pytest.fixture
def sample_odcs(sample_houses, default_config):
    """Build a small set of ODCs from sample houses (no road graph)."""
    from backend.services.generator.clustering import build_design

    return build_design(
        houses=sample_houses,
        config=default_config,
        road_graph=None,
    )


@pytest.fixture
def sample_odp():
    """A single ODP with 3 houses."""
    return ODP(
        id="ODP-001",
        lat=-6.120,
        lon=106.150,
        houses=[(-6.1201, 106.1501), (-6.1202, 106.1502), (-6.1203, 106.1503)],
        splitter=Splitter(ratio="1:10", location="ODP"),
    )


@pytest.fixture
def sample_odc(sample_odp):
    """A single ODC containing one ODP."""
    return ODC(
        id="ODC-001",
        lat=-6.119,
        lon=106.149,
        odps=[sample_odp],
        splitter=Splitter(ratio="1:4", location="ODC"),
        closure_id="CL-001",
    )
