import osmnx as ox
import time
from shapely.geometry import Point
from shapely.ops import unary_union

def fetch_houses_in_boundary(polygon):
    """Ambil titik centroid tiap bangunan di dalam boundary dari OpenStreetMap
    memakai osmnx. Butuh koneksi internet aktif."""
    import osmnx as ox

    print("Mengambil data bangunan dari OpenStreetMap...")
    try:
        gdf = ox.features_from_polygon(polygon, tags={"building": True})
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


def fetch_road_graph(boundary, pop, buffer_deg=0.01):
    """Ambil graf jaringan jalan (drive network) dari OpenStreetMap yang
    mencakup boundary + lokasi POP (POP kadang berada di luar boundary).
    Butuh koneksi internet. Return None kalau gagal -- caller wajib fallback
    ke garis lurus."""
    import osmnx as ox
    import time

    ox.settings.timeout = 600

    print("Mengambil data jaringan jalan dari OpenStreetMap...")
    combined = unary_union([boundary, Point(pop["lon"], pop["lat"])])
    query_area = combined.convex_hull.buffer(buffer_deg)
    
    for attempt in range(3):
        try:
            G = ox.graph_from_polygon(query_area, network_type="all")
            G = ox.truncate.largest_component(G, strongly=False)
            G = ox.convert.to_undirected(G)
            print(f"  Graf jalan (Smart Routing): {len(G.nodes)} node, {len(G.edges)} edge.")
            return G
        except Exception as e:
            print(f"  Percobaan {attempt+1} gagal mengambil jalan dari OSM: {e}")
            if attempt == 2:
                raise
            time.sleep(2)
