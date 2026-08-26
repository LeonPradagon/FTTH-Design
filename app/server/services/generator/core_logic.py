"""Core generation logic — orchestrates clustering, routing, and export.

This module coordinates the full FTTH design pipeline and manages the
``design_state.json`` / ``road_graph.pkl`` caches used for regeneration.
"""

import os
import json
import pickle
import math
import time
import hashlib
import networkx as nx
from shapely.geometry import Polygon, Point, LineString, box, mapping
from server.core.logging import logger
from server.core.errors import (
    DesignStateNotFoundError,
    InvalidFileError,
    OSMUnavailableError,
    RoadGraphUnavailableError,
    RoutingFailedError,
    ExportFailedError,
)
from server.services.generator.models import Splitter, ODP, ODC
from server.services.generator.osm_local import fetch_road_graph, fetch_houses_in_boundary
from server.services.generator.routing import (
    build_feeder_segments_preserving_order,
    build_feeder_chain,
    prepare_road_graph,
    route_along_road,
    snap_to_road,
    arrange_odps_around_odc,
    rebalance_odps_by_road_connectivity,
    build_distribution_tree,
)
from server.services.generator.kml_builder import export_kmz
from server.services.generator.csv_exporter import export_csv
from server.services.generator.kml_parser import read_custom_mapped_kml, read_pop_point
from server.utils.geometry import haversine_m
from server.services.generator.progress import progress_manager

CACHE_DIR = os.path.abspath("cache")
# A cached core is only reusable when its cable geometry was produced by the
# current connectivity checks. Bumping these versions invalidates cores made
# before endpoint/parent validation was enforced.
NETWORK_STATE_VERSION = 4
CORE_MANIFEST_VERSION = 2
DEFAULT_MAX_DISTRIBUTION_LENGTH_M = 500.0


def _report_export_progress(job_id, done, total, message):
    """Publish bounded progress for the KMZ export phase.

    Kept at module scope so full, custom, and regenerate jobs all use the
    same callback without relying on a function-local name.
    """
    if not job_id:
        return
    fraction = done / total if total else 1
    percent = 85 + min(2, int(fraction * 2))
    progress_manager.update(job_id, "EXPORTING", message, percent)


def _require_distribution_connectivity(odcs, distribution_segments):
    """Fail clearly instead of exporting a design with silently missing ODPs.

    ``build_distribution_tree`` already retries valid road routes. This final
    check makes any remaining impossible connection visible to the caller and
    prevents an apparently successful KMZ from hiding an unconnected ODP.
    """
    missing = []
    invalid = []
    for odc in odcs:
        odp_by_id = {odp.id: odp for odp in odc.odps}
        valid_source_ids = set(odp_by_id) | {odc.id}
        for odp in odc.odps:
            segment = distribution_segments.get(odp.id)
            if not segment or not segment.get("connected") or len(segment.get("coords") or []) < 2:
                missing.append(f"{odp.id} (ODC {odc.id})")
                continue

            source_id = segment.get("source_id")
            target_id = segment.get("target_id")
            coords = segment.get("coords") or []
            if source_id not in valid_source_ids or target_id != odp.id:
                invalid.append(
                    f"{odp.id} (parent {source_id or '?'}, target {target_id or '?'})"
                )
                continue

            source_point = odc if source_id == odc.id else odp_by_id[source_id]
            start_error_m = haversine_m(
                coords[0][0], coords[0][1], source_point.lat, source_point.lon
            )
            end_error_m = haversine_m(
                coords[-1][0], coords[-1][1], odp.lat, odp.lon
            )
            # route_along_road explicitly restores both requested endpoints.
            # A larger mismatch means a stale/corrupt path, not a harmless
            # projection difference, and must never be exported.
            if start_error_m > 2.0 or end_error_m > 2.0:
                invalid.append(
                    f"{odp.id} (ujung {start_error_m:.1f}m/{end_error_m:.1f}m)"
                )

        # Every parent chain must terminate at this ODC. This catches a
        # segment set that has one line per ODP but still contains a cycle or
        # a parent from another ODC.
        for odp in odc.odps:
            seen = set()
            current = odp.id
            while current != odc.id:
                if current in seen:
                    invalid.append(f"{odp.id} (siklus parent)")
                    break
                seen.add(current)
                parent_segment = distribution_segments.get(current)
                parent_id = parent_segment.get("source_id") if parent_segment else None
                if not parent_segment or not parent_segment.get("connected") or parent_id not in valid_source_ids:
                    invalid.append(f"{odp.id} (rantai berhenti di {current})")
                    break
                current = parent_id
    if missing:
        preview = ", ".join(missing[:12])
        suffix = " ..." if len(missing) > 12 else ""
        raise RoutingFailedError(
            message=(
                f"{len(missing)} ODP belum tersambung ke jaringan jalan: {preview}{suffix}. "
                "Routing sudah mencoba jalan satu arah dan dua arah; periksa posisi ODP/ODC "
                "agar menempel pada jalan kendaraan yang sama. Kabel lurus otomatis tidak dibuat "
                "karena dapat melewati bangunan."
            ),
        )
    if invalid:
        preview = ", ".join(invalid[:12])
        suffix = " ..." if len(invalid) > 12 else ""
        raise RoutingFailedError(
            message=(
                f"{len(invalid)} segmen distribusi memiliki endpoint atau parent yang tidak valid: "
                f"{preview}{suffix}. Cache kabel lama dibuang; jalankan generate ulang "
                "agar setiap kabel dibangun ulang dari ODC ke ODP melalui jalan."
            ),
        )


def _build_generation_tiles(boundary, tile_size_deg=0.05, overlap_deg=0.002):
    """Split large boundaries into deterministic overlapping OSM tiles."""
    minx, miny, maxx, maxy = boundary.bounds
    start_x = math.floor(minx / tile_size_deg) * tile_size_deg
    start_y = math.floor(miny / tile_size_deg) * tile_size_deg
    tiles = []
    x = start_x
    while x < maxx:
        y = start_y
        while y < maxy:
            tile = box(x, y, x + tile_size_deg, y + tile_size_deg)
            if tile.intersects(boundary):
                tiles.append(tile.intersection(boundary.buffer(overlap_deg)))
            y += tile_size_deg
        x += tile_size_deg
    return tiles or [boundary]


def _normalize_routing_graph(graph):
    """Normalize OSM/cache graph variants before combining tiles.

    OSMnx may return an undirected graph from a warm cache while a fresh
    native query can return a directed graph. NetworkX refuses to compose
    those variants, so the tiled pipeline uses one canonical MultiDiGraph.
    """
    if graph is None:
        return nx.MultiDiGraph()
    if not graph.is_directed():
        graph = graph.to_directed()
    if not graph.is_multigraph() or not isinstance(graph, nx.MultiDiGraph):
        graph = nx.MultiDiGraph(graph)
    return graph


