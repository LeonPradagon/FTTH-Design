#!/usr/bin/env python3
"""
FTTH Auto Design Generator
===========================
Membaca file boundary (area cakupan) dan titik POP/OLT dalam format KML/KMZ,
mengambil data rumah (building footprint) di dalam boundary dari OpenStreetMap,
lalu menjalankan desain FTTH otomatis:

  - Clustering rumah  -> ODP (splitter 1:8 per default, bisa diubah)
  - Clustering ODP    -> ODC (1 ODC melayani N ODP, default 8)
  - Membuat closure di setiap ODC
  - Kabel feeder dirutekan MENGIKUTI JALAN RAYA, berbentuk RANTAI/CHAIN:
        POP -> ODC-1 -> ODC-2 -> ODC-3 -> ...
    (bukan star / langsung dari POP ke tiap ODC)
  - Posisi ODC & ODP OTOMATIS DIGESER KE PINGGIR JALAN terdekat (bukan lagi
    di titik tengah cluster rumah yang bisa jatuh di tengah kebun/hutan)
  - Kabel distribusi (ODC-ODP) & drop (ODP-rumah) masih garis lurus
  - Output topologi lengkap sebagai satu file KMZ siap dibuka di Google Earth

Instalasi dependency:
    pip install shapely simplekml osmnx networkx numpy

Contoh pemakaian:
    # Mode 1 file gabungan (boundary Polygon + titik POP ada di file yang sama,
    # misal hasil gambar langsung dari Google Earth Pro)
    python ftth_design_generator.py --input area_dan_pop.kmz --output design_ftth.kmz

    # Mode 2 file terpisah
    python ftth_design_generator.py --boundary boundary.kml --pop pop.kml --output design_ftth.kmz

    # Kapasitas custom (misal splitter 1:16 di ODP, 1 ODC melayani 4 ODP)
    python ftth_design_generator.py --input area_dan_pop.kmz \
        --odp-capacity 16 --odc-capacity 4 --output design_ftth.kmz

    # Matikan routing jalan untuk feeder (pakai garis lurus, lebih cepat / kalau area minim data jalan)
    python ftth_design_generator.py --input area_dan_pop.kmz --no-road-feeder

    # Pakai titik rumah manual (hasil digitasi sendiri di Google Earth) alih-alih OSM --
    # DIREKOMENDASIKAN kalau data bangunan OpenStreetMap di area kamu masih minim/kosong
    python ftth_design_generator.py --input area_dan_pop.kmz --houses rumah.kmz

    # Fokus hanya untuk 512 homepass (1 ODC:4 ODP, 1 ODP:8 rumah -> otomatis
    # jadi 16 ODC & 64 ODP), rumah dipangkas ke yang terdekat dari POP kalau
    # yang ditemukan di boundary lebih banyak dari 512
    python ftth_design_generator.py --input area_dan_pop.kmz --target-homepass 512

Catatan:
  - File harus berisi minimal satu Polygon (boundary) dan satu Point (lokasi
    POP/OLT). Keduanya boleh ada di file yang sama (mode --input) atau di
    file terpisah (mode --boundary + --pop).
  - Jika ada lebih dari satu Point di dalam file, titik pertama yang
    ditemukan dipakai sebagai POP/OLT, sisanya diabaikan (muncul notifikasi
    di terminal).
  - Pengambilan data rumah & jalan butuh koneksi internet (query ke
    OpenStreetMap lewat osmnx). Untuk area sangat luas, proses ini bisa
    memakan waktu.
  - Kalau di area kamu data jalan OSM minim/tidak lengkap, routing feeder
    otomatis fallback ke garis lurus untuk segmen yang gagal dirutekan
    (akan muncul peringatan di terminal, script tidak berhenti).
"""

import argparse
import math
import sys
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
import argparse
import os
import json
import openai
from dotenv import load_dotenv
import logging

load_dotenv()

# Setup logging
os.makedirs("dashboard/public/data", exist_ok=True)
logging.basicConfig(
    filename='dashboard/public/data/app.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

import numpy as np
from shapely.geometry import Polygon, Point
from shapely.ops import unary_union
import simplekml

KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}


# =============================================================================
# 1. BACA FILE KML / KMZ (boundary & titik POP)
# =============================================================================

def _extract_kml_bytes(path):
    """Ambil isi file .kml mentah, baik dari file .kml langsung maupun dari
    dalam arsip .kmz (kmz = kml yang di-zip)."""
    if path.lower().endswith(".kmz"):
        with zipfile.ZipFile(path, "r") as z:
            kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not kml_name:
                raise ValueError(f"Tidak ditemukan file .kml di dalam arsip: {path}")
            return z.read(kml_name)
    with open(path, "rb") as f:
        return f.read()


def read_boundary(path):
    """Baca Polygon pertama dari file boundary KML/KMZ -> shapely Polygon."""
    root = ET.fromstring(_extract_kml_bytes(path))
    poly_el = root.find(".//kml:Polygon//kml:coordinates", KML_NS)
    if poly_el is None:
        raise ValueError(f"Tidak ditemukan elemen <Polygon> di {path}. "
                          f"Pastikan boundary digambar sebagai Polygon, bukan LineString.")
    coords = []
    for pair in poly_el.text.strip().split():
        lon, lat, *_ = pair.split(",")
        coords.append((float(lon), float(lat)))
    return Polygon(coords)


def read_points(path):
    """Baca semua Placemark berupa Point dari file KML/KMZ."""
    root = ET.fromstring(_extract_kml_bytes(path))
    points = []
    for pm in root.findall(".//kml:Placemark", KML_NS):
        pt_el = pm.find(".//kml:Point/kml:coordinates", KML_NS)
        if pt_el is None:
            continue
        lon, lat, *_ = pt_el.text.strip().split(",")
        name_el = pm.find("kml:name", KML_NS)
        name = name_el.text.strip() if name_el is not None and name_el.text else "POP"
        points.append({"name": name, "lon": float(lon), "lat": float(lat)})
    if not points:
        raise ValueError(f"Tidak ditemukan Placemark berupa Point di {path}.")
    return points


# =============================================================================
# 2. AMBIL DATA RUMAH DARI OPENSTREETMAP
# =============================================================================

def fetch_houses_in_boundary(polygon):
    """Ambil titik centroid tiap bangunan di dalam boundary dari OpenStreetMap
    memakai osmnx. Butuh koneksi internet aktif."""
    import osmnx as ox

    print("Mengambil data bangunan dari OpenStreetMap...")
    gdf = ox.features_from_polygon(polygon, tags={"building": True})
    gdf = gdf[gdf.geometry.type.isin(["Polygon", "MultiPolygon", "Point"])]

    houses = []
    for _, row in gdf.iterrows():
        geom = row.geometry
        centroid = geom if geom.geom_type == "Point" else geom.centroid
        if polygon.contains(centroid):
            houses.append((centroid.y, centroid.x))  # simpan sebagai (lat, lon)

    print(f"Ditemukan {len(houses)} bangunan di dalam boundary.")
    return houses


