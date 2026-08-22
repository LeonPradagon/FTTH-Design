"""
osm_local.py – Modul pengganti osm_client.py dengan Aggressive Local Caching.

Strategi:
1. Setiap kali query OSM berhasil, hasilnya di-cache ke file GeoPackage lokal.
2. Query berikutnya untuk area yang sama langsung dibaca dari disk (instant, <1 detik).
3. Jika cache tidak ada, query Overpass API dengan multi-endpoint fallback.
4. Cache di-group per "region tile" (grid 0.05° x 0.05°) agar area
   yang berdekatan bisa menggunakan cache yang sama.

Keuntungan vs osm_client.py biasa:
- Query kedua dan seterusnya: 0.1-0.5 detik (vs 20-300 detik online)
- Tidak ada timeout untuk area yang sudah pernah di-query
- Backward-compatible (fallback otomatis ke Overpass API)
"""

import os
import time
import math
import hashlib
import geopandas as gpd
import osmnx as ox
import networkx as nx
from shapely.geometry import Point, box
from shapely.ops import unary_union

from backend.core.logging import logger
from backend.services.generator.routing import prepare_road_graph

# ========== Config ==========
CACHE_DIR = os.path.abspath("cache")
REGION_CACHE_DIR = os.path.join(CACHE_DIR, "regions")
os.makedirs(REGION_CACHE_DIR, exist_ok=True)

# Grid size for region caching (in degrees)
# 0.05° ≈ 5.5 km — cukup besar untuk mencakup boundary + buffer
GRID_SIZE = 0.05
ROAD_CACHE_VERSION = "v3"
OSM_CACHE_MAX_AGE_SECONDS = int(os.getenv("OSM_CACHE_MAX_AGE_SECONDS", str(24 * 60 * 60)))

# Overpass API endpoints for fallback
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api",
    "https://lz4.overpass-api.de/api",
    "https://overpass.kumi.systems/api",
    "https://overpass.osm.ch/api",
]

ox.settings.timeout = 15
ox.settings.use_cache = True
ox.settings.cache_folder = CACHE_DIR


# ========== Internal Helpers ==========

def _region_key(polygon):
    """Hitung region tile key berdasarkan bounding box polygon.
    Mengembalikan tuple (min_grid_x, min_grid_y, max_grid_x, max_grid_y)."""
    minx, miny, maxx, maxy = polygon.bounds
    gx1 = math.floor(minx / GRID_SIZE) * GRID_SIZE
    gy1 = math.floor(miny / GRID_SIZE) * GRID_SIZE
    gx2 = math.ceil(maxx / GRID_SIZE) * GRID_SIZE
    gy2 = math.ceil(maxy / GRID_SIZE) * GRID_SIZE
    return (round(gx1, 4), round(gy1, 4), round(gx2, 4), round(gy2, 4))


def _region_hash(polygon):
    """Hash singkat untuk region tile."""
    key = _region_key(polygon)
    return hashlib.md5(str(key).encode()).hexdigest()[:10]


def _region_bbox(polygon):
    """Bounding box (Shapely box) untuk region tile."""
    gx1, gy1, gx2, gy2 = _region_key(polygon)
    return box(gx1, gy1, gx2, gy2)


def _cache_is_fresh(path: str, force_refresh: bool = False) -> bool:
    if force_refresh or not os.path.exists(path):
        return False
    metadata_path = f"{path}.meta.json"
    try:
        if os.path.exists(metadata_path):
            import json
            with open(metadata_path) as metadata_file:
                metadata = json.load(metadata_file)
            return float(metadata.get("expires_at", 0)) >= time.time()
    except Exception:
        logger.warning("Metadata cache OSM rusak, memakai mtime: %s", metadata_path)
    return (time.time() - os.path.getmtime(path)) <= OSM_CACHE_MAX_AGE_SECONDS