def _fetch_osm_tiled(boundary, pop, force_refresh=False, job_id=None, cache_dir=None):
    """Fetch buildings and roads per tile with bounded parallelism.

    Each tile is persisted as an artifact. A retry can therefore resume at
    the tile level instead of repeating completed Overpass/OSM requests.
    """
    tiles = _build_generation_tiles(boundary)
    # A tile road query must describe the tile itself. The old implementation
    # passed the global POP into every tile, causing each query to expand to
    # the convex hull between POP and that tile. For a large boundary this
    # repeatedly downloaded the same long corridor. Add a small set of road
    # tiles along the POP connector only when POP is outside the boundary.
    road_tiles = list(tiles)
    pop_point = Point(pop["lon"], pop["lat"])
    if not boundary.covers(pop_point):
        nearest_boundary = boundary.boundary.interpolate(
            boundary.boundary.project(pop_point)
        )
        connector = LineString([pop_point, nearest_boundary]).buffer(0.002)
        existing = {
            tuple(round(value, 6) for value in tile.bounds)
            for tile in road_tiles
        }
        for tile in _build_generation_tiles(connector):
            key = tuple(round(value, 6) for value in tile.bounds)
            if key not in existing:
                road_tiles.append(tile)
                existing.add(key)
    checkpoint_dir = None
    if cache_dir:
        # Include the exact boundary geometry so a retry for a different
        # polygon cannot accidentally reuse tile artifacts from the previous
        # design just because both polygons share the same grid cell.
        boundary_fingerprint = hashlib.sha256(boundary.wkb).hexdigest()[:16]
        checkpoint_dir = os.path.join(
            os.path.abspath(cache_dir), "checkpoints", "osm_tiles", boundary_fingerprint
        )
        os.makedirs(checkpoint_dir, exist_ok=True)
    if job_id:
        progress_manager.update(job_id, "LOADING_ROADS", f"Memproses {len(road_tiles)} tile OSM...", 30)

    def tile_key(tile):
        return "_".join(f"{value:.6f}" for value in tile.bounds).replace("-", "m").replace(".", "d")

    boundary_tile_keys = {
        tuple(round(value, 6) for value in tile.bounds)
        for tile in tiles
    }
    osm_cache_max_age = int(
        os.getenv("OSM_CACHE_MAX_AGE_SECONDS", str(24 * 60 * 60))
    )

    def fetch_tile(index, tile):
        key = tile_key(tile)
        load_houses = tuple(round(value, 6) for value in tile.bounds) in boundary_tile_keys
        houses_path = os.path.join(checkpoint_dir, f"{index}_{key}.houses.json") if checkpoint_dir and load_houses else None
        roads_path = os.path.join(checkpoint_dir, f"{index}_{key}.roads.pkl") if checkpoint_dir else None
        if (
            not force_refresh
            and roads_path
            and os.path.exists(roads_path)
            and (not load_houses or (houses_path and os.path.exists(houses_path)))
        ):
            timestamps = [os.path.getmtime(roads_path)]
            if houses_path:
                timestamps.append(os.path.getmtime(houses_path))
            newest = max(timestamps)
            if time.time() - newest <= osm_cache_max_age:
                try:
                    cached_houses = []
                    if houses_path:
                        with open(houses_path) as source:
                            cached_houses = [tuple(item) for item in json.load(source)]
                    with open(roads_path, "rb") as source:
                        return cached_houses, pickle.load(source), True
                except Exception as exc:
                    logger.warning("Tile checkpoint %s tidak dapat dibaca: %s", key, exc)
        houses = fetch_houses_in_boundary(tile, force_refresh=force_refresh) if load_houses else []
        roads = fetch_road_graph(
            tile,
            pop=None,
            force_refresh=force_refresh,
            include_pop=False,
        )
        if roads_path and (not load_houses or houses_path):
            temporary_houses = f"{houses_path}.tmp"
            temporary_roads = f"{roads_path}.tmp"
            if houses_path:
                with open(temporary_houses, "w") as target:
                    json.dump(houses, target)
            with open(temporary_roads, "wb") as target:
                pickle.dump(roads, target)
            if houses_path:
                os.replace(temporary_houses, houses_path)
            os.replace(temporary_roads, roads_path)
        return houses, roads, False

    houses: list[tuple[float, float]] = []
    road_graphs = []
    from concurrent.futures import ThreadPoolExecutor
    max_workers = max(1, int(os.getenv("OSM_TILE_WORKERS", "4")))
    with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="osm-tile") as executor:
        futures = [executor.submit(fetch_tile, index, tile) for index, tile in enumerate(road_tiles)]
        for index, future in enumerate(futures, start=1):
            tile_houses, tile_graph, from_checkpoint = future.result()
            houses.extend(tile_houses)
            road_graphs.append(_normalize_routing_graph(tile_graph))
            if job_id:
                progress_manager.update(
                    job_id, "LOADING_ROADS",
                    f"Memuat tile OSM {index}/{len(road_tiles)}{' dari cache' if from_checkpoint else ''}...",
                    30 + int(index / len(road_tiles) * 15),
                )

    road_graph = nx.compose_all(road_graphs) if road_graphs else nx.MultiDiGraph()

    # Tiles intentionally overlap to avoid cutting roads/buildings at tile
    # edges. Remove the overlap perimeter before clustering; otherwise a
    # small boundary can receive houses from the surrounding tile buffer.
    unique_houses = list({
        (round(lat, 7), round(lon, 7))
        for lat, lon in houses
        if boundary.contains(Point(lon, lat))
    })
    return unique_houses, prepare_road_graph(road_graph)


def _cache_paths(cache_dir=None):
    resolved_cache_dir = os.path.abspath(cache_dir or CACHE_DIR)
    return (
        resolved_cache_dir,
        os.path.join(resolved_cache_dir, "design_state.json"),
        os.path.join(resolved_cache_dir, "road_graph.pkl"),
    )


def _core_manifest_path(cache_dir=None):
    resolved_cache_dir, _, _ = _cache_paths(cache_dir)
    return os.path.join(resolved_cache_dir, "core_manifest.json")


def invalidate_design_state(cache_dir=None):
    """Remove the previous network cache before starting a new core job."""
    _, design_state_path, road_graph_path = _cache_paths(cache_dir)
    for path in (design_state_path, road_graph_path, _core_manifest_path(cache_dir)):
        try:
            if os.path.exists(path):
                os.remove(path)
                logger.info("Cache design lama dihapus: %s", path)
        except OSError as exc:
            raise ExportFailedError(
                message="Cache Network Core lama tidak dapat dihapus. Tutup proses generate lain lalu coba lagi.",
            ) from exc


def _distribution_length(coords):
    return sum(
        haversine_m(coords[index][0], coords[index][1], coords[index + 1][0], coords[index + 1][1])
        for index in range(len(coords) - 1)
    )


