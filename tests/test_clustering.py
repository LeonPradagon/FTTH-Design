"""Tests for the capacitated clustering algorithm and build_design pipeline."""

import pytest

from backend.services.generator.clustering import (
    capacitated_clustering,
    centroid_of,
    build_design,
)
from backend.services.generator.generation_config import GenerationConfig


class TestCapacitatedClustering:
    """Test the low-level clustering function."""

    def test_empty_input(self):
        assert capacitated_clustering([], 10) == []

    def test_single_point(self):
        clusters = capacitated_clustering([(0, 0)], 10)
        assert len(clusters) == 1
        assert clusters[0] == [0]

    def test_under_capacity(self):
        points = [(i, i) for i in range(5)]
        clusters = capacitated_clustering(points, 10)
        assert len(clusters) == 1
        assert sorted(clusters[0]) == [0, 1, 2, 3, 4]

    def test_exact_capacity(self):
        points = [(i, i) for i in range(10)]
        clusters = capacitated_clustering(points, 10)
        assert len(clusters) == 1

    def test_over_capacity_splits(self):
        points = [(i, i) for i in range(25)]
        clusters = capacitated_clustering(points, 10)
        assert len(clusters) == 3
        for cluster in clusters:
            assert len(cluster) <= 10

    def test_all_points_assigned(self):
        """Every input point must appear in exactly one cluster."""
        points = [(i * 0.1, i * 0.2) for i in range(37)]
        clusters = capacitated_clustering(points, 8)
        all_indices = sorted(idx for cluster in clusters for idx in cluster)
        assert all_indices == list(range(37))

    def test_deterministic(self):
        """Same input → same output (seed=42)."""
        points = [(i * 0.3, i * 0.7) for i in range(30)]
        c1 = capacitated_clustering(points, 10)
        c2 = capacitated_clustering(points, 10)
        assert c1 == c2


class TestCentroidOf:
    def test_single_point(self):
        c = centroid_of([(5.0, 10.0)])
        assert c == pytest.approx((5.0, 10.0))

    def test_symmetric(self):
        c = centroid_of([(0, 0), (2, 2)])
        assert c == pytest.approx((1.0, 1.0))


class TestBuildDesign:
    """Integration-level tests for the full clustering pipeline."""

    def test_default_config(self, sample_houses):
        odcs = build_design(houses=sample_houses, road_graph=None)
        assert len(odcs) > 0
        total_houses = sum(
            len(odp.houses) for odc in odcs for odp in odc.odps
        )
        assert total_houses == len(sample_houses)

    def test_custom_config(self, sample_houses):
        config = GenerationConfig(odp_capacity=5, odc_capacity=2)
        odcs = build_design(houses=sample_houses, road_graph=None, config=config)
        # With capacity 5, 20 houses → 4 ODPs
        total_odps = sum(len(odc.odps) for odc in odcs)
        assert total_odps == 4
        for odc in odcs:
            for odp in odc.odps:
                assert len(odp.houses) <= 5

    def test_legacy_params_backward_compat(self, sample_houses):
        """Passing odp_capacity/odc_capacity integers still works."""
        odcs = build_design(
            houses=sample_houses,
            odp_capacity=10,
            odc_capacity=4,
            road_graph=None,
        )
        assert len(odcs) > 0

    def test_splitter_ratios_match_config(self, sample_houses):
        config = GenerationConfig(odp_capacity=5, odc_capacity=3)
        odcs = build_design(houses=sample_houses, road_graph=None, config=config)
        for odc in odcs:
            assert odc.splitter.ratio == "1:3"
            for odp in odc.odps:
                assert odp.splitter.ratio == "1:5"

    def test_single_house(self, single_house):
        odcs = build_design(houses=single_house, road_graph=None)
        assert len(odcs) == 1
        assert len(odcs[0].odps) == 1
        assert len(odcs[0].odps[0].houses) == 1

    def test_deterministic_output(self, sample_houses):
        """Same input + config → same design."""
        config = GenerationConfig(odp_capacity=10, odc_capacity=4)
        odcs1 = build_design(houses=sample_houses, road_graph=None, config=config)
        odcs2 = build_design(houses=sample_houses, road_graph=None, config=config)
        assert len(odcs1) == len(odcs2)
        for o1, o2 in zip(odcs1, odcs2):
            assert o1.id == o2.id
            assert o1.lat == o2.lat
            assert o1.lon == o2.lon
