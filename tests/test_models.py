"""Tests for data models and GenerationConfig."""

import pytest
from pydantic import ValidationError

from backend.services.generator.generation_config import GenerationConfig
from backend.services.generator.models import Splitter, ODP, ODC


class TestGenerationConfig:
    def test_defaults(self):
        config = GenerationConfig()
        assert config.odp_capacity == 10
        assert config.odc_capacity == 4
        assert config.max_odp_radius_m == 150.0
        assert config.max_odc_radius_m == 500.0
        assert config.max_feeder_length_m == 2000.0
        assert config.max_distribution_length_m == 500.0
        assert config.snapping_distance_m == 50.0
        assert config.routing_strategy == "shortest"

    def test_custom_values(self):
        config = GenerationConfig(
            odp_capacity=8,
            odc_capacity=6,
            max_odp_radius_m=200.0,
            routing_strategy="priority_road",
        )
        assert config.odp_capacity == 8
        assert config.odc_capacity == 6
        assert config.max_odp_radius_m == 200.0
        assert config.routing_strategy == "priority_road"

    def test_invalid_capacity_zero(self):
        with pytest.raises(ValidationError):
            GenerationConfig(odp_capacity=0)

    def test_invalid_capacity_negative(self):
        with pytest.raises(ValidationError):
            GenerationConfig(odc_capacity=-1)

    def test_invalid_routing_strategy(self):
        with pytest.raises(ValidationError):
            GenerationConfig(routing_strategy="invalid")

    def test_model_dump(self):
        config = GenerationConfig(odp_capacity=8)
        d = config.model_dump()
        assert isinstance(d, dict)
        assert d["odp_capacity"] == 8
        assert "routing_strategy" in d

    def test_from_json(self):
        config = GenerationConfig.model_validate_json(
            '{"odp_capacity": 12, "odc_capacity": 6}'
        )
        assert config.odp_capacity == 12
        assert config.odc_capacity == 6
        # Unspecified fields should use defaults
        assert config.max_odp_radius_m == 150.0


class TestSplitter:
    def test_creation(self):
        s = Splitter(ratio="1:10", location="ODP")
        assert s.ratio == "1:10"
        assert s.location == "ODP"


class TestODP:
    def test_creation(self):
        odp = ODP(
            id="ODP-001",
            lat=-6.12,
            lon=106.15,
            houses=[(-6.121, 106.151)],
            splitter=Splitter(ratio="1:10", location="ODP"),
        )
        assert odp.id == "ODP-001"
        assert len(odp.houses) == 1

    def test_default_houses(self):
        odp = ODP(id="ODP-001", lat=0.0, lon=0.0)
        assert odp.houses == []
        assert odp.splitter is None


class TestODC:
    def test_creation(self):
        odc = ODC(
            id="ODC-001",
            lat=-6.119,
            lon=106.149,
            odps=[],
            splitter=Splitter(ratio="1:4", location="ODC"),
            closure_id="CL-001",
        )
        assert odc.id == "ODC-001"
        assert odc.closure_id == "CL-001"
        assert odc.odps == []

    def test_default_fields(self):
        odc = ODC(id="ODC-001", lat=0.0, lon=0.0)
        assert odc.odps == []
        assert odc.splitter is None
        assert odc.closure_id is None
