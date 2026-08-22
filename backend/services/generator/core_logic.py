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
from shapely.geometry import Polygon, Point, box
from backend.core.logging import logger
from backend.core.errors import (
    DesignStateNotFoundError,
    InvalidFileError,
    OSMUnavailableError,
    RoadGraphUnavailableError,
    RoutingFailedError,
    ExportFailedError,
)
from backend.services.generator.models import Splitter, ODP, ODC
from backend.services.generator.osm_local import fetch_road_graph, fetch_houses_in_boundary
from backend.services.generator.routing import (
    build_feeder_segments_preserving_order,
    build_feeder_chain,
    prepare_road_graph,
    route_along_road,
    snap_to_road,
)
from backend.services.generator.kml_builder import export_kmz
from backend.services.generator.csv_exporter import export_csv
from backend.services.generator.kml_parser import read_custom_mapped_kml
from backend.utils.geometry import haversine_m
from backend.services.generator.progress import progress_manager

CACHE_DIR = os.path.abspath("cache")
NETWORK_STATE_VERSION = 2


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
        progress_manager.update(job_id, "LOADING_ROADS", f"Memproses {len(tiles)} tile OSM...", 30)

    def tile_key(tile):
        return "_".join(f"{value:.6f}" for value in tile.bounds).replace("-", "m").replace(".", "d")

    def fetch_tile(index, tile):
        key = tile_key(tile)
        houses_path = os.path.join(checkpoint_dir, f"{index}_{key}.houses.json") if checkpoint_dir else None
        roads_path = os.path.join(checkpoint_dir, f"{index}_{key}.roads.pkl") if checkpoint_dir else None
        if (not force_refresh and houses_path and roads_path and
                os.path.exists(houses_path) and os.path.exists(roads_path)):
            newest = max(os.path.getmtime(houses_path), os.path.getmtime(roads_path))
            if time.time() - newest <= 24 * 60 * 60:
                try:
                    with open(houses_path) as source:
                        cached_houses = [tuple(item) for item in json.load(source)]
                    with open(roads_path, "rb") as source:
                        return cached_houses, pickle.load(source), True
                except Exception as exc:
                    logger.warning("Tile checkpoint %s tidak dapat dibaca: %s", key, exc)
        houses = fetch_houses_in_boundary(tile, force_refresh=force_refresh)
        roads = fetch_road_graph(tile, pop, force_refresh=force_refresh)
        if houses_path and roads_path:
            temporary_houses = f"{houses_path}.tmp"
            temporary_roads = f"{roads_path}.tmp"
            with open(temporary_houses, "w") as target:
                json.dump(houses, target)
            with open(temporary_roads, "wb") as target:
                pickle.dump(roads, target)
            os.replace(temporary_houses, houses_path)
            os.replace(temporary_roads, roads_path)
        return houses, roads, False

    houses: list[tuple[float, float]] = []
    road_graph = nx.MultiDiGraph()
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="osm-tile") as executor:
        futures = [executor.submit(fetch_tile, index, tile) for index, tile in enumerate(tiles)]
        for index, future in enumerate(futures, start=1):
            tile_houses, tile_graph, from_checkpoint = future.result()
            houses.extend(tile_houses)
            road_graph = nx.compose(road_graph, _normalize_routing_graph(tile_graph))
            if job_id:
                progress_manager.update(
                    job_id, "LOADING_ROADS",
                    f"Memuat tile OSM {index}/{len(tiles)}{' dari cache' if from_checkpoint else ''}...",
                    30 + int(index / len(tiles) * 15),
                )

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


def invalidate_design_state(cache_dir=None):
    """Remove the previous network cache before starting a new core job."""
    _, design_state_path, road_graph_path = _cache_paths(cache_dir)
    for path in (design_state_path, road_graph_path):
        try:
            if os.path.exists(path):
                os.remove(path)
                logger.info("Cache design lama dihapus: %s", path)
        except OSError as exc:
            raise ExportFailedError(
                message="Cache Network Core lama tidak dapat dihapus. Tutup proses generate lain lalu coba lagi.",
            ) from exc


