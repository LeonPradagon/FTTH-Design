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

# ========== Config ==========
CACHE_DIR = os.path.abspath("cache")
REGION_CACHE_DIR = os.path.join(CACHE_DIR, "regions")
os.makedirs(REGION_CACHE_DIR, exist_ok=True)

# Grid size for region caching (in degrees)
# 0.05° ≈ 5.5 km — cukup besar untuk mencakup boundary + buffer
GRID_SIZE = 0.05
ROAD_CACHE_VERSION = 2
NATIVE_MAX_SPLIT_DEPTH = 5
NATIVE_TILE_WORKERS = 4

# Overpass API endpoints for fallback
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api",
    "https://lz4.overpass-api.de/api",
    "https://overpass.kumi.systems/api",
    "https://overpass.osm.ch/api",
]

ox.settings.timeout = 30
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


class NativeOsmApiError(RuntimeError):
    def __init__(self, status_code, detail, bbox):
        self.status_code = status_code
        self.detail = detail
        self.bbox = bbox
        super().__init__(f"Native OSM Error {status_code}: {detail}")


def _bbox_string(bounds):
    return ",".join(f"{value:.7f}" for value in bounds)


def _fetch_osm_xml(bounds):
    import requests

    bbox_str = _bbox_string(bounds)
    url = f"https://api.openstreetmap.org/api/0.6/map?bbox={bbox_str}"
    res = requests.get(url, timeout=20)
    if res.status_code == 200:
        return res.content
    detail = " ".join(res.text.split())[:300] or "respons tanpa keterangan"
    raise NativeOsmApiError(res.status_code, detail, bounds)


def _split_bbox(bounds):
    minx, miny, maxx, maxy = bounds
    midx = (minx + maxx) / 2
    midy = (miny + maxy) / 2
    return [
        (minx, miny, midx, midy),
        (midx, miny, maxx, midy),
        (minx, midy, midx, maxy),
        (midx, midy, maxx, maxy),
    ]


def _fetch_native_xml_tiles(bounds, depth=0):
    """Ambil satu tile; pecah lagi jika Native API menolak karena terlalu padat."""
    try:
        return [_fetch_osm_xml(bounds)]
    except NativeOsmApiError as exc:
        if exc.status_code != 400 or depth >= NATIVE_MAX_SPLIT_DEPTH:
            raise
        logger.info(
            "Native OSM menolak tile level %d (%s); membagi menjadi 4 tile",
            depth,
            _bbox_string(bounds),
        )
        xml_tiles = []
        for child_bounds in _split_bbox(bounds):
            xml_tiles.extend(_fetch_native_xml_tiles(child_bounds, depth + 1))
        return xml_tiles


def _fetch_native_graph(bounds):
    """Ambil graf Native OSM dengan maksimal empat worker dan split adaptif."""
    try:
        xml_tiles = [_fetch_osm_xml(bounds)]
    except NativeOsmApiError as exc:
        if exc.status_code != 400:
            raise
        from concurrent.futures import ThreadPoolExecutor

        child_bounds = _split_bbox(bounds)
        logger.info(
            "Native OSM menolak bbox awal (%s); memulai split adaptif",
            exc.detail,
        )
        with ThreadPoolExecutor(max_workers=NATIVE_TILE_WORKERS) as executor:
            tile_groups = executor.map(
                lambda bbox: _fetch_native_xml_tiles(bbox, depth=1), child_bounds
            )
            xml_tiles = [xml_data for group in tile_groups for xml_data in group]

    graph = None
    for xml_data in xml_tiles:
        graph_part = _graph_from_xml_bytes(xml_data)
        graph = graph_part if graph is None else nx.compose(graph, graph_part)
    if graph is None or graph.number_of_edges() == 0:
        raise ValueError("Native OSM tidak menghasilkan ruas jalan kendaraan")
    logger.info("Native OSM berhasil digabungkan dari %d tile", len(xml_tiles))
    return graph


def _graph_from_xml_bytes(xml_data):
    """Parse respons OSM dan selalu bersihkan file temporer."""
    import tempfile

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".xml") as temp_file:
            temp_file.write(xml_data)
            temp_path = temp_file.name
        return _filter_driveable_edges(ox.graph_from_xml(temp_path))
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)

