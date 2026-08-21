import os
import json
import pickle
from shapely.geometry import Polygon
from backend.core.logging import logger
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

CACHE_DIR = os.path.abspath("cache")

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
    print(f"Design state disimpan di: {design_state_path}")

    if road_graph is not None:
        with open(road_graph_path, "wb") as f:
            pickle.dump(road_graph, f)
        print(f"Road graph disimpan di: {road_graph_path}")
    elif os.path.exists(road_graph_path):
        # Jangan gunakan graph dari design sebelumnya saat pengambilan OSM terbaru gagal.
        os.remove(road_graph_path)


def load_design_state(cache_dir=None):
    """Muat design state dari cache JSON. Return (pop, odcs) yang siap dipakai
    untuk regenerate kabel. Raise FileNotFoundError kalau belum pernah generate."""
    _, design_state_path, _ = _cache_paths(cache_dir)
    if not os.path.exists(design_state_path):
        raise FileNotFoundError(
            "Belum ada design state yang tersimpan. Jalankan 'Generate Design' terlebih dahulu."
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
                    ratio=odp_data["splitter_ratio"] or "1:8",
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


def regenerate_cables_only(output_path, include_homepass=False, output_csv=None, cache_dir=None):
    """Regenerate HANYA jalur kabel (feeder, distribusi, drop) tanpa mengubah
    posisi ODC/ODP/tiang/rumah. Membaca posisi dari design state cache dan
    road graph dari pickle cache, lalu menjalankan routing + export KMZ.

    Return: path output KMZ yang dihasilkan."""
    print("=" * 60)
    print("REGENERATE KABEL ONLY — posisi tiang/ODC/ODP/rumah TETAP")
    print("=" * 60)

    _, _, road_graph_path = _cache_paths(cache_dir)
    pop, odcs = load_design_state(cache_dir=cache_dir)
    road_graph = load_road_graph(cache_dir=cache_dir)

    logger.info(f"load_road_graph returned: {'None' if road_graph is None else 'Graph with ' + str(len(road_graph.nodes)) + ' nodes'}")

    if road_graph is None:
        logger.warning("road graph cache tidak ditemukan. Mencoba mengunduh ulang dari OSM...")
        print("  Peringatan: road graph cache tidak ditemukan. Mencoba mengunduh ulang dari OSM...")
        all_lats = [pop["lat"]] + [odc.lat for odc in odcs] + [odp.lat for odc in odcs for odp in odc.odps]
        all_lons = [pop["lon"]] + [odc.lon for odc in odcs] + [odp.lon for odc in odcs for odp in odc.odps]
        
        if all_lats and all_lons:
            from shapely.geometry import Polygon
            min_lat, max_lat = min(all_lats), max(all_lats)
            min_lon, max_lon = min(all_lons), max(all_lons)
            bbox = Polygon([
                (min_lon, min_lat), (min_lon, max_lat),
                (max_lon, max_lat), (max_lon, min_lat)
            ])
            try:
                logger.info(f"Fetching road graph for bbox: {bbox}")
                road_graph = fetch_road_graph(bbox, pop, buffer_deg=0.015)
                if road_graph is not None:
                    # Simpan ke cache agar percobaan berikutnya lebih cepat
                    import pickle
                    with open(road_graph_path, "wb") as f:
                        pickle.dump(road_graph, f)
                    logger.info("Successfully fetched and cached road graph.")
                else:
                    logger.warning("fetch_road_graph returned None")
            except Exception as e:
                logger.exception(f"Gagal mengunduh ulang road graph ({e}); regenerate akan dihentikan.")
                print(f"  Peringatan: Gagal mengunduh ulang road graph ({e}); regenerate akan dihentikan.")
        else:
            logger.warning("Tidak ada data koordinat untuk mengunduh road graph; regenerate akan dihentikan.")
            print("  Peringatan: Tidak ada data koordinat untuk mengunduh road graph; regenerate akan dihentikan.")

    if road_graph is None:
        raise RuntimeError(
            "Jaringan jalan OSM tidak tersedia. Regenerate dihentikan agar kabel tidak dibuat sebagai garis lurus."
        )

    total_odp = sum(len(odc.odps) for odc in odcs)
    total_houses = sum(len(odp.houses) for odc in odcs for odp in odc.odps)
    print(f"  Loaded: {len(odcs)} ODC, {total_odp} ODP, {total_houses} rumah")

    if road_graph is not None:
        import random
        # Variasi kecil untuk alternatif rute tanpa mengalahkan prioritas kelas jalan.
        for u, v, k, data in road_graph.edges(keys=True, data=True):
            if "routing_cost" in data:
                data["routing_cost"] = float(data["routing_cost"]) * random.uniform(0.9, 1.1)

    # Route feeder tanpa mengubah urutan ODC (sudah benar dari cache)
    feeder_segments, odcs = build_feeder_segments_preserving_order(pop, odcs, road_graph=road_graph)

    # Export KMZ dengan routing kabel baru
    export_kmz(pop, odcs, feeder_segments, output_path, include_homepass=include_homepass, road_graph=road_graph, road_feeder=True)
    if output_csv:
        try:
            export_csv(pop, odcs, feeder_segments, output_csv)
        except Exception as e:
            logger.warning(f"Gagal generate CSV: {e}")
    print(f"Selesai! File KMZ disimpan di {output_path}")

    return output_path


def generate_cables_from_custom_points(file_path, output_path, include_homepass=False, output_csv=None, cache_dir=None):
    """
    Men-generate jalur kabel (routing mengikuti jalan OSM) dari file KML custom 
    yang sudah berisi titik-titik mapping OLT, ODC, ODP, dan RUMAH.
    """
    points = read_custom_mapped_kml(file_path)
    
    if not points['olt']:
        raise ValueError("Tidak ditemukan titik OLT/POP di file custom KML. Pastikan ada nama yang mengandung 'OLT' atau 'POP'.")
    if not points['odc']:
        raise ValueError("Tidak ditemukan titik ODC di file custom KML. Pastikan ada nama yang mengandung 'ODC'.")
    if not points['odp']:
        raise ValueError("Tidak ditemukan titik ODP di file custom KML. Pastikan ada nama yang mengandung 'ODP'.")
        
    pop = points['olt'][0]
    
    # 1. Kelompokkan HC ke ODP terdekat
    odp_objects = []
    for odp_pt in points['odp']:
        odp = ODP(id=odp_pt['name'], lat=odp_pt['lat'], lon=odp_pt['lon'], houses=[], splitter=Splitter(ratio="1:8", location="ODP"))
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
        raise ValueError("Tidak ada titik valid dalam KML.")
        
    min_lat, max_lat = min(all_lats), max(all_lats)
    min_lon, max_lon = min(all_lons), max(all_lons)
    
    # Polygon bounding box
    bbox = Polygon([
        (min_lon, min_lat),
        (min_lon, max_lat),
        (max_lon, max_lat),
        (max_lon, min_lat)
    ])
    
    print("Mengambil data jalan untuk custom routing...")
    road_graph = None
    try:
        road_graph = fetch_road_graph(bbox, pop, buffer_deg=0.015)
    except Exception as e:
        raise RuntimeError(
            f"Gagal mengambil data jalan ({e}). Generate dihentikan agar kabel tidak memotong rel atau sungai."
        ) from e

    if road_graph is None:
        raise RuntimeError(
            "Jaringan jalan OSM tidak tersedia. Generate dihentikan agar kabel tidak dibuat sebagai garis lurus."
        )

    try:
        for odc in odcs:
            odc.lat, odc.lon = snap_to_road(road_graph, odc.lat, odc.lon)
            for odp in odc.odps:
                odp.lat, odp.lon = snap_to_road(road_graph, odp.lat, odp.lon)
    except Exception as e:
        raise RuntimeError(f"ODC/ODP custom tidak dapat ditempatkan pada jalan kendaraan: {e}") from e
        
    # 4. Routing Feeder (POP -> ODCs)
    print("Membangun rantai kabel feeder...")
    feeder_segments, odcs = build_feeder_chain(pop, odcs, road_graph=road_graph)
    
    # 5. Export (otomatis melakukan routing Distribusi & Drop)
    print("Mengekspor ke KMZ dengan jalur kabel...")
    export_kmz(
        pop, odcs, feeder_segments, output_path,
        include_homepass=include_homepass,
        road_graph=road_graph,
        road_feeder=(road_graph is not None),
    )
    
    # 6. Cache design state untuk fitur regenerate-cables
    try:
        save_design_state(pop, odcs, road_graph=road_graph, cache_dir=cache_dir)
    except Exception as e:
        print(f"Peringatan: gagal menyimpan custom design state ({e}), regenerate-cables tidak tersedia.")
    
    return output_path