def save_design_state(
    pop,
    odcs,
    road_graph=None,
    cache_dir=None,
    feeder_segments=None,
    distribution_segments=None,
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
        "distribution_segments": distribution_segments or {},
    }
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
            }
            odc_data["odps"].append(odp_data)
        state["odcs"].append(odc_data)

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

    cache_is_complete = (
        state.get("version") == NETWORK_STATE_VERSION
        and isinstance(state.get("feeder_segments"), list)
        and isinstance(state.get("distribution_segments"), dict)
    )

    if not cache_is_complete:
        # Migrate legacy caches in-place when the road graph is available.
        # This avoids another OSM buildings query and another clustering run.
        try:
            pop, odcs = load_design_state(cache_dir=cache_dir)
            road_graph = load_road_graph(cache_dir=cache_dir)
            if road_graph is None:
                raise RuntimeError("road graph cache tidak ditemukan")

            feeder_segments, odcs = build_feeder_segments_preserving_order(
                pop, odcs, road_graph=road_graph
            )
            distribution_segments = {}
            for odc in odcs:
                for odp in odc.odps:
                    path = route_along_road(
                        road_graph,
                        (odc.lat, odc.lon),
                        (odp.lat, odp.lon),
                        use_external_routing=False,
                    )
                    if not path:
                        raise RuntimeError(f"rute distribusi {odc.id} -> {odp.id} tidak ditemukan")
                    distribution_segments[odp.id] = list(path)

            save_design_state(
                pop,
                odcs,
                road_graph=road_graph,
                cache_dir=cache_dir,
                feeder_segments=feeder_segments,
                distribution_segments=distribution_segments,
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
    cached_ids = set(state["distribution_segments"])
    if odp_ids != cached_ids:
        raise DesignStateNotFoundError(
            message="Cache geometri distribusi tidak lengkap. Jalankan Generate Design ulang.",
        )
    return pop, odcs, state


def load_road_graph(cache_dir=None):
    """Muat road graph dari pickle cache. Return None kalau tidak ada."""
    _, _, road_graph_path = _cache_paths(cache_dir)
    if not os.path.exists(road_graph_path):
        return None
    with open(road_graph_path, "rb") as f:
        return prepare_road_graph(pickle.load(f))


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
    pop, odcs = load_design_state(cache_dir=cache_dir)
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
    total_odp = sum(len(odc.odps) for odc in odcs)
    total_houses = sum(len(odp.houses) for odc in odcs for odp in odc.odps)
    logger.info("Loaded: %d ODC, %d ODP, %d rumah", len(odcs), total_odp, total_houses)

    # Route feeder tanpa mengubah urutan ODC (sudah benar dari cache)
    feeder_segments, odcs = build_feeder_segments_preserving_order(pop, odcs, road_graph=road_graph)

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
    distribution_segments = {}
    export_kmz(
        pop,
        odcs,
        feeder_segments,
        output_path,
        include_homepass=include_homepass,
        road_graph=road_graph,
        road_feeder=True,
        progress_callback=lambda done, total, message: _report_export_progress(
            job_id, done, total, message
        ),
    )
    if output_csv:
        try:
            export_csv(pop, odcs, feeder_segments, output_csv)
        except Exception as e:
            logger.warning("Gagal generate CSV: %s", e)
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
        raise InvalidFileError(
            message="Tidak ditemukan titik OLT/POP di file custom KML. Pastikan ada nama yang mengandung 'OLT' atau 'POP'.",
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
        
    for odp in odp_objects:
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
    
    if job_id: progress_manager.update(job_id, "EXPORTING", "Mengekspor ke KMZ dengan jalur kabel...", 85)
    # 5. Export (otomatis melakukan routing Distribusi & Drop)
    logger.info("Mengekspor ke KMZ dengan jalur kabel...")
    export_kmz(
        pop, odcs, feeder_segments, output_path,
        include_homepass=include_homepass,
        road_graph=road_graph,
        road_feeder=(road_graph is not None),
        progress_callback=lambda done, total, message: _report_export_progress(
            job_id, done, total, message
        ),
    )
    
    # 6. Cache design state untuk fitur regenerate-cables
    try:
        save_design_state(pop, odcs, road_graph=road_graph, cache_dir=cache_dir)
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
        export_csv(pop, odcs, feeder_segments, output_csv)
    if job_id:
        progress_manager.update(job_id, "EXPORTING", "Homepass selesai, menyiapkan output...", 90)
    return pop, odcs, feeder_segments


import hashlib
import zipfile
import math
import time
import glob
from datetime import datetime, timezone
from backend.core.errors import ExportFailedError, PopTooFarError, NoCustomerFoundError
from backend.services.generator.kml_parser import read_boundary, read_points, read_pop_point
from backend.services.generator.osm_local import fetch_houses_in_boundary, find_strategic_pop
from backend.services.generator.clustering import build_design
from backend.services.generator.routing import enforce_min_distance_between_odcs, enforce_min_distance_between_odcs_on_road
from backend.services.generator.generation_config import GenerationConfig
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
        from backend.services.generator.osm_local import find_strategic_pop

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

    if job_id: progress_manager.update(job_id, "LOADING_ROADS", "Mengambil data jalan & rumah dari OSM...", 30)
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
    except NoCustomerFoundError:
        raise
    except Exception as e:
        raise OSMUnavailableError(
            message=f"Gagal mengambil jaringan jalan OSM ({e}). Generate dihentikan agar kabel tidak memotong rel atau sungai.",
        ) from e

    if job_id: progress_manager.update(job_id, "CLUSTERING", "Membuat cluster ODP & ODC...", 50)
    odcs = build_design(houses=houses, road_graph=road_graph, config=config)
    
    if job_id: progress_manager.update(job_id, "ROUTING", "Melakukan routing kabel feeder...", 70)
    if road_graph is not None:
        enforce_min_distance_between_odcs_on_road(road_graph, odcs, min_dist_m=40.0)
    else:
        enforce_min_distance_between_odcs(odcs, min_dist_m=40.0)
    feeder_segments, odcs = build_feeder_chain(pop, odcs, road_graph=road_graph)
    distribution_segments = {}

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
        progress_callback=lambda done, total, message: _report_export_progress(
            job_id, done, total, message
        ),
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
        )
    except Exception as e:
        logger.exception("Gagal menyimpan network core state")
        raise ExportFailedError(
            message="Network Core berhasil dibuat tetapi cache untuk Homepass gagal disimpan. Jalankan Generate Design ulang.",
        ) from e
    if output_csv:
        try:
            export_csv(pop, odcs, feeder_segments, output_csv)
        except Exception as e:
            logger.warning("Gagal generate CSV (%s)", e)

    return pop, odcs, feeder_segments, config, osm_timestamp