def read_houses_from_file(path, boundary=None):
    """Baca titik rumah manual (hasil digitasi sendiri di Google Earth/dsb)
    dari file KML/KMZ berisi banyak Placemark Point. Lebih reliable daripada
    OSM untuk area yang datanya belum lengkap. Jika `boundary` diberikan,
    titik di luar boundary akan dibuang (dengan peringatan)."""
    pts = read_points(path)
    houses = [(p["lat"], p["lon"]) for p in pts]
    if boundary is not None:
        inside = [(lat, lon) for lat, lon in houses if boundary.contains(Point(lon, lat))]
        dropped = len(houses) - len(inside)
        if dropped:
            print(f"  Peringatan: {dropped} titik rumah di luar boundary, diabaikan.")
        houses = inside
    print(f"Memakai {len(houses)} titik rumah dari file manual: {path}")
    return houses


# =============================================================================
# 2b. JARINGAN JALAN -- UNTUK ROUTING KABEL FEEDER MENGIKUTI JALAN RAYA
# =============================================================================

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


def route_along_road(G, from_latlon, to_latlon):
    """Cari rute terpendek di graf jalan `G` antara dua titik (lat, lon) 
    dengan menelusuri geometri jalan secara presisi."""
    import networkx as nx
    import osmnx as ox
    from shapely.geometry import Point as ShPoint
    from shapely.ops import substring

    def trace_edge_line(line, p1, p2):
        t1 = line.project(ShPoint(p1[1], p1[0]))
        t2 = line.project(ShPoint(p2[1], p2[0]))
        if abs(t1 - t2) < 1e-7:
            return [p1, p2]
        sub = substring(line, min(t1, t2), max(t1, t2))
        coords = [(lat, lon) for lon, lat in sub.coords]
        dist_start = (coords[0][0] - p1[0])**2 + (coords[0][1] - p1[1])**2
        dist_end = (coords[-1][0] - p1[0])**2 + (coords[-1][1] - p1[1])**2
        if dist_end < dist_start:
            coords.reverse()
        if coords:
            coords[0] = p1
            coords[-1] = p2
        return coords

    # 1. Snap start and end
    try:
        start_info = locate_on_road(G, from_latlon[0], from_latlon[1])
        snapped_start = (start_info["line"].interpolate(start_info["t_deg"]).y, start_info["line"].interpolate(start_info["t_deg"]).x)
        u_orig, v_orig, _ = start_info["edge"]
    except Exception:
        snapped_start = from_latlon
        u_orig = ox.distance.nearest_nodes(G, X=from_latlon[1], Y=from_latlon[0])
        v_orig = u_orig
        start_info = None

    try:
        end_info = locate_on_road(G, to_latlon[0], to_latlon[1])
        snapped_end = (end_info["line"].interpolate(end_info["t_deg"]).y, end_info["line"].interpolate(end_info["t_deg"]).x)
        u_dest, v_dest, _ = end_info["edge"]
    except Exception:
        snapped_end = to_latlon
        u_dest = ox.distance.nearest_nodes(G, X=to_latlon[1], Y=to_latlon[0])
        v_dest = u_dest
        end_info = None

    route_coords = [from_latlon]

    # 2. Jika di edge yang sama
    if start_info and end_info and set([u_orig, v_orig]) == set([u_dest, v_dest]):
        route_coords.extend(trace_edge_line(start_info["line"], snapped_start, snapped_end))
        route_coords.append(to_latlon)
        return route_coords

    # 3. Cari rute terpendek antar node
    valid_starts = list(set([u_orig, v_orig]))
    valid_ends = list(set([u_dest, v_dest]))
    
    best_path = None
    best_len = float('inf')

    for s in valid_starts:
        for e in valid_ends:
            try:
                length = nx.shortest_path_length(G, s, e, weight="length")
                dist_s = haversine_m(snapped_start[0], snapped_start[1], G.nodes[s]['y'], G.nodes[s]['x'])
                dist_e = haversine_m(snapped_end[0], snapped_end[1], G.nodes[e]['y'], G.nodes[e]['x'])
                total_len = dist_s + length + dist_e
                
                if total_len < best_len:
                    best_len = total_len
                    best_path = nx.shortest_path(G, s, e, weight="length")
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                continue

    if not best_path:
        logger.warning(f"No path found in road_graph from {from_latlon} to {to_latlon}")
        return None

    # 4. Bangun path geometry
    node_s = best_path[0]
    node_s_latlon = (G.nodes[node_s]["y"], G.nodes[node_s]["x"])
    
    if start_info and snapped_start != node_s_latlon:
        route_coords.extend(trace_edge_line(start_info["line"], snapped_start, node_s_latlon))
    else:
        route_coords.append(snapped_start)
        route_coords.append(node_s_latlon)

    for i in range(len(best_path) - 1):
        u = best_path[i]
        v = best_path[i + 1]
        edge_data = G.get_edge_data(u, v)
        if edge_data:
            data = min(edge_data.values(), key=lambda d: d.get("length", float('inf')))
            if "geometry" in data:
                coords = [(lat, lon) for lon, lat in data["geometry"].coords]
                u_coord = (G.nodes[u]["y"], G.nodes[u]["x"])
                v_coord = (G.nodes[v]["y"], G.nodes[v]["x"])
                dist_start_u = (coords[0][0] - u_coord[0])**2 + (coords[0][1] - u_coord[1])**2
                dist_start_v = (coords[0][0] - v_coord[0])**2 + (coords[0][1] - v_coord[1])**2
                if dist_start_v < dist_start_u:
                    coords.reverse()
                route_coords.extend(coords)
                continue
        route_coords.append((G.nodes[v]["y"], G.nodes[v]["x"]))

    node_e = best_path[-1]
    node_e_latlon = (G.nodes[node_e]["y"], G.nodes[node_e]["x"])
    
    if end_info and snapped_end != node_e_latlon:
        route_coords.extend(trace_edge_line(end_info["line"], node_e_latlon, snapped_end))
    else:
        route_coords.append(node_e_latlon)
        route_coords.append(snapped_end)

    route_coords.append(to_latlon)
    
    final_coords = []
    for coord in route_coords:
        if not final_coords or final_coords[-1] != coord:
            final_coords.append(coord)
            
    return final_coords


def order_odcs_chain(pop, odcs):
    """Urutkan ODC menjadi rantai (chain): mulai dengan heuristik
    nearest-neighbor dari POP (ODC terdekat jadi pertama, dst), lalu
    dirapikan dengan 2-opt supaya tidak ada rute yang zigzag/menyilang --
    tiap ODC diusahakan sedekat mungkin dengan ODC sebelumnya dalam rantai."""
    remaining = list(odcs)
    ordered = []
    current = (pop["lat"], pop["lon"])
    while remaining:
        nearest = min(remaining, key=lambda o: math.dist(current, (o.lat, o.lon)))
        ordered.append(nearest)
        current = (nearest.lat, nearest.lon)
        remaining.remove(nearest)
    return _two_opt_improve_chain(pop, ordered)


def _chain_length_m(pop, ordered):
    pts = [(pop["lat"], pop["lon"])] + [(o.lat, o.lon) for o in ordered]
    return sum(haversine_m(*pts[i], *pts[i + 1]) for i in range(len(pts) - 1))


