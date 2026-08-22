"""Core generation logic — orchestrates clustering, routing, and export.

This module coordinates the full FTTH design pipeline and manages the
``design_state.json`` / ``road_graph.pkl`` caches used for regeneration.
"""

import os
import json
import pickle
from shapely.geometry import Polygon
from backend.core.logging import logger
from backend.core.errors import (
    DesignStateNotFoundError,
    InvalidFileError,
    OSMUnavailableError,
    RoadGraphUnavailableError,
    RoutingFailedError,
)
from backend.services.generator.models import Splitter, ODP, ODC
from backend.services.generator.osm_local import fetch_road_graph
from backend.services.generator.routing import (
    build_feeder_segments_preserving_order,
    build_feeder_chain,
    prepare_road_graph,
    snap_to_road,
)
from backend.services.generator.kml_builder import export_kmz
from backend.services.generator.csv_exporter import export_csv
from backend.services.generator.kml_parser import read_custom_mapped_kml
from backend.utils.geometry import haversine_m
from backend.services.generator.progress import progress_manager

CACHE_DIR = os.path.abspath("cache")


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


def _cache_paths(cache_dir=None):
    resolved_cache_dir = os.path.abspath(cache_dir or CACHE_DIR)
    return (
        resolved_cache_dir,
        os.path.join(resolved_cache_dir, "design_state.json"),
        os.path.join(resolved_cache_dir, "road_graph.pkl"),
    )


def save_design_state(pop, odcs, road_graph=None, cache_dir=None):
    """Simpan posisi POP, ODC, ODP, dan rumah ke file JSON, serta road graph
    ke pickle. Ini memungkinkan regenerate kabel tanpa menjalankan ulang
    clustering & placement dari awal."""
    resolved_cache_dir, design_state_path, road_graph_path = _cache_paths(cache_dir)
    os.makedirs(resolved_cache_dir, exist_ok=True)

    state = {
        "pop": pop,
        "odcs": [],
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

    with open(design_state_path, "w") as f:
        json.dump(state, f, indent=2)
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
    # Buildings and roads are independent OSM requests. Fetch them in
    # parallel; the whole operation still runs off the async event loop (the
    # endpoint wraps this function in asyncio.to_thread).
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="osm") as executor:
        houses_future = executor.submit(fetch_houses_in_boundary, boundary)
        roads_future = executor.submit(fetch_road_graph, boundary, pop)
        houses = houses_future.result()
        if not houses:
            # Make sure the road request is observed before leaving the pool.
            roads_future.result()
            raise NoCustomerFoundError(
                message="Tidak ada rumah yang ditemukan di OpenStreetMap untuk area ini.",
            )
        try:
            road_graph = roads_future.result()
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

    try:
        save_design_state(pop, odcs, road_graph=road_graph, cache_dir=cache_dir)
    except Exception as e:
        logger.warning("Gagal menyimpan design state (%s)", e)

    if job_id:
        total_odps = sum(len(odc.odps) for odc in odcs)
        total_houses = sum(len(odp.houses) for odc in odcs for odp in odc.odps)
        progress_manager.update(
            job_id,
            "EXPORTING",
            f"Membuat output KMZ ({total_odps} ODP, {total_houses} HC)...",
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
        progress_callback=lambda done, total, message: _report_export_progress(
            job_id, done, total, message
        ),
    )
    if output_csv:
        try:
            export_csv(pop, odcs, feeder_segments, output_csv)
        except Exception as e:
            logger.warning("Gagal generate CSV (%s)", e)

    return pop, odcs, feeder_segments, config, osm_timestamp