def _write_cache_metadata(path: str, polygon, feature_count: int, source: str):
    import json
    now = time.time()
    metadata = {
        "created_at": now,
        "expires_at": now + OSM_CACHE_MAX_AGE_SECONDS,
        "bbox": list(polygon.bounds),
        "feature_count": feature_count,
        "source": source,
        "cache_version": ROAD_CACHE_VERSION,
    }
    temporary = f"{path}.meta.json.tmp"
    with open(temporary, "w") as metadata_file:
        json.dump(metadata, metadata_file)
    os.replace(temporary, f"{path}.meta.json")


def _safe_native_features(polygon, tags):
    """Fallback ke Overpass untuk pencarian fitur non-graph (buildings, dll) karena Native API susah di-filter via tag."""
    last_err = None
    for ep in OVERPASS_ENDPOINTS:
        ox.settings.overpass_url = ep
        try:
            return ox.features_from_polygon(polygon, tags=tags)
        except Exception as e:
            last_err = e
            logger.info(f"  Overpass {ep} gagal: {type(e).__name__}")
    if last_err is not None:
        raise last_err
    raise Exception("All endpoints failed")


def _fetch_osm_xml(bbox_str):
    import requests
    url = f'https://api.openstreetmap.org/api/0.6/map?bbox={bbox_str}'
    res = requests.get(url, timeout=15)
    if res.status_code == 200:
        return res.content
    raise Exception(f'Native OSM Error: {res.status_code}')

def _safe_native_graph(polygon, network_type="all"):
    """Query road graph menggunakan Native OSM API. Sangat cepat, jarang timeout."""
    minx, miny, maxx, maxy = polygon.bounds
    bbox_str = f'{minx},{miny},{maxx},{maxy}'
    
    try:
        xml_data = _fetch_osm_xml(bbox_str)
        import tempfile
        with tempfile.NamedTemporaryFile(delete=False, suffix='.xml') as f:
            f.write(xml_data)
            temp_path = f.name
        
        G = ox.graph_from_xml(temp_path)
        os.remove(temp_path)
        return G
    except Exception as e:
        if '400' in str(e):
            logger.info("Area terlalu besar untuk 1 request (>50k nodes). Melakukan split grid...")
            # Split grid 2x2
            midx = (minx + maxx) / 2
            midy = (miny + maxy) / 2
            bboxes = [
                f'{minx},{miny},{midx},{midy}',
                f'{midx},{miny},{maxx},{midy}',
                f'{minx},{midy},{midx},{maxy}',
                f'{midx},{midy},{maxx},{maxy}'
            ]
            import networkx as nx
            from concurrent.futures import ThreadPoolExecutor
            G = nx.MultiDiGraph()
            with ThreadPoolExecutor(max_workers=4) as executor:
                results = list(executor.map(_fetch_osm_xml, bboxes))
            
            for i, xml_data in enumerate(results):
                import tempfile
                with tempfile.NamedTemporaryFile(delete=False, suffix='.xml') as f:
                    f.write(xml_data)
                    temp_path = f.name
                g_part = ox.graph_from_xml(temp_path)
                os.remove(temp_path)
                G = nx.compose(G, g_part)
            return G
        else:
            logger.warning(f"Native OSM API gagal ({e}). Fallback ke Overpass...")
            last_err = None
            for ep in OVERPASS_ENDPOINTS:
                ox.settings.overpass_url = ep
                try:
                    return ox.graph_from_polygon(polygon, network_type=network_type)
                except Exception as e2:
                    last_err = e2
            if last_err is not None:
                raise last_err
            raise Exception("All endpoints failed")


# ========== Cache Layer: Buildings ==========

def _get_buildings_cached(polygon, force_refresh=False):
    """Ambil bangunan dari cache lokal. Return GeoDataFrame atau None."""
    rhash = _region_hash(polygon)
    cache_path = os.path.join(REGION_CACHE_DIR, f"buildings_{rhash}.gpkg")
    
    if os.path.exists(cache_path) and _cache_is_fresh(cache_path, force_refresh):
        logger.info(f"Loading buildings from local cache: {cache_path}")
        try:
            gdf = gpd.read_file(cache_path)
            # Filter ke polygon aktual (cache mungkin lebih luas)
            gdf = gdf[gdf.geometry.intersects(polygon)]
            return gdf
        except Exception as e:
            logger.warning(f"Failed to read cache {cache_path}: {e}")
    
    return None