def _two_opt_improve_chain(pop, ordered, max_iter=200):
    """Perbaiki urutan rantai ODC dengan 2-opt: coba balik tiap sub-rentang
    rute, simpan kalau totalnya lebih pendek. Menghilangkan zigzag/silang
    dari hasil nearest-neighbor murni, jadi tiap ODC beneran sedekat
    mungkin dengan ODC sebelum & sesudahnya dalam rantai."""
    n = len(ordered)
    if n < 3:
        return ordered

    best = list(ordered)
    best_len = _chain_length_m(pop, best)
    improved = True
    it = 0
    while improved and it < max_iter:
        improved = False
        it += 1
        for i in range(n - 1):
            for j in range(i + 1, n):
                candidate = best[:i] + best[i:j + 1][::-1] + best[j + 1:]
                cand_len = _chain_length_m(pop, candidate)
                if cand_len < best_len - 1e-6:
                    best, best_len = candidate, cand_len
                    improved = True
    return best


def haversine_m(lat1, lon1, lat2, lon2):
    """Jarak permukaan bumi (meter) antara dua titik (lat, lon), rumus haversine."""
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _edge_geometry_and_length(road_graph, u, v, key):
    """Ambil geometri (shapely LineString, koordinat lon/lat) dan panjang
    riil (meter) suatu edge di graf jalan. Kalau edge tidak punya atribut
    'geometry' (garis lurus antar node), bikin LineString dari koordinat
    node-nya. Kalau tidak ada atribut 'length' (meter), hitung sendiri via
    haversine sepanjang garisnya."""
    from shapely.geometry import LineString

    edge_data = road_graph.edges[u, v, key]
    line = edge_data.get("geometry")
    if line is None:
        un, vn = road_graph.nodes[u], road_graph.nodes[v]
        line = LineString([(un["x"], un["y"]), (vn["x"], vn["y"])])

    len_m = edge_data.get("length")
    if not len_m:
        coords = list(line.coords)
        len_m = sum(
            haversine_m(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0])
            for i in range(len(coords) - 1)
        )
    return line, len_m


def locate_on_road(road_graph, lat, lon):
    """Cari edge jalan terdekat dari titik (lat, lon) dan proyeksikan
    persis ke situ. Return dict berisi info yang dibutuhkan untuk snapping
    maupun 'berjalan' di sepanjang jalan: edge (u,v,key), garis (line, dalam
    koordinat lon/lat derajat), panjang edge dalam derajat (len_deg) dan
    dalam meter (len_m), serta posisi proyeksi di sepanjang garis itu
    (t_deg, dalam satuan derajat, cocok dipakai dengan line.interpolate)."""
    import osmnx as ox
    from shapely.geometry import Point as ShPoint

    u, v, key = ox.distance.nearest_edges(road_graph, X=lon, Y=lat)
    line, len_m = _edge_geometry_and_length(road_graph, u, v, key)
    t_deg = line.project(ShPoint(lon, lat))
    len_deg = line.length
    return {"edge": (u, v, key), "line": line, "len_deg": len_deg, "len_m": len_m, "t_deg": t_deg}


def snap_to_road(road_graph, lat, lon):
    """Geser satu titik (lat, lon) ke posisi terdekat DI SEPANJANG jalan
    (diproyeksikan ke garis jalan itu sendiri, bukan cuma ke node/
    persimpangan terdekat). Return (lat, lon) baru."""
    info = locate_on_road(road_graph, lat, lon)
    p = info["line"].interpolate(info["t_deg"])
    return p.y, p.x


def walk_along_road(road_graph, lat, lon, distance_m, direction=1, branch_choice=0, max_hops=25):
    """'Berjalan' sejauh `distance_m` meter di SEPANJANG JARINGAN JALAN mulai
    dari titik (lat, lon) (otomatis dicari edge terdekatnya dulu). Kalau
    jaraknya melebihi panjang edge yang ditempati, otomatis lanjut ke edge
    lain yang tersambung di persimpangan -- jadi hasil akhirnya DIJAMIN
    tetap persis di atas jalan, tidak pernah nyasar ke pekarangan/rumah.

    direction : +1 = mulai berjalan menuju ujung 'v' edge awal, -1 = menuju 'u'.
    branch_choice : kalau ketemu persimpangan (>1 edge lanjutan), dipakai
        untuk memilih edge yang mana (mod jumlah pilihan) -- supaya panggilan
        dengan branch_choice berbeda bisa menghasilkan rute/arah yang
        berbeda pula (dipakai untuk menyebar beberapa ODP dari 1 ODC).

    Return (lat, lon) titik akhir, atau None kalau jalan buntu/graf terlalu
    pendek untuk menempuh jarak segitu (caller harus fallback)."""
    info = locate_on_road(road_graph, lat, lon)
    u, v, key = info["edge"]
    line, len_deg, len_m, t_deg = info["line"], info["len_deg"], info["len_m"], info["t_deg"]
    scale = (len_m / len_deg) if len_deg > 0 else 0.0
    remaining_m = distance_m

    for _hop in range(max_hops):
        if scale == 0:
            return None
        dist_to_end_deg = (len_deg - t_deg) if direction > 0 else t_deg
        dist_to_end_m = dist_to_end_deg * scale

        if remaining_m <= dist_to_end_m:
            new_t_deg = t_deg + direction * (remaining_m / scale)
            p = line.interpolate(new_t_deg)
            return (p.y, p.x)

        remaining_m -= dist_to_end_m
        end_node = v if direction > 0 else u
        came_from = (u, v, key)

        candidates = []
        for uu, vv, kk in road_graph.edges(end_node, keys=True):
            if (uu, vv, kk) == came_from or (vv, uu, kk) == came_from:
                continue
            candidates.append((uu, vv, kk))
        if road_graph.is_directed():
            for uu, vv, kk in road_graph.in_edges(end_node, keys=True):
                if (uu, vv, kk) == came_from or (vv, uu, kk) == came_from:
                    continue
                candidates.append((vv, uu, kk))

        if not candidates:
            p = line.interpolate(len_deg if direction > 0 else 0)
            return (p.y, p.x)

        u2, v2, key2 = candidates[branch_choice % len(candidates)]
        line2, len_m2 = _edge_geometry_and_length(road_graph, u2, v2, key2)
        len_deg2 = line2.length

        if u2 == end_node:
            t_deg, direction = 0.0, 1
        else:
            t_deg, direction = len_deg2, -1

        u, v, key, line, len_deg, len_m = u2, v2, key2, line2, len_deg2, len_m2
        scale = (len_m / len_deg) if len_deg > 0 else 0.0

    return None


