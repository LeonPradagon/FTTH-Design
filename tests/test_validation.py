"""Tests for the post-generation validation engine."""

import pytest

from backend.services.generator.generation_config import GenerationConfig
from backend.services.generator.models import Splitter, ODP, ODC
from backend.services.generator.validation import (
    ValidationResult,
    ValidationIssue,
    validate_design,
    compute_design_stats,
)


class TestValidationResult:
    def test_empty_is_pass(self):
        r = ValidationResult()
        assert r.status == "PASS"
        assert r.summary == {"errors": 0, "warnings": 0, "info": 0}

    def test_warning_upgrades_status(self):
        r = ValidationResult()
        r.add(ValidationIssue("WARNING", "TEST", "test warning"))
        assert r.status == "WARNING"

    def test_error_upgrades_status(self):
        r = ValidationResult()
        r.add(ValidationIssue("WARNING", "W1", "warn"))
        r.add(ValidationIssue("ERROR", "E1", "err"))
        assert r.status == "ERROR"

    def test_summary_counts(self):
        r = ValidationResult()
        r.add(ValidationIssue("ERROR", "E1", "e"))
        r.add(ValidationIssue("WARNING", "W1", "w"))
        r.add(ValidationIssue("WARNING", "W2", "w"))
        r.add(ValidationIssue("INFO", "I1", "i"))
        assert r.summary == {"errors": 1, "warnings": 2, "info": 1}

    def test_to_dict(self):
        r = ValidationResult()
        r.add(ValidationIssue("WARNING", "TEST", "msg", {"key": "val"}))
        d = r.to_dict()
        assert d["status"] == "WARNING"
        assert len(d["issues"]) == 1
        assert d["issues"][0]["code"] == "TEST"
        assert d["issues"][0]["details"] == {"key": "val"}


class TestValidateDesign:
    """Test individual validation rules through the public validate_design API."""

    def _make_design(
        self,
        n_odps=2,
        n_houses_per_odp=3,
        odp_capacity=10,
        odc_capacity=4,
    ):
        """Helper to build a simple valid design."""
        config = GenerationConfig(
            odp_capacity=odp_capacity, odc_capacity=odc_capacity
        )
        odps = []
        for i in range(n_odps):
            houses = [
                (-6.12 + i * 0.0005 + j * 0.0001, 106.15 + i * 0.0005 + j * 0.0001)
                for j in range(n_houses_per_odp)
            ]
            # Place ODP at centroid of its houses
            odp_lat = sum(h[0] for h in houses) / len(houses)
            odp_lon = sum(h[1] for h in houses) / len(houses)
            odps.append(
                ODP(
                    id=f"ODP-{i+1:03d}",
                    lat=odp_lat,
                    lon=odp_lon,
                    houses=houses,
                    splitter=Splitter(ratio=f"1:{odp_capacity}", location="ODP"),
                )
            )
        # Place ODC at midpoint of all ODPs
        odc_lat = sum(o.lat for o in odps) / len(odps) if odps else -6.12
        odc_lon = sum(o.lon for o in odps) / len(odps) if odps else 106.15
        odc = ODC(
            id="ODC-001",
            lat=odc_lat,
            lon=odc_lon,
            odps=odps,
            splitter=Splitter(ratio=f"1:{odc_capacity}", location="ODC"),
            closure_id="CL-001",
        )
        pop = {"name": "POP-001", "lat": -6.115, "lon": 106.148}
        return pop, [odc], config

    def test_valid_design_passes(self):
        pop, odcs, config = self._make_design()
        result = validate_design(pop, odcs, config)
        assert result.status == "PASS"

    def test_odp_over_capacity(self):
        pop, odcs, config = self._make_design(
            n_odps=1, n_houses_per_odp=15, odp_capacity=10
        )
        result = validate_design(pop, odcs, config)
        codes = [i.code for i in result.issues]
        assert "ODP_OVER_CAPACITY" in codes

    def test_odc_over_capacity(self):
        pop, odcs, config = self._make_design(
            n_odps=6, n_houses_per_odp=2, odc_capacity=4
        )
        result = validate_design(pop, odcs, config)
        codes = [i.code for i in result.issues]
        assert "ODC_OVER_CAPACITY" in codes

    def test_empty_odc_error(self):
        config = GenerationConfig()
        odc = ODC(
            id="ODC-001",
            lat=-6.119,
            lon=106.149,
            odps=[],
            splitter=Splitter(ratio="1:4", location="ODC"),
            closure_id="CL-001",
        )
        pop = {"name": "POP-001", "lat": -6.115, "lon": 106.148}
        result = validate_design(pop, [odc], config)
        assert result.status == "ERROR"
        codes = [i.code for i in result.issues]
        assert "ODC_EMPTY" in codes

    def test_empty_odp_warning(self):
        config = GenerationConfig()
        odp = ODP(
            id="ODP-001",
            lat=-6.12,
            lon=106.15,
            houses=[],
            splitter=Splitter(ratio="1:10", location="ODP"),
        )
        odc = ODC(
            id="ODC-001",
            lat=-6.119,
            lon=106.149,
            odps=[odp],
            splitter=Splitter(ratio="1:4", location="ODC"),
            closure_id="CL-001",
        )
        pop = {"name": "POP-001", "lat": -6.115, "lon": 106.148}
        result = validate_design(pop, [odc], config)
        codes = [i.code for i in result.issues]
        assert "ODP_EMPTY" in codes

    def test_radius_exceeded(self):
        """Place a house very far from its ODP to trigger radius warning."""
        config = GenerationConfig(max_odp_radius_m=50.0)
        odp = ODP(
            id="ODP-001",
            lat=-6.12,
            lon=106.15,
            houses=[(-6.12, 106.15), (-6.13, 106.16)],  # second house is ~1.4 km away
            splitter=Splitter(ratio="1:10", location="ODP"),
        )
        odc = ODC(
            id="ODC-001",
            lat=-6.119,
            lon=106.149,
            odps=[odp],
            splitter=Splitter(ratio="1:4", location="ODC"),
            closure_id="CL-001",
        )
        pop = {"name": "POP-001", "lat": -6.115, "lon": 106.148}
        result = validate_design(pop, [odc], config)
        codes = [i.code for i in result.issues]
        assert "ODP_RADIUS_EXCEEDED" in codes


class TestComputeDesignStats:
    def test_basic_stats(self):
        odp = ODP(
            id="ODP-001",
            lat=-6.12,
            lon=106.15,
            houses=[(-6.121, 106.151), (-6.122, 106.152)],
            splitter=Splitter(ratio="1:10", location="ODP"),
        )
        odc = ODC(
            id="ODC-001",
            lat=-6.119,
            lon=106.149,
            odps=[odp],
            splitter=Splitter(ratio="1:4", location="ODC"),
            closure_id="CL-001",
        )
        pop = {"name": "POP-001", "lat": -6.115, "lon": 106.148}
        stats = compute_design_stats(pop, [odc])
        assert stats["odc_count"] == 1
        assert stats["odp_count"] == 1
        assert stats["customer_count"] == 2
