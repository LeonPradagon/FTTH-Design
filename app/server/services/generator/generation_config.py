"""Configurable parameters for FTTH network design generation.

Every parameter that was previously hard-coded in the clustering / routing
pipeline is exposed here with a sensible default so that callers can override
individual values without breaking existing behaviour.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class RoutingStrategy(str, Enum):
    """Available routing cost strategies."""

    SHORTEST = "shortest"
    PRIORITY_ROAD = "priority_road"


# ── Algorithm / generator version constants ─────────────────────────
ALGORITHM_VERSION = "1.0.0"
GENERATOR_VERSION = "1.0.0"


class GenerationConfig(BaseModel):
    """All tuneable knobs for FTTH design generation.

    Every field carries a default that matches the value previously hard-coded
    in the codebase so that existing callers (CLI, API without explicit config)
    keep producing the same output.
    """

    # ── Capacity ────────────────────────────────────────────────────
    odp_capacity: int = Field(
        default=10,
        ge=1,
        le=64,
        description="Maximum number of houses (HC) served by a single ODP.",
    )
    odc_capacity: int = Field(
        default=4,
        ge=1,
        le=32,
        description="Maximum number of ODPs served by a single ODC.",
    )

    include_homepass: bool = Field(
        default=True,
        description="Include HC points and drop cables in the KMZ export.",
    )
    force_refresh_osm: bool = Field(
        default=False,
        description="Ignore cache OSM yang masih tersedia dan mengambil data terbaru.",
    )

    # ── Radius limits ───────────────────────────────────────────────
    max_odp_radius_m: float = Field(
        default=150.0,
        ge=10.0,
        le=1000.0,
        description="Maximum allowed distance (m) between an ODP and its farthest house.",
    )
    max_odc_radius_m: float = Field(
        default=500.0,
        ge=50.0,
        le=5000.0,
        description="Maximum allowed distance (m) between an ODC and its farthest ODP.",
    )

    # ── Cable length limits ─────────────────────────────────────────
    max_feeder_length_m: float = Field(
        default=2000.0,
        ge=100.0,
        le=20000.0,
        description="Maximum allowed feeder cable length (m) from OLT/POP to ODC.",
    )
    max_distribution_length_m: float = Field(
        default=500.0,
        ge=50.0,
        le=5000.0,
        description="Maximum allowed distribution cable length (m) from ODC to ODP.",
    )

    # ── Snapping ────────────────────────────────────────────────────
    snapping_distance_m: float = Field(
        default=50.0,
        ge=5.0,
        le=500.0,
        description="Maximum distance (m) to snap a generated point to the nearest road.",
    )

    # ── Routing ─────────────────────────────────────────────────────
    routing_strategy: Literal["shortest", "priority_road"] = Field(
        default="shortest",
        description="Routing cost strategy: 'shortest' uses raw distance, 'priority_road' penalises minor roads.",
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "odp_capacity": 10,
                "odc_capacity": 4,
                "max_odp_radius_m": 150.0,
                "max_odc_radius_m": 500.0,
                "max_feeder_length_m": 2000.0,
                "max_distribution_length_m": 500.0,
                "snapping_distance_m": 50.0,
                "routing_strategy": "shortest",
            }
        }
    }