DRIVEABLE_HIGHWAY_TYPES = {
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "unclassified", "residential", "living_street", "road", "service",
    "track", "motorway_link", "trunk_link", "primary_link",
    "secondary_link", "tertiary_link",
}


def _edge_highway_types(data):
    highway = data.get("highway")
    if isinstance(highway, (list, tuple, set)):
        return {str(value) for value in highway if value}
    return {str(highway)} if highway else set()


def _filter_driveable_edges(graph):
    """Sisakan ruas jalan kendaraan dan buang rel/air/footway/path.

    Edge tanpa tag ``highway`` juga dibuang. Sebelumnya edge tanpa tag justru
    lolos filter sehingga fitur non-jalan bisa menjadi rute kabel.
    """
    edges_to_remove = []
    for u, v, key, data in graph.edges(keys=True, data=True):
        if not (_edge_highway_types(data) & DRIVEABLE_HIGHWAY_TYPES):
            edges_to_remove.append((u, v, key))
    graph.remove_edges_from(edges_to_remove)
    graph.remove_nodes_from(list(nx.isolates(graph)))
    return graph


def prepare_road_graph(graph):
    """Normalisasi graf lama/baru menjadi jaringan jalan kabel yang aman."""
    if graph is None:
        return None
    prepared = _filter_driveable_edges(graph.copy())
    if prepared.number_of_edges() == 0:
        raise ValueError("Graf tidak memiliki ruas jalan kendaraan yang valid")
    if prepared.is_directed():
        prepared = ox.truncate.largest_component(prepared, strongly=False)
        return ox.convert.to_undirected(prepared)
    largest_nodes = max(nx.connected_components(prepared), key=len)
    return prepared.subgraph(largest_nodes).copy()


def _safe_native_graph(polygon, network_type="drive"):
    """Query Native OSM lalu fallback ke Overpass untuk semua jenis kegagalan."""
    native_error = None
    try:
        return _fetch_native_graph(polygon.bounds)
    except Exception as exc:
        native_error = exc
        logger.warning(
            "Native OSM API gagal (%s). Mencoba Overpass...", native_error
        )

    last_error = native_error
    for endpoint in OVERPASS_ENDPOINTS:
        ox.settings.overpass_url = endpoint
        try:
            graph = ox.graph_from_polygon(polygon, network_type=network_type)
            graph = _filter_driveable_edges(graph)
            if graph.number_of_edges() == 0:
                raise ValueError("Overpass tidak menghasilkan ruas jalan kendaraan")
            return graph
        except Exception as overpass_error:
            last_error = overpass_error
            logger.info(
                "Overpass %s gagal: %s", endpoint, type(overpass_error).__name__
            )
    raise RuntimeError(
        f"Semua sumber data jalan OSM gagal. Error terakhir: {last_error}"
    ) from last_error


# ========== Cache Layer: Buildings ==========

def _get_buildings_cached(polygon):
    """Ambil bangunan dari cache lokal. Return GeoDataFrame atau None."""
    rhash = _region_hash(polygon)
    cache_path = os.path.join(REGION_CACHE_DIR, f"buildings_{rhash}.gpkg")
    
    if os.path.exists(cache_path):
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
        logger.info(f"Cached {len(gdf)} buildings to {cache_path}")
    except Exception as e:
        logger.warning(f"Failed to save buildings cache: {e}")


# ========== Cache Layer: Road Graph ==========

def _road_cache_path(polygon, version=ROAD_CACHE_VERSION):
    rhash = _region_hash(polygon)
    suffix = f"v{version}_" if version else ""
    return os.path.join(REGION_CACHE_DIR, f"roads_{suffix}{rhash}.graphml")


def _get_road_graph_cached(polygon):
    """Ambil road graph dari cache GraphML lokal. Return nx.Graph atau None."""
    cache_paths = [_road_cache_path(polygon), _road_cache_path(polygon, version=None)]
    for cache_path in cache_paths:
        if not os.path.exists(cache_path):
            continue
        logger.info(f"Loading road graph from local cache: {cache_path}")
        try:
            graph = _filter_driveable_edges(ox.load_graphml(cache_path))
            if graph.number_of_edges() == 0:
                logger.warning("Road graph cache tidak memiliki ruas jalan valid")
                continue
            # Cache lama dimigrasikan setelah melewati filter baru.
            if cache_path != cache_paths[0]:
                _save_road_graph_cache(polygon, graph)
            return graph
        except Exception as e:
            logger.warning(f"Failed to read road graph cache: {e}")
    return None