def _save_buildings_cache(polygon, gdf):
    """Simpan bangunan ke cache lokal."""
    rhash = _region_hash(polygon)
    cache_path = os.path.join(REGION_CACHE_DIR, f"buildings_{rhash}.gpkg")
    try:
        # Simpan hanya kolom yang diperlukan
        cols = [c for c in ['building', 'name', 'geometry'] if c in gdf.columns]
        if not cols:
            cols = ['geometry']
        gdf[cols].to_file(cache_path, driver='GPKG')
        _write_cache_metadata(cache_path, polygon, len(gdf), "overpass")
        logger.info(f"Cached {len(gdf)} buildings to {cache_path}")
    except Exception as e:
        logger.warning(f"Failed to save buildings cache: {e}")


# ========== Cache Layer: Road Graph ==========

def _get_road_graph_cached(polygon, force_refresh=False):
    """Ambil road graph dari cache GraphML lokal. Return nx.Graph atau None."""
    rhash = _region_hash(polygon)
    cache_paths = [
        os.path.join(REGION_CACHE_DIR, f"roads_{ROAD_CACHE_VERSION}_{rhash}.graphml"),
        os.path.join(REGION_CACHE_DIR, f"roads_v2_{rhash}.graphml"),
        os.path.join(REGION_CACHE_DIR, f"roads_{rhash}.graphml"),
    ]

    for cache_path in cache_paths:
        if not os.path.exists(cache_path) or not _cache_is_fresh(cache_path, force_refresh):
            continue
        logger.info(f"Loading road graph from local cache: {cache_path}")
        try:
            G = ox.load_graphml(cache_path)
            G = prepare_road_graph(G)
            if f"roads_{ROAD_CACHE_VERSION}_" not in os.path.basename(cache_path):
                _save_road_graph_cache(polygon, G)
            return G
        except Exception as e:
            logger.warning(f"Failed to read road graph cache: {e}")

    return None


def _save_road_graph_cache(polygon, G):
    """Simpan road graph ke cache GraphML lokal."""
    rhash = _region_hash(polygon)
    cache_path = os.path.join(REGION_CACHE_DIR, f"roads_{ROAD_CACHE_VERSION}_{rhash}.graphml")
    try:
        ox.save_graphml(G, cache_path)
        _write_cache_metadata(cache_path, polygon, len(G.nodes), "osm")
        logger.info(f"Cached road graph ({len(G.nodes)} nodes) to {cache_path}")
    except Exception as e:
        logger.warning(f"Failed to save road graph cache: {e}")


# ========== Cache Layer: POIs (Stations) ==========

def _get_pois_cached(polygon, tag_key, tag_value):
    """Ambil POIs dari cache lokal."""
    rhash = _region_hash(polygon)
    cache_path = os.path.join(REGION_CACHE_DIR, f"pois_{tag_key}_{tag_value}_{rhash}.gpkg")
    
    if os.path.exists(cache_path):
        logger.info(f"Loading POIs from local cache: {cache_path}")
        try:
            gdf = gpd.read_file(cache_path)
            gdf = gdf[gdf.geometry.intersects(polygon)]
            return gdf
        except Exception as e:
            logger.warning(f"Failed to read POI cache: {e}")
    
    return None


def _save_pois_cache(polygon, gdf, tag_key, tag_value):
    """Simpan POIs ke cache lokal."""
    rhash = _region_hash(polygon)
    cache_path = os.path.join(REGION_CACHE_DIR, f"pois_{tag_key}_{tag_value}_{rhash}.gpkg")
    try:
        cols = [c for c in ['name', 'geometry'] if c in gdf.columns]
        if not cols:
            cols = ['geometry']
        gdf[cols].to_file(cache_path, driver='GPKG')
        logger.info(f"Cached {len(gdf)} POIs to {cache_path}")
    except Exception as e:
        logger.warning(f"Failed to save POI cache: {e}")


