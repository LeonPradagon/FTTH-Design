"""Select the online OSM/Overpass or local PostGIS OSM provider.

The automatic mode uses online OSM for small requests and the local snapshot
for large requests.  A source decision is made once per generation; providers
are never mixed within one data acquisition stage.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Any

from server.core.errors import OSMUnavailableError
from server.services.generator import osm_local, osm_postgis


DEFAULT_ONLINE_MAX_AREA_KM2 = 25.0
DEFAULT_ONLINE_MAX_TILES = 4
DEFAULT_TILE_SIZE_DEG = 0.05


@dataclass(frozen=True)
class SourceDecision:
    source: str
    reason: str
    area_km2: float
    tile_count: int

    @property
    def signature(self) -> str:
        return self.source


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def boundary_area_km2(boundary) -> float:
    """Approximate WGS84 area for source selection only."""
    minx, miny, maxx, maxy = boundary.bounds
    width_km = (maxx - minx) * 111.32 * max(0.05, math.cos(math.radians((miny + maxy) / 2)))
    height_km = (maxy - miny) * 111.32
    return abs(width_km * height_km)


def boundary_tile_count(boundary) -> int:
    minx, miny, maxx, maxy = boundary.bounds
    width = max(1, math.ceil(round((maxx - minx) / DEFAULT_TILE_SIZE_DEG, 8)))
    height = max(1, math.ceil(round((maxy - miny) / DEFAULT_TILE_SIZE_DEG, 8)))
    return width * height


def choose_source(boundary) -> SourceDecision:
    mode = os.getenv("OSM_SOURCE_MODE", "auto").strip().lower()
    area_km2 = boundary_area_km2(boundary)
    tile_count = boundary_tile_count(boundary)
    max_area = max(0.1, _float_env("OSM_ONLINE_MAX_AREA_KM2", DEFAULT_ONLINE_MAX_AREA_KM2))
    max_tiles = max(1, _int_env("OSM_ONLINE_MAX_TILES", DEFAULT_ONLINE_MAX_TILES))

    if mode == "online":
        return SourceDecision("online", "mode online dipilih secara eksplisit", area_km2, tile_count)
    if mode == "local":
        return SourceDecision("local", "mode local dipilih secara eksplisit", area_km2, tile_count)
    if mode not in {"", "auto"}:
        raise OSMUnavailableError(
            message="OSM_SOURCE_MODE harus bernilai auto, online, atau local.",
            details={"value": mode},
        )
    if area_km2 <= max_area and tile_count <= max_tiles:
        return SourceDecision(
            "online",
            f"boundary kecil ({area_km2:.2f} km², {tile_count} tile)",
            area_km2,
            tile_count,
        )
    return SourceDecision(
        "local",
        f"boundary besar ({area_km2:.2f} km², {tile_count} tile)",
        area_km2,
        tile_count,
    )


def local_fallback_enabled() -> bool:
    return os.getenv("OSM_LOCAL_FALLBACK_ON_ONLINE_FAILURE", "true").strip().lower() in {
        "1", "true", "yes", "on"
    }


def local_source_metadata(boundary) -> dict[str, Any]:
    return osm_postgis.source_metadata(boundary)


def online_source_metadata(reason: str) -> dict[str, Any]:
    from datetime import datetime, timezone

    return {
        "source": "osm_online",
        "dataset_id": None,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "reason": reason,
    }


def fetch_houses_in_boundary(polygon, force_refresh=False):
    decision = choose_source(polygon)
    if decision.source == "local":
        return osm_postgis.fetch_houses_in_boundary(polygon, force_refresh=force_refresh)
    return osm_local.fetch_houses_in_boundary(polygon, force_refresh=force_refresh)


def fetch_road_graph(boundary, pop=None, buffer_deg=0.002, force_refresh=False, include_pop=True):
    decision = choose_source(boundary)
    if decision.source == "local":
        return osm_postgis.fetch_road_graph(
            boundary,
            pop=pop,
            buffer_deg=buffer_deg,
            force_refresh=force_refresh,
            include_pop=include_pop,
        )
    return osm_local.fetch_road_graph(
        boundary,
        pop=pop,
        buffer_deg=buffer_deg,
        force_refresh=force_refresh,
        include_pop=include_pop,
    )


def find_strategic_pop(boundary, buffer_deg=0.01):
    decision = choose_source(boundary)
    if decision.source == "local":
        return osm_postgis.find_strategic_pop(boundary, buffer_deg=buffer_deg)
    return osm_local.find_strategic_pop(boundary, buffer_deg=buffer_deg)