def _has_overlong_distribution_segments(distribution_segments, max_length_m):
    """Return whether a cached distribution path exceeds the design limit.

    Older caches can contain a connected path whose endpoints are valid but
    whose parent ODC is on the wrong side of a road barrier. Endpoint
    validation alone cannot detect that case, so it must be treated as a
    stale mapping and routed again.
    """
    for segment in (distribution_segments or {}).values():
        if not isinstance(segment, dict):
            continue
        length_m = segment.get("length_m")
        if length_m is None and segment.get("coords"):
            length_m = _distribution_length(segment["coords"])
        try:
            if length_m is not None and float(length_m) > max_length_m:
                return True
        except (TypeError, ValueError):
            return True
    return False


def _distribution_limit_from_state(state):
    """Read the persisted distribution limit with a safe legacy default."""
    try:
        value = float((state or {}).get(
            "max_distribution_length_m",
            DEFAULT_MAX_DISTRIBUTION_LENGTH_M,
        ))
        if value > 0:
            return value
    except (TypeError, ValueError):
        pass
    return DEFAULT_MAX_DISTRIBUTION_LENGTH_M


def _infer_odc_capacity(odcs, default=4):
    """Read the persisted ODC splitter capacity for cache repair.

    Older design states do not store the full GenerationConfig, but they do
    persist each ODC splitter ratio (normally ``1:4``). Using that value lets
    cache migration rebalance ODPs without exceeding the original ODC
    capacity.
    """
    capacities = []
    for odc in odcs:
        ratio = getattr(getattr(odc, "splitter", None), "ratio", "") or ""
        try:
            capacities.append(int(str(ratio).split(":", 1)[1]))
        except (IndexError, TypeError, ValueError):
            continue
    return max(capacities or [default])


def _normalize_distribution_segments(distribution_segments, odcs):
    """Normalize new metadata and legacy target_id -> coords cache values."""
    normalized = {}
    odp_to_odc = {
        odp.id: odc.id
        for odc in odcs
        for odp in odc.odps
    }
    for target_id, value in (distribution_segments or {}).items():
        if isinstance(value, dict):
            segment = dict(value)
            segment.setdefault("target_id", target_id)
            segment.setdefault("target_label", target_id)
            segment.setdefault("coords", [])
            segment.setdefault("connected", bool(segment["coords"]))
            if segment.get("length_m") is None and segment["coords"]:
                segment["length_m"] = _distribution_length(segment["coords"])
            normalized[target_id] = segment
            continue

        coords = [list(point) for point in (value or [])]
        source_id = odp_to_odc.get(target_id)
        normalized[target_id] = {
            "source_id": source_id,
            "target_id": target_id,
            "source_label": source_id,
            "target_label": target_id,
            "coords": coords,
            "length_m": _distribution_length(coords) if coords else None,
            "routing_cost": None,
            "connected": bool(coords),
        }
    return normalized