# =============================================================
# PUBLIC API — Pengganti fungsi-fungsi di osm_client.py
# =============================================================

def fetch_houses_in_boundary(polygon, force_refresh=False):
    """Ambil titik centroid tiap bangunan di dalam boundary.
    Cache-first: baca dari disk jika tersedia, lalu Overpass API."""
    
    print("Mengambil data bangunan...")
    start = time.time()
    
    # 1. Cek cache lokal
    region = _region_bbox(polygon)
    cached = _get_buildings_cached(region, force_refresh=force_refresh)
    
    if cached is not None and not cached.empty:
        # Filter ke polygon aktual
        houses = []
        for _, row in cached.iterrows():
            geom = row.geometry
            if geom is None:
                continue
            centroid = geom if geom.geom_type == "Point" else geom.centroid
            if polygon.contains(centroid):
                houses.append((centroid.y, centroid.x))
        
        if houses:
            elapsed = time.time() - start
            print(f"Ditemukan {len(houses)} bangunan di dalam boundary. ({elapsed:.1f}s, dari cache lokal)")
            return houses
    
    # 2. Fallback ke Overpass API
    print("  Cache lokal tidak tersedia, mengambil dari OpenStreetMap...")
    try:
        gdf = _safe_native_features(polygon, tags={"building": True})
        gdf = gdf[gdf.geometry.type.isin(["Polygon", "MultiPolygon", "Point"])]
        
        # Simpan ke cache
        _save_buildings_cache(region, gdf)
        
        houses = []
        for _, row in gdf.iterrows():
            geom = row.geometry
            centroid = geom if geom.geom_type == "Point" else geom.centroid
            if polygon.contains(centroid):
                houses.append((centroid.y, centroid.x))
        
        elapsed = time.time() - start
        print(f"Ditemukan {len(houses)} bangunan di dalam boundary. ({elapsed:.1f}s, dari Overpass API)")
        return houses
        
    except Exception as e:
        print(f"OSMnx error saat mengambil bangunan: {e}")
        return []