def enforce_min_distance_between_odcs_on_road(road_graph, odcs, min_dist_m=40.0, max_passes=20):
    """Versi enforce_min_distance_between_odcs() yang menjaga ODC tetap DI
    JALAN. Kalau 2 ODC terlalu dekat, ODC dengan index lebih besar dipindah
    dengan BERJALAN DI SEPANJANG JALAN (walk_along_road) dari posisi ODC
    lainnya sejauh min_dist_m -- dicoba beberapa arah/percabangan supaya
    hasilnya juga tidak bertumpuk dengan ODC lain yang sudah diproses.
    Fallback ke offset garis lurus (dengan peringatan) kalau tidak ada opsi
    jalan yang valid ditemukan. Mutasi in-place."""
    n = len(odcs)
    for _ in range(max_passes):
        moved = False
        for i in range(n):
            for j in range(i + 1, n):
                a, b = odcs[i], odcs[j]
                d = haversine_m(a.lat, a.lon, b.lat, b.lon)
                if d >= min_dist_m:
                    continue

                result = None
                for direction in (1, -1):
                    for branch_choice in range(4):
                        try:
                            candidate = walk_along_road(
                                road_graph, a.lat, a.lon, min_dist_m,
                                direction=direction, branch_choice=branch_choice,
                            )
                        except Exception:
                            candidate = None
                        if candidate is None:
                            continue
                        if all(haversine_m(*candidate, odcs[k].lat, odcs[k].lon) >= min_dist_m
                               for k in range(n) if k != j):
                            result = candidate
                            break
                    if result is not None:
                        break

                if result is None:
                    bearing = (137.5 * j) % 360 if d < 1e-6 else bearing_between(a.lat, a.lon, b.lat, b.lon)
                    result = offset_latlon(a.lat, a.lon, min_dist_m, bearing)
                    print(f"  Peringatan: {b.id} tidak bisa dipindah di jalan (jalan lurus tanpa "
                          f"persimpangan terdekat), pakai offset garis lurus.")

                b.lat, b.lon = result
                moved = True
        if not moved:
            break
    return odcs


def optimize_placement_with_ai(target_id, target_centroid, items_coords, road_graph):
    """Gunakan OpenAI API (ChatGPT) untuk optimasi penempatan ODP/ODC.
    Fallback ke road snapping (Nearest Node) jika API Key tidak ada atau gagal."""
    api_key = os.getenv("OPENAI_API_KEY")
    model_name = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    
    # AI Fallback: Jika tidak ada API key atau road_graph kosong
    if not api_key or road_graph is None:
        try:
            return snap_to_road(road_graph, target_centroid[0], target_centroid[1])
        except Exception:
            return target_centroid
            
    print(f"Menggunakan AI {model_name} untuk menempatkan {target_id}...")
    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key)
        
        # Ekstrak node jalan terdekat di sekitar centroid
        import osmnx as ox
        nodes_df = ox.convert.graph_to_gdfs(road_graph, edges=False)
        center_node = ox.distance.nearest_nodes(road_graph, X=target_centroid[1], Y=target_centroid[0])
        
        # Kirim data ke AI
        prompt = f'''
        Kamu adalah Network Engineer spesialis FTTH.
        Tugas: Tentukan koordinat Latitude dan Longitude terbaik untuk perangkat {target_id}.
        
        Data:
        - Titik tengah matematis (Centroid): Lat {target_centroid[0]}, Lon {target_centroid[1]}
        - Rumah/ODP yang dilayani: {items_coords}
        - Koordinat Jalan terdekat (opsi): Lat {road_graph.nodes[center_node]["y"]}, Lon {road_graph.nodes[center_node]["x"]}
        
        Aturan:
        1. Harus diletakkan persis di titik jalan terdekat agar tidak menabrak rumah.
        2. Harus sedekat mungkin ke rumah/ODP yang dilayani.
        
        Kembalikan HANYA JSON object dengan format: {{"lat": float, "lon": float}} tanpa markdown atau teks lainnya.
        '''
        
        response = client.chat.completions.create(
            model=model_name,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1
        )
        
        result_text = response.choices[0].message.content.strip()
        if result_text.startswith("```json"):
            result_text = result_text.replace("```json", "").replace("```", "")
            
        data = json.loads(result_text)
        return float(data["lat"]), float(data["lon"])
    except Exception as e:
        print(f"AI gagal merespons untuk {target_id} ({e}), menggunakan fallback spatial snapping...")
        try:
            return snap_to_road(road_graph, target_centroid[0], target_centroid[1])
        except Exception:
            return target_centroid


def snap_odcs_to_road(road_graph, odcs):
    """Geser posisi ODC ke titik terdekat di jalan. Mutasi in-place."""
    for odc in odcs:
        try:
            odc.lat, odc.lon = snap_to_road(road_graph, odc.lat, odc.lon)
        except Exception as e:
            print(f"  Peringatan: gagal snap {odc.id} ke jalan ({e}), pakai posisi centroid.")