def _save_road_graph_cache(polygon, G):
    """Simpan road graph ke cache GraphML lokal."""
    cache_path = _road_cache_path(polygon)
    try:
        ox.save_graphml(G, cache_path)
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

def fetch_houses_in_boundary(polygon):
    """Ambil titik centroid tiap bangunan di dalam boundary.
    Cache-first: baca dari disk jika tersedia, lalu Overpass API."""
    
    print("Mengambil data bangunan...")
    start = time.time()
    
    # 1. Cek cache lokal
    region = _region_bbox(polygon)
    cached = _get_buildings_cached(region)
    
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
    
    # 2. Ambil dari Native OSM (split adaptif), lalu Overpass sebagai fallback.
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
    Prioritas: 1. Gedung Stasiun Kereta, 2. Jalan Raya Utama, 3. Sembarang Jalan."""
    
    search_area = boundary.buffer(buffer_deg)
    region = _region_bbox(search_area)
    
    # 1. Cari Gedung Stasiun Kereta Api
    try:
        cached = _get_pois_cached(region, 'building', 'train_station')
        if cached is not None and not cached.empty:
            stations = cached[cached.geometry.intersects(search_area)]
        else:
            stations_gdf = _safe_native_features(search_area, tags={'building': 'train_station'})
            if not stations_gdf.empty:
                _save_pois_cache(region, stations_gdf, 'building', 'train_station')
            stations = stations_gdf
        
        if not stations.empty:
            for _, row in stations.iterrows():
                geom = row.geometry
                if geom is None:
                    continue
                pt = geom if geom.geom_type == "Point" else geom.centroid
                name = row.get('name', 'Gedung Stasiun Kereta')
                if not isinstance(name, str) or (isinstance(name, float) and math.isnan(name)):
                    name = 'Gedung Stasiun Kereta'
                return {"name": name, "lon": pt.x, "lat": pt.y}
    except Exception as e:
        logger.info(f"Station search skipped: {e}")
    
    # 2. Cari Jalan Raya Utama
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
    
    # 3. Cari Sembarang Jalan
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


def fetch_road_graph(boundary, pop, buffer_deg=0.002):
    """Ambil graf jaringan jalan.
    Cache-first: baca dari GraphML lokal jika tersedia."""
    
    print("Mengambil data jaringan jalan...")
    start = time.time()
    
    combined = unary_union([boundary, Point(pop["lon"], pop["lat"])])
    query_area = combined.convex_hull.buffer(buffer_deg)
    region = _region_bbox(query_area)
    
    # 1. Cek cache lokal (GraphML)
    cached_graph = _get_road_graph_cached(region)
    if cached_graph is not None:
        G = cached_graph
        G = ox.truncate.largest_component(G, strongly=False)
        G = ox.convert.to_undirected(G)
        elapsed = time.time() - start
        print(f"  Graf jalan: {len(G.nodes)} node, {len(G.edges)} edge. ({elapsed:.1f}s, dari cache lokal)")
        return G
    
    # 2. Fallback ke Overpass API
    print("  Cache lokal tidak tersedia, mengambil dari OpenStreetMap...")
    try:
        G = _safe_native_graph(query_area, network_type="drive")
        G = ox.truncate.largest_component(G, strongly=False)
        G_undirected = ox.convert.to_undirected(G)
        
        # Simpan ke cache (simpan versi directed agar bisa di-load ulang oleh OSMnx)
        _save_road_graph_cache(region, G)
        
        elapsed = time.time() - start
        print(
            f"  Graf jalan: {len(G_undirected.nodes)} node, "
            f"{len(G_undirected.edges)} edge. ({elapsed:.1f}s, dari OpenStreetMap)"
        )
        return G_undirected
        
    except Exception as e:
        elapsed = time.time() - start
        print(f"  Gagal mengambil jalan ({elapsed:.1f}s): {e}")
        raise