def find_strategic_pop(boundary, buffer_deg=0.01):
    """Cari lokasi POP strategis.
    Prioritas bisnis: 1. Stasiun, 2. Kantor, 3. Jalan Raya Utama,
    4. Sembarang Jalan.
    """
    
    search_area = boundary.buffer(buffer_deg)
    region = _region_bbox(search_area)

    def feature_point_and_name(features, fallback_name):
        if features is None or features.empty:
            return None
        for _, row in features.iterrows():
            geom = row.geometry
            if geom is None:
                continue
            pt = geom if geom.geom_type == "Point" else geom.centroid
            name = row.get('name', fallback_name) if hasattr(row, 'get') else fallback_name
            if not isinstance(name, str) or not name.strip():
                name = fallback_name
            return {"name": name, "lon": pt.x, "lat": pt.y}
        return None

    # 1. Cari stasiun kereta sesuai lokasi bisnis POP.
    try:
        stations = _get_pois_cached(region, 'building', 'train_station')
        if stations is None or stations.empty:
            stations = _safe_native_features(
                search_area,
                tags={'building': 'train_station', 'railway': 'station'},
            )
            if not stations.empty:
                _save_pois_cache(region, stations, 'building', 'train_station')
        else:
            stations = stations[stations.geometry.intersects(search_area)]
        result = feature_point_and_name(stations, 'Stasiun Kereta')
        if result:
            return result
    except Exception as e:
        logger.info(f"Station search skipped: {e}")

    # 2. Jika tidak ada stasiun, cari gedung/peruntukan kantor.
    try:
        offices = _get_pois_cached(region, 'office', 'any')
        if offices is None or offices.empty:
            offices = _safe_native_features(
                search_area,
                tags={'office': True, 'building': 'office'},
            )
            if not offices.empty:
                _save_pois_cache(region, offices, 'office', 'any')
        else:
            offices = offices[offices.geometry.intersects(search_area)]
        result = feature_point_and_name(offices, 'Kantor POP')
        if result:
            return result
    except Exception as e:
        logger.info(f"Office search skipped: {e}")
    
    # 3. Cari Jalan Raya Utama
    try:
        cached = _get_pois_cached(region, 'highway', 'main')
        if cached is not None and not cached.empty:
            main_roads = cached[cached.geometry.intersects(search_area)]
        else:
            main_roads = _safe_native_features(search_area, tags={'highway': ['primary', 'secondary', 'trunk', 'tertiary']})
            if not main_roads.empty:
                _save_pois_cache(region, main_roads, 'highway', 'main')
        
        if not main_roads.empty:
            geom = main_roads.iloc[0].geometry
            if geom.geom_type in ["LineString", "MultiLineString"]:
                pt = Point(geom.coords[0]) if geom.geom_type == "LineString" else Point(geom.geoms[0].coords[0])
            else:
                pt = geom.centroid
            name = main_roads.iloc[0].get('name', 'Jalan Utama') if hasattr(main_roads.iloc[0], 'get') else 'Jalan Utama'
            if not isinstance(name, str):
                name = 'Jalan Utama'
            return {"name": name, "lon": pt.x, "lat": pt.y}
    except Exception as e:
        logger.info(f"Main road search skipped: {e}")
    
    # 4. Cari Sembarang Jalan
    try:
        any_roads = _safe_native_features(search_area, tags={'highway': True})
        if not any_roads.empty:
            geom = any_roads.iloc[0].geometry
            if geom.geom_type in ["LineString", "MultiLineString"]:
                pt = Point(geom.coords[0]) if geom.geom_type == "LineString" else Point(geom.geoms[0].coords[0])
            else:
                pt = geom.centroid
            name = any_roads.iloc[0].get('name', 'Jalan Perumahan') if hasattr(any_roads.iloc[0], 'get') else 'Jalan Perumahan'
            if not isinstance(name, str):
                name = 'Jalan Perumahan'
            return {"name": name, "lon": pt.x, "lat": pt.y}
    except Exception as e:
        logger.info(f"Any road search skipped: {e}")
    
    # Fallback darurat
    return {"name": "Auto POP (Titik Tengah)", "lon": boundary.centroid.x, "lat": boundary.centroid.y}


def fetch_road_graph(boundary, pop, buffer_deg=0.002, force_refresh=False):
    """Ambil graf jaringan jalan.
    Cache-first: baca dari GraphML lokal jika tersedia."""
    
    print("Mengambil data jaringan jalan...")
    start = time.time()
    
    combined = unary_union([boundary, Point(pop["lon"], pop["lat"])])
    query_area = combined.convex_hull.buffer(buffer_deg)
    region = _region_bbox(query_area)
    
    # 1. Cek cache lokal (GraphML)
    cached_graph = _get_road_graph_cached(region, force_refresh=force_refresh)
    if cached_graph is not None:
        G = prepare_road_graph(cached_graph)
        G = ox.truncate.largest_component(G, strongly=False)
        G = ox.convert.to_undirected(G)
        elapsed = time.time() - start
        print(f"  Graf jalan: {len(G.nodes)} node, {len(G.edges)} edge. ({elapsed:.1f}s, dari cache lokal)")
        return G
    
    # 2. Fallback ke Overpass API
    print("  Cache lokal tidak tersedia, mengambil dari OpenStreetMap...")
    try:
        G = _safe_native_graph(query_area, network_type="drive")
        G = prepare_road_graph(G)
        G = ox.truncate.largest_component(G, strongly=False)
        G_undirected = ox.convert.to_undirected(G)
        
        # Simpan ke cache (simpan versi directed agar bisa di-load ulang oleh OSMnx)
        _save_road_graph_cache(region, G)
        
        elapsed = time.time() - start
        print(f"  Graf jalan: {len(G_undirected.nodes)} node, {len(G_undirected.edges)} edge. ({elapsed:.1f}s, dari Overpass API)")
        return G_undirected
        
    except Exception as e:
        elapsed = time.time() - start
        print(f"  Gagal mengambil jalan ({elapsed:.1f}s): {e}")
        raise