def save_design_state(
    pop,
    odcs,
    road_graph=None,
    cache_dir=None,
    feeder_segments=None,
    distribution_segments=None,
    boundary=None,
    distribution_max_length_m=None,
):
    """Simpan posisi POP, ODC, ODP, dan rumah ke file JSON, serta road graph
    ke pickle. Ini memungkinkan regenerate kabel tanpa menjalankan ulang
    clustering & placement dari awal."""
    resolved_cache_dir, design_state_path, road_graph_path = _cache_paths(cache_dir)
    os.makedirs(resolved_cache_dir, exist_ok=True)

    state = {
        "version": NETWORK_STATE_VERSION if feeder_segments is not None and distribution_segments is not None else 1,
        "pop": pop,
        "odcs": [],
        "feeder_segments": feeder_segments or [],
        "distribution_segments": {},
    }
    if distribution_max_length_m is not None:
        state["max_distribution_length_m"] = float(distribution_max_length_m)
    if boundary is not None:
        state["boundary"] = mapping(boundary)
    for odc in odcs:
        odc_data = {
            "id": odc.id,
            "lat": odc.lat,
            "lon": odc.lon,
            "closure_id": odc.closure_id,
            "splitter_ratio": odc.splitter.ratio if odc.splitter else None,
            "splitter_location": odc.splitter.location if odc.splitter else None,
            "odps": [],
        }
        for odp in odc.odps:
            odp_data = {
                "id": odp.id,
                "lat": odp.lat,
                "lon": odp.lon,
                "splitter_ratio": odp.splitter.ratio if odp.splitter else None,
                "splitter_location": odp.splitter.location if odp.splitter else None,
                "houses": odp.houses,  # list of (lat, lon)
                "upstream_id": odp.upstream_id,
            }
            odc_data["odps"].append(odp_data)
        state["odcs"].append(odc_data)

    state["distribution_segments"] = _normalize_distribution_segments(
        distribution_segments,
        odcs,
    )

    temporary_state_path = f"{design_state_path}.tmp"
    with open(temporary_state_path, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(temporary_state_path, design_state_path)
    logger.info("Design state disimpan di: %s", design_state_path)

    if road_graph is not None:
        with open(road_graph_path, "wb") as f:
            pickle.dump(road_graph, f)
        logger.info("Road graph disimpan di: %s", road_graph_path)
    elif os.path.exists(road_graph_path):
        # Jangan gunakan graph dari design sebelumnya saat pengambilan OSM terbaru gagal.
        os.remove(road_graph_path)


def load_design_state(cache_dir=None):
    """Muat design state dari cache JSON. Return (pop, odcs) yang siap dipakai
    untuk regenerate kabel. Raise DesignStateNotFoundError kalau belum pernah generate."""
    _, design_state_path, _ = _cache_paths(cache_dir)
    if not os.path.exists(design_state_path):
        raise DesignStateNotFoundError(
            message="Belum ada design state yang tersimpan. Jalankan 'Generate Design' terlebih dahulu.",
        )

    with open(design_state_path, "r") as f:
        state = json.load(f)

    pop = state["pop"]
    odcs = []
    for odc_data in state["odcs"]:
        odps = []
        for odp_data in odc_data["odps"]:
            odp = ODP(
                id=odp_data["id"],
                lat=odp_data["lat"],
                lon=odp_data["lon"],
                houses=[tuple(h) for h in odp_data["houses"]],
                upstream_id=odp_data.get("upstream_id"),
                splitter=Splitter(
                    ratio=odp_data["splitter_ratio"] or "1:10",
                    location=odp_data["splitter_location"] or "ODP",
                ),
            )
            odps.append(odp)
        odc = ODC(
            id=odc_data["id"],
            lat=odc_data["lat"],
            lon=odc_data["lon"],
            odps=odps,
            splitter=Splitter(
                ratio=odc_data["splitter_ratio"] or "1:4",
                location=odc_data["splitter_location"] or "ODC",
            ),
            closure_id=odc_data["closure_id"],
        )
        odcs.append(odc)

    return pop, odcs


def load_network_state(cache_dir=None):
    """Load the complete, reusable Network Core cache.

    Homepass generation is deliberately refused for legacy/incomplete caches:
    otherwise it could silently reroute the network or produce a different
    ODP layout than the one the user already approved.
    """
    _, design_state_path, _ = _cache_paths(cache_dir)
    if not os.path.exists(design_state_path):
        raise DesignStateNotFoundError(
            message="Cache Network Core belum tersedia. Jalankan Generate Design terlebih dahulu.",
        )
    try:
        with open(design_state_path, "r") as f:
            state = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        raise DesignStateNotFoundError(
            message="Cache Network Core rusak. Jalankan Generate Design ulang.",
        ) from exc

    _, loaded_odcs = load_design_state(cache_dir=cache_dir)
    distribution_limit_m = _distribution_limit_from_state(state)
    odp_ids = {odp.id for odc in loaded_odcs for odp in odc.odps}
    cache_is_complete = (
        state.get("version") == NETWORK_STATE_VERSION
        and isinstance(state.get("feeder_segments"), list)
        and isinstance(state.get("distribution_segments"), dict)
        and odp_ids == set(state.get("distribution_segments", {}))
    )
    if cache_is_complete:
        try:
            _require_distribution_connectivity(
                loaded_odcs,
                state.get("distribution_segments", {}),
            )
            if _has_overlong_distribution_segments(
                state.get("distribution_segments", {}),
                distribution_limit_m,
            ):
                # The line can have valid endpoints and still be a stale
                # ODC->ODP assignment that detours around a barrier.
                cache_is_complete = False
        except RoutingFailedError:
            # IDs can still match when paths are stale/corrupt. Rebuild the
            # network from the road graph rather than exporting that cache.
            cache_is_complete = False

    if not cache_is_complete:
        # Migrate legacy caches in-place when the road graph is available.
        # This avoids another OSM buildings query and another clustering run.
        try:
            pop, odcs = load_design_state(cache_dir=cache_dir)
            road_graph = load_road_graph(cache_dir=cache_dir)

            # A v2 cache already contains complete paths, but not upstream
            # metadata. Preserve those paths when possible so migration does
            # not silently redesign an approved network.
            existing_segments = _normalize_distribution_segments(
                state.get("distribution_segments", {}), odcs
            )
            has_all_existing_paths = (
                odp_ids == set(existing_segments)
                and all(
                    item.get("connected") and item.get("coords")
                    for item in existing_segments.values()
                )
                and not _has_overlong_distribution_segments(
                    existing_segments,
                    distribution_limit_m,
                )
            )
            if has_all_existing_paths:
                try:
                    _require_distribution_connectivity(odcs, existing_segments)
                except RoutingFailedError:
                    has_all_existing_paths = False

            if has_all_existing_paths:
                distribution_segments = existing_segments
                for odc in odcs:
                    for odp in odc.odps:
                        segment = distribution_segments.get(odp.id, {})
                        odp.upstream_id = segment.get("source_id") or odc.id
            else:
                if road_graph is None:
                    raise RuntimeError("road graph cache tidak ditemukan")
                # A legacy cache can have every ODP present while assigning a
                # few ODPs to the wrong ODC. Reassign by actual road distance
                # before rebuilding the tree; otherwise a nearby ODP may be
                # forced onto a 1km+ detour and appear disconnected.
                rebalance_odps_by_road_connectivity(
                    odcs,
                    road_graph,
                    max_distribution_length_m=distribution_limit_m,
                    odc_capacity=_infer_odc_capacity(odcs),
                )
                distribution_segments = {}
                for odc in odcs:
                    distribution_segments.update(build_distribution_tree(
                        odc,
                        road_graph,
                        max_distance_m=distribution_limit_m,
                    ))

            _require_distribution_connectivity(odcs, distribution_segments)

            feeder_segments = state.get("feeder_segments") or []
            if not feeder_segments:
                if road_graph is None:
                    raise RuntimeError("road graph cache tidak ditemukan")
                feeder_segments, odcs = build_feeder_segments_preserving_order(
                    pop, odcs, road_graph=road_graph
                )

            save_design_state(
                pop,
                odcs,
                road_graph=road_graph,
                cache_dir=cache_dir,
                feeder_segments=feeder_segments,
                distribution_segments=distribution_segments,
                distribution_max_length_m=distribution_limit_m,
            )
            with open(design_state_path, "r") as f:
                state = json.load(f)
        except Exception as exc:
            logger.warning("Gagal migrasi cache Network Core lama: %s", exc)
            raise DesignStateNotFoundError(
                message="Cache Network Core berasal dari generator lama atau belum lengkap dan tidak dapat dimigrasikan. Jalankan Generate Design ulang.",
            ) from exc

    pop, odcs = load_design_state(cache_dir=cache_dir)
    odp_ids = {odp.id for odc in odcs for odp in odc.odps}
    cached_ids = set(state.get("distribution_segments", {}))
    if odp_ids != cached_ids:
        raise DesignStateNotFoundError(
            message="Cache geometri distribusi tidak lengkap. Jalankan Generate Design ulang.",
        )
    _require_distribution_connectivity(odcs, state["distribution_segments"])
    for odc in odcs:
        for odp in odc.odps:
            segment = state["distribution_segments"].get(odp.id, {})
            if isinstance(segment, dict):
                odp.upstream_id = segment.get("source_id")
    return pop, odcs, state


def load_road_graph(cache_dir=None):
    """Muat road graph dari pickle cache. Return None kalau tidak ada."""
    _, _, road_graph_path = _cache_paths(cache_dir)
    if not os.path.exists(road_graph_path):
        return None
    with open(road_graph_path, "rb") as f:
        return prepare_road_graph(pickle.load(f))


def _core_cache_key(boundary_path, pop_path, has_custom_pop, config):
    """Return the deterministic identity of a generated Network Core."""
    return {
        "manifest_version": CORE_MANIFEST_VERSION,
        "network_state_version": NETWORK_STATE_VERSION,
        "algorithm_version": ALGORITHM_VERSION,
        "input_hash": _compute_input_hash(boundary_path, pop_path),
        "has_custom_pop": bool(has_custom_pop),
        "config": config.model_dump(mode="json"),
    }


def _load_reusable_core(boundary_path, pop_path, has_custom_pop, config, cache_dir=None):
    """Load a complete core only when it belongs to the current inputs/config."""
    # FULL mode contains homepass routing, so keep its existing behaviour.
    if config.include_homepass or config.force_refresh_osm:
        return None
    manifest_path = _core_manifest_path(cache_dir)
    if not os.path.exists(manifest_path):
        return None
    try:
        with open(manifest_path, "r") as source:
            manifest = json.load(source)
        expected = _core_cache_key(boundary_path, pop_path, has_custom_pop, config)
        if any(manifest.get(key) != value for key, value in expected.items()):
            return None
        pop, odcs, state = load_network_state(cache_dir=cache_dir)
        logger.info("Network Core cache hit: clustering dan routing dilewati")
        return pop, odcs, state, manifest.get("osm_timestamp")
    except Exception as exc:
        logger.warning("Network Core cache tidak dapat dipakai, generate ulang: %s", exc)
        return None


def _save_core_manifest(boundary_path, pop_path, has_custom_pop, config, osm_timestamp, cache_dir=None):
    resolved_cache_dir, _, _ = _cache_paths(cache_dir)
    os.makedirs(resolved_cache_dir, exist_ok=True)
    manifest = _core_cache_key(boundary_path, pop_path, has_custom_pop, config)
    manifest["osm_timestamp"] = osm_timestamp
    path = _core_manifest_path(cache_dir)
    temporary_path = f"{path}.tmp"
    with open(temporary_path, "w") as target:
        json.dump(manifest, target, indent=2, sort_keys=True)
    os.replace(temporary_path, path)


def regenerate_cables_only(output_path, include_homepass=False, output_csv=None, cache_dir=None, job_id=None):
    """Regenerate HANYA jalur kabel (feeder, distribusi, drop) tanpa mengubah
    posisi ODC/ODP/tiang/rumah. Membaca posisi dari design state cache dan
    road graph dari pickle cache, lalu menjalankan routing + export KMZ.

    Return: path output KMZ yang dihasilkan."""
    if job_id: progress_manager.update(job_id, "PARSING", "Membaca state sebelumnya...", 10)
    logger.info("=" * 60)
    logger.info("REGENERATE KABEL ONLY — posisi tiang/ODC/ODP/rumah TETAP")
    logger.info("=" * 60)

    _, _, road_graph_path = _cache_paths(cache_dir)
    pop, odcs, network_state = load_network_state(cache_dir=cache_dir)
    road_graph = load_road_graph(cache_dir=cache_dir)

    logger.info(
        "load_road_graph returned: %s",
        "None" if road_graph is None else f"Graph with {len(road_graph.nodes)} nodes",
    )

    if road_graph is None:
        logger.warning("Road graph cache tidak ditemukan. Mencoba mengunduh ulang dari OSM...")
        all_lats = [pop["lat"]] + [odc.lat for odc in odcs] + [odp.lat for odc in odcs for odp in odc.odps]
        all_lons = [pop["lon"]] + [odc.lon for odc in odcs] + [odp.lon for odc in odcs for odp in odc.odps]

        if all_lats and all_lons:
            min_lat, max_lat = min(all_lats), max(all_lats)
            min_lon, max_lon = min(all_lons), max(all_lons)
            bbox = Polygon([
                (min_lon, min_lat), (min_lon, max_lat),
                (max_lon, max_lat), (max_lon, min_lat)
            ])
            try:
                logger.info("Fetching road graph for bbox: %s", bbox)
                road_graph = fetch_road_graph(bbox, pop, buffer_deg=0.015)
                if road_graph is not None:
                    # Simpan ke cache agar percobaan berikutnya lebih cepat
                    with open(road_graph_path, "wb") as f:
                        pickle.dump(road_graph, f)
                    logger.info("Successfully fetched and cached road graph.")
                else:
                    logger.warning("fetch_road_graph returned None")
            except Exception as e:
                logger.exception("Gagal mengunduh ulang road graph (%s); regenerate akan dihentikan.", e)
        else:
            logger.warning("Tidak ada data koordinat untuk mengunduh road graph; regenerate akan dihentikan.")

    if road_graph is None:
        raise RoadGraphUnavailableError(
            message="Jaringan jalan OSM tidak tersedia. Regenerate dihentikan agar kabel tidak dibuat sebagai garis lurus.",
        )

    if job_id: progress_manager.update(job_id, "ROUTING", "Melakukan routing ulang kabel...", 50)
    distribution_limit_m = _distribution_limit_from_state(network_state)
    total_odp = sum(len(odc.odps) for odc in odcs)
    total_houses = sum(len(odp.houses) for odc in odcs for odp in odc.odps)
    logger.info("Loaded: %d ODC, %d ODP, %d rumah", len(odcs), total_odp, total_houses)

    # Route feeder tanpa mengubah urutan ODC (sudah benar dari cache).
    # Distribution juga dibangun ulang; sebelumnya fungsi ini hanya memakai
    # distribution_segments lama sehingga regenerate terlihat tidak berubah.
    feeder_segments, odcs = build_feeder_segments_preserving_order(
        pop, odcs, road_graph=road_graph
    )
    # Re-evaluate the ODC parent from the road graph on every cable
    # regeneration. The cached parent was originally selected by geographic
    # proximity and may be separated from its ODP by a river, railway, or
    # one-way road. Keeping that stale parent is the main cause of the visible
    # gaps in older generated designs.
    rebalance_odps_by_road_connectivity(
        odcs,
        road_graph,
        max_distribution_length_m=distribution_limit_m,
        odc_capacity=_infer_odc_capacity(odcs),
    )
    distribution_segments = {}
    for odc in odcs:
        distribution_segments.update(
            build_distribution_tree(
                odc,
                road_graph,
                max_distance_m=distribution_limit_m,
            )
        )
    _require_distribution_connectivity(odcs, distribution_segments)

    if job_id:
        total_odps = sum(len(odc.odps) for odc in odcs)
        total_houses = sum(len(odp.houses) for odc in odcs for odp in odc.odps)
        progress_manager.update(
            job_id,
            "EXPORTING",
            f"Membuat output KMZ ({total_odps} ODP, {total_houses} HC)...",
            85,
        )
    # Export KMZ dengan routing kabel baru
    export_kmz(
        pop,
        odcs,
        feeder_segments,
        output_path,
        include_homepass=include_homepass,
        road_graph=road_graph,
        road_feeder=True,
        distribution_segments=distribution_segments,
        boundary=network_state.get("boundary"),
        progress_callback=lambda done, total, message: _report_export_progress(
            job_id, done, total, message
        ),
    )
    if output_csv:
        try:
            export_csv(pop, odcs, feeder_segments, output_csv, distribution_segments=distribution_segments)
        except Exception as e:
            logger.warning("Gagal generate CSV: %s", e)
    try:
        save_design_state(
            pop,
            odcs,
            road_graph=road_graph,
            cache_dir=cache_dir,
            feeder_segments=feeder_segments,
            distribution_segments=distribution_segments,
            distribution_max_length_m=distribution_limit_m,
            boundary=network_state.get("boundary"),
        )
    except Exception as e:
        logger.warning("Gagal memperbarui cache setelah regenerate kabel: %s", e)
    logger.info("Selesai! File KMZ disimpan di %s", output_path)

    return output_path


def generate_cables_from_custom_points(file_path, output_path, include_homepass=False, output_csv=None, cache_dir=None, job_id=None):
    """
    Men-generate jalur kabel (routing mengikuti jalan OSM) dari file KML custom
    yang sudah berisi titik-titik mapping OLT, ODC, ODP, dan RUMAH.
    """
    if job_id: progress_manager.update(job_id, "PARSING", "Membaca file custom KML...", 10)
    points = read_custom_mapped_kml(file_path)

    if not points['olt']:
        # Keep compatibility with older KML exports where POP/OLT is only
        # discoverable through folder/description metadata.
        inferred_pop = read_pop_point(file_path)
        if inferred_pop:
            points['olt'].append(inferred_pop)
            logger.info("POP/OLT ditemukan dari konteks folder/description KML: %s", inferred_pop['name'])

    if not points['olt']:
        detected = ", ".join(
            f"{key.upper()}={len(points[key])}"
            for key in ("odc", "odp", "hc")
            if points[key]
        ) or "tidak ada titik berlabel"
        raise InvalidFileError(
            message=(
                "Tidak ditemukan titik OLT/POP di file custom KML "
                f"({detected}). Beri label OLT/POP pada nama Placemark, nama Folder, "
                "atau description; aplikasi tidak boleh membuat POP fiktif karena feeder "
                "harus memiliki titik sumber yang nyata."
            ),
        )
    if not points['odc']:
        raise InvalidFileError(
            message="Tidak ditemukan titik ODC di file custom KML. Pastikan ada nama yang mengandung 'ODC'.",
        )
    if not points['odp']:
        raise InvalidFileError(
            message="Tidak ditemukan titik ODP di file custom KML. Pastikan ada nama yang mengandung 'ODP'.",
        )

    pop = points['olt'][0]

    # 1. Kelompokkan HC ke ODP terdekat
    odp_objects = []
    for odp_pt in points['odp']:
        odp = ODP(id=odp_pt['name'], lat=odp_pt['lat'], lon=odp_pt['lon'], houses=[], splitter=Splitter(ratio="1:10", location="ODP"))
        odp_objects.append(odp)

    for hc in points['hc']:
        if not odp_objects:
            break
        # Cari ODP terdekat
        nearest_odp = min(odp_objects, key=lambda o: haversine_m(hc['lat'], hc['lon'], o.lat, o.lon))
        nearest_odp.houses.append((hc['lat'], hc['lon']))

    # 2. Kelompokkan ODP ke ODC terdekat
    odcs = []
    for i, odc_pt in enumerate(points['odc'], start=1):
        odc = ODC(id=odc_pt['name'], lat=odc_pt['lat'], lon=odc_pt['lon'], odps=[], closure_id=f"CL-{i:03d}", splitter=Splitter(ratio="1:4", location="ODC"))
        odcs.append(odc)

    odcs_by_group = {
        odc_pt.get("mapping_group"): odc
        for odc_pt, odc in zip(points["odc"], odcs)
        if odc_pt.get("mapping_group")
    }
    odp_points_by_name = {point["name"]: point for point in points["odp"]}

    for odp in odp_objects:
        source_point = odp_points_by_name.get(odp.id, {})
        explicit_group = source_point.get("mapping_group")
        mapped_odc = odcs_by_group.get(explicit_group) if explicit_group else None
        if mapped_odc is not None:
            mapped_odc.odps.append(odp)
            continue

        if explicit_group and odcs_by_group:
            raise InvalidFileError(
                message=(
                    f"Mapping {odp.id} menunjuk ke group ODC {explicit_group}, "
                    "tetapi ODC dengan group tersebut tidak ditemukan. "
                    "Gunakan nama ODC 17 dan ODP 17/01, atau hapus nomor group."
                ),
            )

        if not odcs:
            break
        nearest_odc = min(odcs, key=lambda o: haversine_m(odp.lat, odp.lon, o.lat, o.lon))
        nearest_odc.odps.append(odp)

    # 3. Buat bounding box dari semua titik untuk mengambil road graph
    all_lats = [p['lat'] for p in points['olt'] + points['odc'] + points['odp'] + points['hc']]
    all_lons = [p['lon'] for p in points['olt'] + points['odc'] + points['odp'] + points['hc']]

    if not all_lats:
        raise InvalidFileError(message="Tidak ada titik valid dalam KML.")

    min_lat, max_lat = min(all_lats), max(all_lats)
    min_lon, max_lon = min(all_lons), max(all_lons)

    # Polygon bounding box
    bbox = Polygon([
        (min_lon, min_lat),
        (min_lon, max_lat),
        (max_lon, max_lat),
        (max_lon, min_lat)
    ])

    if job_id: progress_manager.update(job_id, "LOADING_ROADS", "Mengambil data jalan dari OSM...", 30)
    logger.info("Mengambil data jalan untuk custom routing...")
    road_graph = None
    try:
        road_graph = fetch_road_graph(bbox, pop, buffer_deg=0.015)
    except Exception as e:
        raise OSMUnavailableError(
            message=f"Gagal mengambil data jalan ({e}). Generate dihentikan agar kabel tidak memotong rel atau sungai.",
        ) from e

    if road_graph is None:
        raise RoadGraphUnavailableError(
            message="Jaringan jalan OSM tidak tersedia. Generate dihentikan agar kabel tidak dibuat sebagai garis lurus.",
        )

    try:
        for odc in odcs:
            odc.lat, odc.lon = snap_to_road(road_graph, odc.lat, odc.lon)
            for odp in odc.odps:
                odp.lat, odp.lon = snap_to_road(road_graph, odp.lat, odp.lon)
    except Exception as e:
        raise RoutingFailedError(
            message=f"ODC/ODP custom tidak dapat ditempatkan pada jalan kendaraan: {e}",
        ) from e

    if job_id: progress_manager.update(job_id, "ROUTING", "Membangun rantai kabel feeder...", 50)
    # 4. Routing Feeder (POP -> ODCs)
    logger.info("Membangun rantai kabel feeder...")
    feeder_segments, odcs = build_feeder_chain(pop, odcs, road_graph=road_graph)
    distribution_segments = {}
    for odc in odcs:
        distribution_segments.update(
            build_distribution_tree(odc, road_graph)
        )
    _require_distribution_connectivity(odcs, distribution_segments)

    if job_id: progress_manager.update(job_id, "EXPORTING", "Mengekspor ke KMZ dengan jalur kabel...", 85)
    # 5. Export (otomatis melakukan routing Distribusi & Drop)
    logger.info("Mengekspor ke KMZ dengan jalur kabel...")
    export_kmz(
        pop, odcs, feeder_segments, output_path,
        include_homepass=include_homepass,
        road_graph=road_graph,
        road_feeder=(road_graph is not None),
        distribution_segments=distribution_segments,
        progress_callback=lambda done, total, message: _report_export_progress(
            job_id, done, total, message
        ),
    )

    # 6. Cache design state untuk fitur regenerate-cables
    try:
        save_design_state(
            pop,
            odcs,
            road_graph=road_graph,
            cache_dir=cache_dir,
            feeder_segments=feeder_segments,
            distribution_segments=distribution_segments,
        )
    except Exception as e:
        logger.warning("Gagal menyimpan custom design state (%s), regenerate-cables tidak tersedia.", e)

    return output_path


def generate_homepass_from_state(output_path, output_csv=None, cache_dir=None, job_id=None):
    """Export HC/drop cables from the last Network Core without OSM/routing."""
    if job_id:
        progress_manager.update(job_id, "PARSING", "Memuat cache Network Core...", 10)
    pop, odcs, state = load_network_state(cache_dir=cache_dir)
    feeder_segments = state["feeder_segments"]
    distribution_segments = state["distribution_segments"]
    total_houses = sum(len(odp.houses) for odc in odcs for odp in odc.odps)
    if job_id:
        progress_manager.update(
            job_id,
            "EXPORTING",
            f"Membuat homepass 0/{total_houses:,}...",
            20,
        )

    export_kmz(
        pop,
        odcs,
        feeder_segments,
        output_path,
        include_homepass=True,
        road_graph=None,
        road_feeder=False,
        road_drop=False,
        distribution_segments=distribution_segments,
        boundary=state.get("boundary"),
        progress_callback=(
            lambda done, total, message: progress_manager.update(
                job_id,
                "EXPORTING",
                message.replace("Membuat kabel distribusi dan HC", "Membuat homepass"),
                20 + min(65, int((done / total) * 65)) if total else 85,
            ) if job_id else None
        ),
    )
    if output_csv:
        export_csv(
            pop,
            odcs,
            feeder_segments,
            output_csv,
            distribution_segments=distribution_segments,
        )
    if job_id:
        progress_manager.update(job_id, "EXPORTING", "Homepass selesai, menyiapkan output...", 90)
    return pop, odcs, feeder_segments


import hashlib
import zipfile
import math
import time
import glob
from datetime import datetime, timezone
from server.core.errors import ExportFailedError, PopTooFarError, NoCustomerFoundError
from server.services.generator.kml_parser import read_boundary, read_points, read_pop_point
from server.services.generator.osm_local import fetch_houses_in_boundary, find_strategic_pop
from server.services.generator.clustering import build_design
from server.services.generator.routing import enforce_min_distance_between_odcs, enforce_min_distance_between_odcs_on_road
from server.services.generator.generation_config import GenerationConfig, ALGORITHM_VERSION
from typing import Optional
from concurrent.futures import ThreadPoolExecutor

def cleanup_old_files(directory, max_age_seconds=3600):
    """Hapus input sementara lama tanpa menghapus hasil milik akun."""
    try:
        if not os.path.exists(directory):
            return

        now = time.time()
        for pattern in ["boundary_*.kml", "pop_*.kml", "custom_mapping_*.kml"]:
            for f in glob.glob(os.path.join(directory, pattern)):
                if os.path.isfile(f) and now - os.path.getmtime(f) > max_age_seconds:
                    try:
                        os.remove(f)
                    except Exception:
                        pass
    except Exception as e:
        logger.warning("Error during cleanup: %s", e)

def haversine_dist(lon1, lat1, lon2, lat2):
    """Hitung jarak (dalam meter) antara dua titik koordinat."""
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def _compute_input_hash(*file_paths) -> str:
    """Compute a SHA-256 hash over one or more input files."""
    h = hashlib.sha256()
    for path in file_paths:
        if path and os.path.exists(path):
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(8192), b""):
                    h.update(chunk)
    return h.hexdigest()

