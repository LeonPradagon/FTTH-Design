import math
import networkx as nx
import osmnx as ox
from shapely.geometry import Point as ShPoint, LineString
from shapely.ops import substring
from backend.utils.geometry import haversine_m, bearing_between, offset_latlon
from backend.core.logging import logger

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


def snap_odcs_to_road(road_graph, odcs):
    """Geser posisi ODC ke titik terdekat di jalan. Mutasi in-place."""
    for odc in odcs:
        try:
            odc.lat, odc.lon = snap_to_road(road_graph, odc.lat, odc.lon)
        except Exception as e:
            print(f"  Peringatan: gagal snap {odc.id} ke jalan ({e}), pakai posisi centroid.")


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
