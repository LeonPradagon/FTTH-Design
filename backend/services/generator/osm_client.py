import osmnx as ox
import time
from shapely.geometry import Point
from shapely.ops import unary_union

ox.settings.timeout = 20

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api",
    "https://lz4.overpass-api.de/api",
    "https://overpass.kumi.systems/api",
    "https://overpass.osm.ch/api",
]

def safe_features_from_polygon(*args, **kwargs):
    import osmnx as ox
    last_err = None
    for ep in OVERPASS_ENDPOINTS:
        ox.settings.overpass_url = ep
        try:
            return ox.features_from_polygon(*args, **kwargs)
        except Exception as e:
            last_err = e
            print(f"  OSM Endpoint {ep} gagal: {type(e).__name__}")
    if last_err is not None:
        raise last_err
    raise Exception("All endpoints failed")

def safe_graph_from_polygon(*args, **kwargs):
    import osmnx as ox
    last_err = None
    for ep in OVERPASS_ENDPOINTS:
        ox.settings.overpass_url = ep
        try:
            return ox.graph_from_polygon(*args, **kwargs)
        except Exception as e:
            last_err = e
            print(f"  OSM Endpoint {ep} gagal: {type(e).__name__}")
    if last_err is not None:
        raise last_err
    raise Exception("All endpoints failed")

def fetch_houses_in_boundary(polygon):
    """Ambil titik centroid tiap bangunan di dalam boundary dari OpenStreetMap
    memakai osmnx. Butuh koneksi internet aktif."""
    import osmnx as ox

    print("Mengambil data bangunan dari OpenStreetMap...")
    try:
        gdf = safe_features_from_polygon(polygon, tags={"building": True})
        gdf = gdf[gdf.geometry.type.isin(["Polygon", "MultiPolygon", "Point"])]
    except Exception as e:
        print(f"OSMnx error saat mengambil bangunan: {e}")
        return []

    houses = []
    for _, row in gdf.iterrows():
        geom = row.geometry
        centroid = geom if geom.geom_type == "Point" else geom.centroid
        if polygon.contains(centroid):
            houses.append((centroid.y, centroid.x))  # simpan sebagai (lat, lon)

    print(f"Ditemukan {len(houses)} bangunan di dalam boundary.")
    return houses


def find_strategic_pop(boundary, buffer_deg=0.01):
    """Cari lokasi POP strategis: 1. Stasiun Kereta, 2. Jalan Raya Utama, 3. Sembarang Jalan."""
    import osmnx as ox
    from shapely.geometry import Point
    
    search_area = boundary.buffer(buffer_deg)
    
    # 1. Cari Gedung Stasiun Kereta Api (supaya tidak di atas rel)
    try:
        stations = safe_features_from_polygon(search_area, tags={'building': 'train_station'})
        if not stations.empty:
            for _, row in stations.iterrows():
                geom = row.geometry
                pt = geom if geom.geom_type == "Point" else geom.centroid
                return {"name": row.get('name', 'Gedung Stasiun Kereta'), "lon": pt.x, "lat": pt.y}
    except Exception:
        pass
        
    # 2. Cari Jalan Raya Utama
    try:
        main_roads = safe_features_from_polygon(search_area, tags={'highway': ['primary', 'secondary', 'trunk', 'tertiary']})
        if not main_roads.empty:
            geom = main_roads.iloc[0].geometry
            pt = geom if geom.geom_type == "Point" else geom.centroid
            # Jika centroid dari LineString terhitung di luar Line, kita bisa ambil titik pertama
            if geom.geom_type in ["LineString", "MultiLineString"]:
                pt = Point(geom.coords[0]) if geom.geom_type == "LineString" else Point(geom.geoms[0].coords[0])
            name = main_roads.iloc[0].get('name', 'Jalan Utama')
            if not isinstance(name, str): name = 'Jalan Utama'
            return {"name": name, "lon": pt.x, "lat": pt.y}
    except Exception:
        pass
        
    # 3. Cari Sembarang Jalan
    try:
        any_roads = safe_features_from_polygon(search_area, tags={'highway': True})
        if not any_roads.empty:
            geom = any_roads.iloc[0].geometry
            pt = geom if geom.geom_type == "Point" else geom.centroid
            if geom.geom_type in ["LineString", "MultiLineString"]:
                pt = Point(geom.coords[0]) if geom.geom_type == "LineString" else Point(geom.geoms[0].coords[0])
            name = any_roads.iloc[0].get('name', 'Jalan Perumahan')
            if not isinstance(name, str): name = 'Jalan Perumahan'
            return {"name": name, "lon": pt.x, "lat": pt.y}
    except Exception:
        pass
        
    # Fallback darurat jika benar-benar tidak ada data apapun di OSM
    return {"name": "Auto POP (Titik Tengah)", "lon": boundary.centroid.x, "lat": boundary.centroid.y}


def fetch_road_graph(boundary, pop, buffer_deg=0.002):
    """Ambil graf jaringan jalan (drive network) dari OpenStreetMap yang
    mencakup boundary + lokasi POP (POP kadang berada di luar boundary).
    Butuh koneksi internet. Return None kalau gagal -- caller wajib fallback
    ke garis lurus."""
    import osmnx as ox
    import time

    print("Mengambil data jaringan jalan dari OpenStreetMap...")
    combined = unary_union([boundary, Point(pop["lon"], pop["lat"])])
    query_area = combined.convex_hull.buffer(buffer_deg)
    
    try:
        G = safe_graph_from_polygon(query_area, network_type="all")
        G = ox.truncate.largest_component(G, strongly=False)
        G = ox.convert.to_undirected(G)
        print(f"  Graf jalan (Smart Routing): {len(G.nodes)} node, {len(G.edges)} edge.")
        return G
    except Exception as e:
        print(f"  Gagal mengambil jalan dari OSM (semua endpoint mati): {e}")
        raise