def _extract_kml_from_kmz(kmz_path, kml_output_path):
    """Extract the first KML file from a KMZ archive."""
    with zipfile.ZipFile(kmz_path, "r") as z:
        kml_name = next(
            (n for n in z.namelist() if n.lower().endswith(".kml")), None
        )
        if not kml_name:
            raise ExportFailedError("No KML found inside generated KMZ.")
        kml_content = z.read(kml_name)
        with open(kml_output_path, "wb") as f:
            f.write(kml_content)

def _parse_config_from_form(config_json: Optional[str]) -> GenerationConfig:
    """Parse a GenerationConfig from an optional JSON form field."""
    if not config_json:
        return GenerationConfig()
    try:
        data = json.loads(config_json)
        return GenerationConfig(**data)
    except (json.JSONDecodeError, Exception) as exc:
        raise InvalidFileError(
            message=f"Invalid generation config JSON: {exc}",
            details={"raw": config_json[:200] if config_json else None},
        ) from exc

def _run_generator_logic(
    boundary_path,
    pop_path,
    output_kmz,
    output_csv=None,
    has_custom_pop=False,
    cache_dir=None,
    config: GenerationConfig | None = None,
    job_id: str | None = None,
):
    """Run the full generation pipeline. Returns (pop, odcs, feeder_segments, config, osm_ts)."""
    pipeline_started = time.perf_counter()
    if config is None:
        config = GenerationConfig()
    osm_timestamp = datetime.now(timezone.utc).isoformat()

    if job_id: progress_manager.update(job_id, "PARSING", "Membaca file input...", 10)

    boundary = read_boundary(boundary_path)

    if has_custom_pop:
        pop_points = read_points(pop_path)
        pop = pop_points[0]
        # Validasi Jarak jika POP custom di-upload
        dist = haversine_dist(
            boundary.centroid.x, boundary.centroid.y, pop["lon"], pop["lat"]
        )
        if dist > 3000:  # 3 km
            raise PopTooFarError(
                message=(
                    "POP (Sentral) terlalu jauh dari area perancangan (> 3 km). "
                    "Hal ini dapat membebani server saat meroute jalan. "
                    "Harap letakkan POP lebih dekat dengan area boundary."
                ),
                details={"distance_m": round(dist, 1), "limit_m": 3000},
            )
    else:
        pop = read_pop_point(boundary_path)

    if pop is None:
        # Jika tidak ada POP yang di-upload, otomatis buat POP di lokasi strategis
        from server.services.generator.osm_local import find_strategic_pop

        pop = find_strategic_pop(boundary)
        logger.info(
            "Auto-generated POP at %s, %s (Location: %s)",
            pop["lon"],
            pop["lat"],
            pop["name"],
        )
    else:
        logger.info(
            "Using uploaded/existing POP at %s, %s (Location: %s)",
            pop["lon"],
            pop["lat"],
            pop["name"],
        )

    # Reuse the complete derived core for an identical CORE request. The raw
    # OSM tile cache alone does not avoid clustering and cable routing, which
    # are the expensive stages for large boundaries.
    cached_core = _load_reusable_core(
        boundary_path,
        pop_path,
        has_custom_pop,
        config,
        cache_dir=cache_dir,
    )
    if cached_core:
        cached_pop, cached_odcs, cached_state, cached_osm_timestamp = cached_core
        if job_id:
            progress_manager.update(
                job_id,
                "EXPORTING",
                "Memakai Network Core cache; clustering dan routing dilewati...",
                85,
            )
        cached_feeder_segments = cached_state.get("feeder_segments", [])
        cached_distribution_segments = cached_state.get("distribution_segments", {})
        export_kmz(
            cached_pop,
            cached_odcs,
            cached_feeder_segments,
            output_kmz,
            include_homepass=False,
            road_graph=None,
            road_feeder=False,
            distribution_segments=cached_distribution_segments,
            boundary=boundary,
            progress_callback=lambda done, total, message: _report_export_progress(
                job_id, done, total, message
            ),
        )
        if output_csv:
            export_csv(
                cached_pop,
                cached_odcs,
                cached_feeder_segments,
                output_csv,
                distribution_segments=cached_distribution_segments,
            )
        logger.info(
            "Generation cache hit selesai dalam %.2fs",
            time.perf_counter() - pipeline_started,
        )
        return (
            cached_pop,
            cached_odcs,
            cached_feeder_segments,
            cached_distribution_segments,
            config,
            cached_osm_timestamp or osm_timestamp,
        )

    # A mismatch means the old derived state must not be used by Homepass.
    # Keep OSM tile checkpoints intact; only invalidate the derived network.
    invalidate_design_state(cache_dir=cache_dir)

    if job_id: progress_manager.update(job_id, "LOADING_ROADS", "Mengambil data jalan & rumah dari OSM...", 30)
    osm_started = time.perf_counter()
    try:
        houses, road_graph = _fetch_osm_tiled(
            boundary,
            pop,
            force_refresh=config.force_refresh_osm,
            job_id=job_id,
            cache_dir=cache_dir,
        )
        if not houses:
            raise NoCustomerFoundError(
                message="Tidak ada rumah yang ditemukan di OpenStreetMap untuk area ini.",
            )
        road_graph = prepare_road_graph(road_graph, config.routing_strategy)
    except NoCustomerFoundError:
        raise
    except Exception as e:
        raise OSMUnavailableError(
            message=f"Gagal mengambil jaringan jalan OSM ({e}). Generate dihentikan agar kabel tidak memotong rel atau sungai.",
        ) from e
    logger.info(
        "Generation stage OSM selesai dalam %.2fs: rumah=%d nodes=%d edges=%d",
        time.perf_counter() - osm_started,
        len(houses),
        len(road_graph.nodes) if road_graph is not None else 0,
        len(road_graph.edges) if road_graph is not None else 0,
    )

    clustering_started = time.perf_counter()
    if job_id: progress_manager.update(job_id, "CLUSTERING", "Membuat cluster ODP & ODC...", 50)
    odcs = build_design(houses=houses, road_graph=road_graph, config=config)
    logger.info(
        "Generation stage clustering selesai dalam %.2fs: odc=%d odp=%d",
        time.perf_counter() - clustering_started,
        len(odcs),
        sum(len(odc.odps) for odc in odcs),
    )

    routing_started = time.perf_counter()
    if job_id: progress_manager.update(job_id, "ROUTING", "Melakukan routing kabel feeder...", 70)
    odc_spacing_started = time.perf_counter()
    if road_graph is not None:
        enforce_min_distance_between_odcs_on_road(road_graph, odcs, min_dist_m=40.0)
    else:
        enforce_min_distance_between_odcs(odcs, min_dist_m=40.0)
    if road_graph is not None:
        rebalance_odps_by_road_connectivity(
            odcs,
            road_graph,
            max_distribution_length_m=config.max_distribution_length_m,
            odc_capacity=config.odc_capacity,
        )
    logger.info(
        "Routing substage ODC spacing selesai dalam %.2fs",
        time.perf_counter() - odc_spacing_started,
    )
    feeder_started = time.perf_counter()
    feeder_segments, odcs = build_feeder_chain(pop, odcs, road_graph=road_graph)
    logger.info(
        "Routing substage feeder selesai dalam %.2fs: segments=%d",
        time.perf_counter() - feeder_started,
        len(feeder_segments),
    )
    distribution_started = time.perf_counter()
    distribution_segments = {}
    for odc in odcs:
        distribution_segments.update(
            build_distribution_tree(
                odc,
                road_graph,
                max_distance_m=config.max_distribution_length_m,
            )
        )
    _require_distribution_connectivity(odcs, distribution_segments)
    logger.info(
        "Routing substage distribution selesai dalam %.2fs",
        time.perf_counter() - distribution_started,
    )
    logger.info(
        "Generation stage routing selesai dalam %.2fs: feeder=%d distribution=%d connected=%d",
        time.perf_counter() - routing_started,
        len(feeder_segments),
        len(distribution_segments),
        sum(1 for item in distribution_segments.values() if item.get("connected")),
    )

    if job_id:
        total_odps = sum(len(odc.odps) for odc in odcs)
        total_houses = sum(len(odp.houses) for odc in odcs for odp in odc.odps)
        progress_manager.update(
            job_id,
            "EXPORTING",
            f"Membuat network core ({total_odps} ODP)...",
            85,
        )
    export_kmz(
        pop,
        odcs,
        feeder_segments,
        output_kmz,
        include_homepass=config.include_homepass,
        road_graph=road_graph,
        road_feeder=True,
        distribution_segments=distribution_segments,
        boundary=boundary,
        progress_callback=lambda done, total, message: _report_export_progress(
            job_id, done, total, message
        ),
    )
    logger.info(
        "Generation stage export selesai; total pipeline %.2fs",
        time.perf_counter() - pipeline_started,
    )
    # Persist only after the core export has successfully produced all
    # distribution geometries. Homepass can then reuse this exact network.
    try:
        # The dict is passed by reference to export_kmz and is now populated.
        save_design_state(
            pop,
            odcs,
            road_graph=road_graph,
            cache_dir=cache_dir,
            feeder_segments=feeder_segments,
            distribution_segments=distribution_segments,
            distribution_max_length_m=config.max_distribution_length_m,
            boundary=boundary,
        )
    except Exception as e:
        logger.exception("Gagal menyimpan network core state")
        raise ExportFailedError(
            message="Network Core berhasil dibuat tetapi cache untuk Homepass gagal disimpan. Jalankan Generate Design ulang.",
        ) from e
    try:
        _save_core_manifest(
            boundary_path,
            pop_path,
            has_custom_pop,
            config,
            osm_timestamp,
            cache_dir=cache_dir,
        )
    except Exception as e:
        logger.warning("Network Core tersimpan tetapi manifest cache gagal dibuat: %s", e)
    if output_csv:
        try:
            export_csv(
                pop,
                odcs,
                feeder_segments,
                output_csv,
                distribution_segments=distribution_segments,
            )
        except Exception as e:
            logger.warning("Gagal generate CSV (%s)", e)

    return pop, odcs, feeder_segments, distribution_segments, config, osm_timestamp