def bearing_between(lat1, lon1, lat2, lon2):
    """Bearing awal (derajat, 0=utara) dari titik 1 ke titik 2."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlmb = math.radians(lon2 - lon1)
    x = math.sin(dlmb) * math.cos(phi2)
    y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlmb)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def enforce_min_distance_between_odcs(odcs, min_dist_m=40.0, max_passes=20):
    """Pastikan tidak ada 2 ODC yang jaraknya kurang dari `min_dist_m` (termasuk
    yang persis bertumpuk di 1 titik akibat clustering). ODC dengan index lebih
    besar digeser menjauh dari yang index lebih kecil sampai jaraknya tepat
    `min_dist_m`. Kalau jaraknya 0 (persis di titik yang sama), dipakai bearing
    unik berbasis index supaya hasilnya menyebar rapi, bukan cuma satu arah.
    Mutasi in-place, juga return list-nya untuk kenyamanan."""
    n = len(odcs)
    for _ in range(max_passes):
        moved = False
        for i in range(n):
            for j in range(i + 1, n):
                a, b = odcs[i], odcs[j]
                d = haversine_m(a.lat, a.lon, b.lat, b.lon)
                if d < min_dist_m:
                    if d < 1e-6:
                        bearing = (137.5 * j) % 360  # sudut emas, biar sebarannya rapi
                    else:
                        bearing = bearing_between(a.lat, a.lon, b.lat, b.lon)
                    b.lat, b.lon = offset_latlon(a.lat, a.lon, min_dist_m, bearing)
                    moved = True
        if not moved:
            break
    return odcs


def offset_latlon(lat, lon, distance_m, bearing_deg):
    """Hitung titik (lat, lon) baru yang berjarak `distance_m` meter dari
    titik asal, ke arah `bearing_deg` derajat (0=utara, 90=timur, dst).
    Ini offset GEOMETRIS MURNI (garis lurus, tidak mengikuti jalan) --
    dipakai sebagai fallback kalau road_graph tidak tersedia/gagal."""
    R = 6371000.0  # radius bumi (meter)
    brg = math.radians(bearing_deg)
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)
    ang = distance_m / R

    lat2 = math.asin(math.sin(lat1) * math.cos(ang) + math.cos(lat1) * math.sin(ang) * math.cos(brg))
    lon2 = lon1 + math.atan2(
        math.sin(brg) * math.sin(ang) * math.cos(lat1),
        math.cos(ang) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), math.degrees(lon2)


def arrange_odps_around_odc(odc, offset_m=40.0, road_graph=None):
    """Atur ulang posisi tiap ODP dalam 1 ODC:
      - ODP yang aslinya PALING DEKAT dengan ODC ditaruh PERSIS di titik ODC
        (jarak 0 m -- co-located, umum untuk kabinet FTTH gabungan).
      - ODP sisanya disebar pada jarak `offset_m` meter (default 40 m) dari
        ODC. Kalau `road_graph` tersedia, jaraknya ditempuh dengan BERJALAN
        DI SEPANJANG JALAN (walk_along_road) -- dijamin hasilnya tetap di
        jalur jalan/feeder, bukan offset garis lurus yang bisa nyasar ke
        pekarangan rumah. Dicoba beberapa kombinasi arah (maju/mundur) dan
        percabangan supaya tiap ODP unik posisinya.

    CATATAN JUJUR: kalau di sekitar ODC jalannya lurus panjang tanpa
    persimpangan dalam radius `offset_m`, secara geometris HANYA ADA 2 titik
    yang unik & persis berjarak offset_m di jalan itu (maju & mundur). Untuk
    ODP ke-3 dan seterusnya dalam kasus begini, script akan fallback ke
    offset garis lurus (dengan peringatan di terminal) supaya tetap unik --
    prioritas: jarak persis offset_m & tidak tumpang tindih, di atas "harus
    selalu persis di jalan".
    Mutasi in-place pada objek ODP (mengubah .lat/.lon)."""
    if not odc.odps:
        return

    def dist_to_odc(odp):
        return math.hypot(odp.lat - odc.lat, odp.lon - odc.lon)

    ordered = sorted(odc.odps, key=dist_to_odc)

    # ODP terdekat -> co-located persis di titik ODC
    ordered[0].lat, ordered[0].lon = odc.lat, odc.lon
    used_points = [(ordered[0].lat, ordered[0].lon)]

    rest = ordered[1:]
    n = len(rest)
    for idx, odp in enumerate(rest):
        result = None
        if road_graph is not None:
            # coba beberapa kombinasi arah & percabangan, ambil yang pertama
            # valid DAN belum dipakai ODP lain di ODC yang sama
            for direction in ((1, -1) if idx % 2 == 0 else (-1, 1)):
                for branch_choice in range(4):
                    try:
                        candidate = walk_along_road(
                            road_graph, odc.lat, odc.lon, offset_m,
                            direction=direction, branch_choice=branch_choice,
                        )
                    except Exception:
                        candidate = None
                    if candidate is None:
                        continue
                    if all(haversine_m(*candidate, *up) > 1.0 for up in used_points):
                        result = candidate
                        break
                if result is not None:
                    break

        if result is None:
            if road_graph is not None:
                print(f"  Peringatan: {odp.id} tidak dapat ditempatkan unik di jalan dalam "
                      f"radius {offset_m:.0f} m (jalan lurus/tidak ada persimpangan terdekat), "
                      f"pakai offset garis lurus.")
            bearing = (360.0 / n) * idx if n else 0
            result = offset_latlon(odc.lat, odc.lon, offset_m, bearing)

        odp.lat, odp.lon = result
        used_points.append(result)



def build_feeder_chain(pop, odcs, road_graph=None):
    """Susun rantai ODC dari POP (order_odcs_chain), lalu RENUMBER id ODC
    (ODC-001, ODC-002, ...) mengikuti urutan rantai supaya penomoran sesuai
    urutan fisik kabel trunk-nya. Kemudian bangun rute feeder tiap segmen
    (POP->ODC-001, ODC-001->ODC-002, dst), mengikuti jalan kalau road_graph
    tersedia.

    Return: (feeder_segments, odcs_renumbered)
      feeder_segments: list of dict {'from_label', 'to_label', 'coords'}
      odcs_renumbered: list ODC dengan id & closure_id sudah disesuaikan urutan rantai
    """
    ordered = order_odcs_chain(pop, odcs)
    for i, odc in enumerate(ordered, start=1):
        odc.id = f"ODC-{i:03d}"
        odc.closure_id = f"CL-{i:03d}"

    segments = []
    current_label = pop["name"]
    current_latlon = (pop["lat"], pop["lon"])
    for odc in ordered:
        target_latlon = (odc.lat, odc.lon)
        path = None
        if road_graph is not None:
            try:
                path = route_along_road(road_graph, current_latlon, target_latlon)
            except Exception as e:
                print(f"  Peringatan: gagal routing jalan {current_label}->{odc.id} ({e}), pakai garis lurus.")
        if not path:
            path = [current_latlon, target_latlon]
        segments.append({"from_label": current_label, "to_label": odc.id, "coords": path})
        current_label = odc.id
        current_latlon = target_latlon

    return segments, ordered


def build_feeder_segments_preserving_order(pop, odcs, road_graph=None):
    """Bangun rute feeder dari POP ke ODC TANPA mengubah urutan ODC.
    Dipakai oleh regenerate_cables_only: urutan ODC sudah benar dari cache
    (sudah di-sort & renumber saat generate pertama), jadi tidak perlu
    menjalankan ulang order_odcs_chain + 2-opt yang bisa menghasilkan
    urutan berbeda.

    Return: (feeder_segments, odcs)
      feeder_segments: list of dict {'from_label', 'to_label', 'coords'}
      odcs: list ODC dengan urutan yang tidak berubah
    """
    segments = []
    current_label = pop["name"]
    current_latlon = (pop["lat"], pop["lon"])
    for odc in odcs:
        target_latlon = (odc.lat, odc.lon)
        path = None
        if road_graph is not None:
            try:
                path = route_along_road(road_graph, current_latlon, target_latlon)
            except Exception as e:
                print(f"  Peringatan: gagal routing jalan {current_label}->{odc.id} ({e}), pakai garis lurus.")
        if not path:
            path = [current_latlon, target_latlon]
        segments.append({"from_label": current_label, "to_label": odc.id, "coords": path})
        current_label = odc.id
        current_latlon = target_latlon

    return segments, odcs


# =============================================================================
# 3. CAPACITATED CLUSTERING (nearest-neighbor murni, tanpa KMeans)
# =============================================================================

def capacitated_clustering(points, capacity):
    """Kelompokkan daftar titik (lat, lon) menjadi cluster berukuran maksimum
    `capacity`. Dipakai dua kali: rumah->ODP dan ODP->ODC.

    Strategi: NEAREST-NEIGHBOR berantai. Cluster pertama diambil dari titik
    mana saja sebagai 'benih'. Untuk cluster BERIKUTNYA, benihnya adalah
    titik SISA yang paling dekat dengan centroid cluster sebelumnya -- jadi
    urutan clusternya otomatis menyapu area secara berdekatan/kontinu
    (cluster ke-2 nempel di sebelah cluster ke-1, dst), bukan lompat-lompat
    acak. Ini yang membuat ODC/ODP berurutan jadi rapi & berdekatan satu
    sama lain, bukan cuma dekat di dalam clusternya sendiri.

    Return: list berisi list index (merujuk ke `points`) per cluster.
    """
    n = len(points)
    if n == 0:
        return []
    if n <= capacity:
        return [list(range(n))]

    coords = np.array(points, dtype=float)
    remaining = list(range(n))
    clusters = []
    last_centroid = None

    while remaining:
        rem_coords = coords[remaining]
        if last_centroid is None:
            seed_pos = 0
        else:
            dists_to_last = np.linalg.norm(rem_coords - last_centroid, axis=1)
            seed_pos = int(np.argmin(dists_to_last))
        seed = rem_coords[seed_pos]

        dists = np.linalg.norm(rem_coords - seed, axis=1)
        order = np.argsort(dists)[:capacity]
        cluster = [remaining[i] for i in order]
        clusters.append(cluster)
        last_centroid = coords[cluster].mean(axis=0)
        taken = set(cluster)
        remaining = [i for i in remaining if i not in taken]

    return clusters


def centroid_of(points):
    return tuple(np.array(points, dtype=float).mean(axis=0))


# =============================================================================
# 4. MODEL DATA
# =============================================================================

@dataclass
class Splitter:
    ratio: str
    location: str  # "ODC" atau "ODP"


@dataclass
class ODP:
    id: str
    lat: float
    lon: float
    houses: list = field(default_factory=list)
    splitter: Splitter = None


@dataclass
class ODC:
    id: str
    lat: float
    lon: float
    odps: list = field(default_factory=list)
    splitter: Splitter = None
    closure_id: str = None


# =============================================================================
# 5. LOGIKA DESAIN UTAMA (clustering rumah -> ODP -> ODC)
# =============================================================================

def build_design(houses, odp_capacity=8, odc_capacity=4, road_graph=None):
    """Bangun struktur ODC -> ODP -> rumah dari daftar titik rumah.
    Penomoran ODC di sini masih berdasar urutan cluster (belum urutan
    rantai feeder) -- akan di-renumber ulang oleh build_feeder_chain()."""
    import concurrent.futures

    # -- Tahap 1: rumah -> ODP (tiap ODP dapat splitter 1:odp_capacity) --
    house_clusters = capacitated_clustering(houses, odp_capacity)
    
    def process_odp(i, idxs):
        cluster_houses = [houses[j] for j in idxs]
        c_lat, c_lon = centroid_of(cluster_houses)
        lat, lon = optimize_placement_with_ai(
            target_id=f"ODP-{i:03d}",
            target_centroid=(c_lat, c_lon),
            items_coords=cluster_houses,
            road_graph=road_graph
        )
        return ODP(
            id=f"ODP-{i:03d}",
            lat=lat, lon=lon,
            houses=cluster_houses,
            splitter=Splitter(ratio=f"1:{odp_capacity}", location="ODP"),
        )

    odps = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=15) as executor:
        futures = {executor.submit(process_odp, i, idxs): i for i, idxs in enumerate(house_clusters, start=1)}
        results = {}
        for future in concurrent.futures.as_completed(futures):
            i = futures[future]
            results[i] = future.result()
        for i in sorted(results.keys()):
            odps.append(results[i])

    # -- Tahap 2: ODP -> ODC (tiap ODC melayani odc_capacity ODP, splitter 1:odc_capacity) --
    odp_coords = [(o.lat, o.lon) for o in odps]
    odp_clusters = capacitated_clustering(odp_coords, odc_capacity)
    
    def process_odc(i, idxs):
        cluster_odps = [odps[j] for j in idxs]
        c_lat, c_lon = centroid_of([(o.lat, o.lon) for o in cluster_odps])
        lat, lon = optimize_placement_with_ai(
            target_id=f"ODC-{i:03d}",
            target_centroid=(c_lat, c_lon),
            items_coords=[(o.lat, o.lon) for o in cluster_odps],
            road_graph=road_graph
        )
        return ODC(
            id=f"ODC-{i:03d}",
            lat=lat, lon=lon,
            odps=cluster_odps,
            splitter=Splitter(ratio=f"1:{odc_capacity}", location="ODC"),
            closure_id=f"CL-{i:03d}",
        )
        
    odcs = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(process_odc, i, idxs): i for i, idxs in enumerate(odp_clusters, start=1)}
        results = {}
        for future in concurrent.futures.as_completed(futures):
            i = futures[future]
            results[i] = future.result()
        for i in sorted(results.keys()):
            odcs.append(results[i])

    return odcs


# =============================================================================
# 6. EXPORT KE KMZ
# =============================================================================

def export_kmz(pop, odcs, feeder_segments, output_path, include_homepass=False, road_graph=None, road_feeder=False):
    """Export desain ke KMZ dengan struktur folder & penamaan mengikuti
    konvensi industri (per-ODC), seperti contoh:

    Root
     |- OLT                    -> titik SERVER OLT
     |- LINE FD                -> kabel feeder (POP -> ODC1 -> ODC2 -> ...)
     |- ODC 1
     |    |- ODC                -> titik ODC 01
     |    |- JOIN CLOSURE       -> titik closure ODC 01
     |    |- ODP                -> titik 01/01, 01/02, ...
     |    |- HC                 -> titik homepass 01/01-01, 01/01-02, ...
     |    |- LINE ODC TO ODP    -> kabel distribusi
     |    |- LINE ODP TO HC     -> kabel drop
     |- ODC 2
     |    |- ...
     ...
    """
    kml = simplekml.Kml()

    # -- OLT --
    fol_olt = kml.newfolder(name="OLT")
    p = fol_olt.newpoint(name=pop["name"], description="SERVER OLT", coords=[(pop["lon"], pop["lat"])])
    p.style.iconstyle.color = simplekml.Color.red
    p.style.iconstyle.scale = 1.3

    # -- LINE FD (feeder): rantai POP -> ODC1 -> ODC2 -> ... mengikuti jalan --
    fol_fd = kml.newfolder(name="LINE FD")
    for seg in feeder_segments:
        coords_lonlat = [(lon, lat) for lat, lon in seg["coords"]]
        feeder = fol_fd.newlinestring(
            name=f"FD {seg['from_label']} -> {seg['to_label']}",
            coords=coords_lonlat,
        )
        feeder.style.linestyle.color = simplekml.Color.red
        feeder.style.linestyle.width = 3

    total_houses = 0
    for i, odc in enumerate(odcs, start=1):
        odc_label = f"ODC {i:02d}"          # label titik, mis. "ODC 01"
        fol_odc_top = kml.newfolder(name=f"ODC {i}")  # folder utama, mis. "ODC 1"

        fol_odc = fol_odc_top.newfolder(name="ODC")
        fol_closure = fol_odc_top.newfolder(name="JOIN CLOSURE")
        fol_odp = fol_odc_top.newfolder(name="ODP")
        fol_dist = fol_odc_top.newfolder(name="LINE ODC TO ODP")
        if include_homepass:
            fol_hc = fol_odc_top.newfolder(name="HC")
            fol_drop = fol_odc_top.newfolder(name="LINE ODP TO HC")

        pt = fol_odc.newpoint(
            name=odc_label,
            description=(f"Splitter: {odc.splitter.ratio}\n"
                          f"Jumlah ODP: {len(odc.odps)}"),
            coords=[(odc.lon, odc.lat)],
        )
        pt.style.iconstyle.icon.href = "http://maps.google.com/mapfiles/kml/shapes/triangle.png"
        pt.style.iconstyle.color = simplekml.Color.red
        pt.style.iconstyle.scale = 1.1

        cl = fol_closure.newpoint(
            name=f"JOIN CLOSURE {odc_label}",
            description=f"Closure untuk {odc_label}",
            coords=[(odc.lon, odc.lat)],
        )
        cl.style.iconstyle.color = simplekml.Color.gray
        cl.style.iconstyle.scale = 0.8

        for j, odp in enumerate(odc.odps, start=1):
            odp_label = f"{i:02d}/{j:02d}"   # mis. "01/01"

            opt = fol_odp.newpoint(
                name=odp_label,
                description=(f"Splitter: {odp.splitter.ratio}\n"
                              f"Jumlah rumah: {len(odp.houses)}\n"
                              f"Induk: {odc_label}"),
                coords=[(odp.lon, odp.lat)],
            )
            opt.style.iconstyle.icon.href = "http://maps.google.com/mapfiles/kml/shapes/triangle.png"
            opt.style.iconstyle.color = simplekml.Color.blue
            opt.style.iconstyle.scale = 0.9

            coords = [(odc.lon, odc.lat), (odp.lon, odp.lat)]
            if road_graph and road_feeder:
                path = route_along_road(road_graph, (odc.lat, odc.lon), (odp.lat, odp.lon))
                if path:
                    coords = [(lon, lat) for lat, lon in path]

            dist = fol_dist.newlinestring(
                name=f"ODC {i:02d} TO ODP {odp_label}",
                coords=coords,
            )
            dist.style.linestyle.color = simplekml.Color.blue
            dist.style.linestyle.width = 2

            if not include_homepass:
                total_houses += len(odp.houses)
                continue

            for k, (h_lat, h_lon) in enumerate(odp.houses, start=1):
                total_houses += 1
                hc_label = f"{odp_label}-{k:02d}"   # mis. "01/01-01"

                hc = fol_hc.newpoint(
                    name=hc_label,
                    description=f"Induk ODP: {odp_label}",
                    coords=[(h_lon, h_lat)],
                )
                hc.style.iconstyle.icon.href = "http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png"
                hc.style.iconstyle.color = simplekml.Color.green
                hc.style.iconstyle.scale = 0.6

                drop_coords = [(odp.lon, odp.lat), (h_lon, h_lat)]
                if road_graph and road_feeder:
                    path = route_along_road(road_graph, (odp.lat, odp.lon), (h_lat, h_lon))
                    if path:
                        drop_coords = [(lon, lat) for lat, lon in path]

                drop = fol_drop.newlinestring(
                    name=f"ODP {odp_label} TO HC {hc_label}",
                    coords=drop_coords,
                )
                drop.style.linestyle.color = simplekml.Color.white
                drop.style.linestyle.width = 1

    kml.savekmz(output_path)

    print(f"\nDesain selesai:")
    print(f"  Total rumah   : {total_houses}")
    print(f"  Total ODC     : {len(odcs)}")
    print(f"  Total ODP     : {sum(len(o.odps) for o in odcs)}")
    print(f"  Segmen feeder : {len(feeder_segments)} (POP -> {' -> '.join(s['to_label'] for s in feeder_segments)})")
    print(f"Output disimpan di: {output_path}")


# =============================================================================
# 6b. DESIGN STATE CACHE — simpan & muat posisi ODC/ODP/rumah + road graph
# =============================================================================

import pickle

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
DESIGN_STATE_PATH = os.path.join(CACHE_DIR, "design_state.json")
ROAD_GRAPH_PATH = os.path.join(CACHE_DIR, "road_graph.pkl")


def save_design_state(pop, odcs, road_graph=None):
    """Simpan posisi POP, ODC, ODP, dan rumah ke file JSON, serta road graph
    ke pickle. Ini memungkinkan regenerate kabel tanpa menjalankan ulang
    clustering & placement dari awal."""
    os.makedirs(CACHE_DIR, exist_ok=True)

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

    with open(DESIGN_STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)
    print(f"Design state disimpan di: {DESIGN_STATE_PATH}")

    if road_graph is not None:
        with open(ROAD_GRAPH_PATH, "wb") as f:
            pickle.dump(road_graph, f)
        print(f"Road graph disimpan di: {ROAD_GRAPH_PATH}")


def load_design_state():
    """Muat design state dari cache JSON. Return (pop, odcs) yang siap dipakai
    untuk regenerate kabel. Raise FileNotFoundError kalau belum pernah generate."""
    if not os.path.exists(DESIGN_STATE_PATH):
        raise FileNotFoundError(
            "Belum ada design state yang tersimpan. Jalankan 'Generate Design' terlebih dahulu."
        )

    with open(DESIGN_STATE_PATH, "r") as f:
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


def load_road_graph():
    """Muat road graph dari pickle cache. Return None kalau tidak ada."""
    if not os.path.exists(ROAD_GRAPH_PATH):
        return None
    with open(ROAD_GRAPH_PATH, "rb") as f:
        return pickle.load(f)


def regenerate_cables_only(output_path, include_homepass=False):
    """Regenerate HANYA jalur kabel (feeder, distribusi, drop) tanpa mengubah
    posisi ODC/ODP/tiang/rumah. Membaca posisi dari design state cache dan
    road graph dari pickle cache, lalu menjalankan routing + export KMZ.

    Return: path output KMZ yang dihasilkan."""
    print("=" * 60)
    print("REGENERATE KABEL ONLY — posisi tiang/ODC/ODP/rumah TETAP")
    print("=" * 60)

    pop, odcs = load_design_state()
    road_graph = load_road_graph()

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
                    with open(ROAD_GRAPH_PATH, "wb") as f:
                        pickle.dump(road_graph, f)
                    logger.info("Successfully fetched and cached road graph.")
                else:
                    logger.warning("fetch_road_graph returned None")
            except Exception as e:
                logger.exception(f"Gagal mengunduh ulang road graph ({e}), kabel akan pakai garis lurus.")
                print(f"  Peringatan: Gagal mengunduh ulang road graph ({e}), kabel akan pakai garis lurus.")
        else:
            logger.warning("Tidak ada data koordinat untuk mengunduh road graph, kabel akan pakai garis lurus.")
            print("  Peringatan: Tidak ada data koordinat untuk mengunduh road graph, kabel akan pakai garis lurus.")

    total_odp = sum(len(odc.odps) for odc in odcs)
    total_houses = sum(len(odp.houses) for odc in odcs for odp in odc.odps)
    print(f"  Loaded: {len(odcs)} ODC, {total_odp} ODP, {total_houses} rumah")

    # Route feeder tanpa mengubah urutan ODC (sudah benar dari cache)
    feeder_segments, odcs = build_feeder_segments_preserving_order(pop, odcs, road_graph=road_graph)

    # Export KMZ dengan routing kabel baru
    export_kmz(
        pop, odcs, feeder_segments, output_path,
        include_homepass=include_homepass,
        road_graph=road_graph,
        road_feeder=(road_graph is not None),
    )

    return output_path

# =============================================================================
# 6c. CUSTOM MAPPED KML — routing kabel dari file KML custom yang sudah di-mapping
# =============================================================================

def read_custom_mapped_kml(path):
    """Membaca file KML custom dan mengkategorikan titik berdasarkan namanya."""
    root = ET.fromstring(_extract_kml_bytes(path))
    points = {'olt': [], 'odc': [], 'odp': [], 'hc': []}
    
    for pm in root.findall(".//kml:Placemark", KML_NS):
        pt_el = pm.find(".//kml:Point/kml:coordinates", KML_NS)
        if pt_el is None:
            continue
            
        lon, lat, *_ = pt_el.text.strip().split(",")
        lat, lon = float(lat), float(lon)
        
        name_el = pm.find("kml:name", KML_NS)
        name = name_el.text.strip().lower() if name_el is not None and name_el.text else ""
        
        pt_data = {"name": name_el.text.strip() if name_el is not None and name_el.text else "Unknown", "lat": lat, "lon": lon}
        
        if "olt" in name or "pop" in name:
            points['olt'].append(pt_data)
        elif "odc" in name:
            points['odc'].append(pt_data)
        elif "odp" in name:
            points['odp'].append(pt_data)
        elif "hc" in name or "rumah" in name:
            points['hc'].append(pt_data)
            
    return points


def generate_cables_from_custom_points(file_path, output_path, include_homepass=True):
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
        print(f"Peringatan: Gagal mengambil data jalan ({e}), kabel akan menggunakan garis lurus.")
        
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
        save_design_state(pop, odcs, road_graph=road_graph)
    except Exception as e:
        print(f"Peringatan: gagal menyimpan custom design state ({e}), regenerate-cables tidak tersedia.")
    
    return output_path


# =============================================================================
# 7. MAIN / CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(description="FTTH Auto Design Generator")
    parser.add_argument("--input", help="Satu file KML/KMZ berisi Polygon (boundary) DAN Point (POP) sekaligus")
    parser.add_argument("--boundary", help="File boundary area (KML/KMZ) -- dipakai jika tidak pakai --input")
    parser.add_argument("--pop", help="File titik POP/OLT (KML/KMZ) -- dipakai jika tidak pakai --input")
    parser.add_argument("--output", default="design_ftth.kmz", help="Path output KMZ")
    parser.add_argument("--odp-capacity", type=int, default=8,
                         help="Kapasitas splitter di ODP / max rumah per ODP (default: 8)")
    parser.add_argument("--odc-capacity", type=int, default=4,
                         help="Jumlah ODP maksimum per ODC (default: 4)")
    parser.add_argument("--target-homepass", type=int, default=None,
                         help="Batasi desain untuk sejumlah homepass tertentu saja (mis. 512). "
                              "Kalau rumah yang ditemukan lebih banyak, dipangkas ke yang TERDEKAT "
                              "dari POP. Default: pakai semua rumah yang ditemukan di boundary.")
    parser.add_argument("--houses", help="Opsional: file KML/KMZ berisi titik rumah manual "
                                          "(hasil digitasi sendiri). Kalau diisi, ini dipakai "
                                          "sebagai sumber rumah dan TIDAK mengambil dari OpenStreetMap.")
    parser.add_argument("--no-road-feeder", action="store_true",
                         help="Nonaktifkan routing feeder mengikuti jalan (pakai garis lurus, lebih cepat)")
    parser.add_argument("--odp-offset-m", type=float, default=40.0,
                         help="Jarak (meter) ODP selain yang co-located ke ODC (default: 40)")
    parser.add_argument("--odc-min-distance-m", type=float, default=40.0,
                         help="Jarak minimum (meter) antar-ODC, supaya tidak ada yang bertumpuk (default: 40)")
    parser.add_argument("--show-homepass", action="store_true",
                         help="Tampilkan homepass (HC) & kabel drop di output KMZ. "
                              "Default: disembunyikan, fokus ke ODC/ODP saja.")
    args = parser.parse_args()

    if args.input:
        boundary_path = pop_path = args.input
    elif args.boundary and args.pop:
        boundary_path, pop_path = args.boundary, args.pop
    else:
        parser.error("Gunakan --input file_gabungan.kmz ATAU --boundary file.kml --pop file.kml")

    print(f"Membaca boundary : {boundary_path}")
    boundary = read_boundary(boundary_path)

    print(f"Membaca titik POP: {pop_path}")
    pop_points = read_points(pop_path)
    pop = pop_points[0]
    if len(pop_points) > 1:
        print(f"  (Ditemukan {len(pop_points)} titik di file ini, "
              f"memakai titik pertama sebagai POP: '{pop['name']}')")

    if args.houses:
        houses = read_houses_from_file(args.houses, boundary=boundary)
    else:
        houses = fetch_houses_in_boundary(boundary)

    if not houses:
        raise SystemExit("Tidak ada rumah yang ditemukan. Kalau mengandalkan OpenStreetMap, coba "
                          "cek dulu kelengkapan data bangunan di area ini lewat openstreetmap.org, "
                          "atau pakai opsi --houses dengan file titik rumah hasil digitasi manual.")

    if args.target_homepass:
        target = args.target_homepass
        if len(houses) < target:
            print(f"Peringatan: hanya ditemukan {len(houses)} rumah, kurang dari target {target}. "
                  f"Semua {len(houses)} rumah yang ada akan dipakai.")
        elif len(houses) > target:
            # urutkan dari yang paling dekat ke POP, ambil sejumlah target --
            # desain akan fokus melayani area terdekat dari OLT dulu
            houses.sort(key=lambda h: haversine_m(pop["lat"], pop["lon"], h[0], h[1]))
            houses = houses[:target]
            print(f"Dipangkas jadi {target} rumah TERDEKAT dari POP (sesuai target homepass).")

    road_graph = None
    if not args.no_road_feeder:
        try:
            road_graph = fetch_road_graph(boundary, pop)
        except Exception as e:
            print(f"Peringatan: gagal mengambil data jalan ({e}). Feeder akan pakai garis lurus.")
            import traceback
            traceback.print_exc()
            road_graph = None
            
    odcs = build_design(
        houses=houses,
        odp_capacity=args.odp_capacity,
        odc_capacity=args.odc_capacity,
        road_graph=road_graph
    )

    n_odp_expected = math.ceil(len(houses) / args.odp_capacity)
    n_odc_expected = math.ceil(n_odp_expected / args.odc_capacity)
    print(f"Target: {len(houses)} homepass -> {n_odp_expected} ODP (1:{args.odp_capacity}) "
          f"-> {n_odc_expected} ODC (1:{args.odc_capacity})")

    print(f"Memastikan tidak ada ODC yang bertumpuk (jarak minimum {args.odc_min_distance_m:.0f} m)...")
    enforce_min_distance_between_odcs(odcs, min_dist_m=args.odc_min_distance_m)

    if road_graph is not None:
        # Hapus snap_odcs_to_road & enforce_min_distance_between_odcs_on_road yang redundan
        # karena ODC sudah di-snap saat build_design
        pass

    # Hapus arrange_odps_around_odc karena ODP sekarang murni 
    # mengambil referensi lokasi spasial pelanggannya dan menempel di jalan (AI-snapped).

    feeder_segments, odcs = build_feeder_chain(pop, odcs, road_graph=road_graph)

    # Cache design state untuk fitur regenerate-cables
    try:
        save_design_state(pop, odcs, road_graph=road_graph)
    except Exception as e:
        print(f"Peringatan: gagal menyimpan design state ({e}), regenerate-cables tidak tersedia.")

    export_kmz(pop, odcs, feeder_segments, args.output, include_homepass=args.show_homepass, road_graph=road_graph, road_feeder=not args.no_road_feeder)


if __name__ == "__main__":
    main()