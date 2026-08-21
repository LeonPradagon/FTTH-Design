import math
import threading
import weakref
import networkx as nx
from shapely.geometry import LineString, Point as ShPoint
from shapely.ops import substring
from shapely.strtree import STRtree
from backend.utils.geometry import haversine_m, bearing_between, offset_latlon
from backend.core.logging import logger

ROUTE_PROFILE_FEEDER = "feeder"
ROUTE_PROFILE_DISTRIBUTION = "distribution"

# Feeder diberi preferensi ke koridor utama. Distribusi tetap boleh masuk ke
# jalan lingkungan/service, tetapi tidak ke footway/cycleway yang sudah
# dibuang saat graf OSM dibangun.
_ROAD_CLASS_PENALTIES = {
    ROUTE_PROFILE_FEEDER: {
        "motorway": 1.0,
        "trunk": 1.0,
        "primary": 1.0,
        "secondary": 1.10,
        "tertiary": 1.25,
        "unclassified": 1.55,
        "residential": 1.70,
        "road": 1.70,
        "living_street": 2.10,
        "service": 2.25,
        "track": 4.0,
    },
    ROUTE_PROFILE_DISTRIBUTION: {
        "motorway": 1.30,
        "trunk": 1.15,
        "primary": 1.05,
        "secondary": 1.0,
        "tertiary": 1.0,
        "unclassified": 1.0,
        "residential": 1.0,
        "road": 1.0,
        "living_street": 1.05,
        "service": 1.15,
        "track": 2.0,
    },
}

_EDGE_INDEX_CACHE = weakref.WeakKeyDictionary()
_EDGE_INDEX_LOCK = threading.Lock()


class _RoadEdgeIndex:
    """Spatial index edge yang dibangun sekali untuk satu instance graf."""

    def __init__(self, graph):
        self.edges = []
        self.lines = []
        for u, v, key, data in graph.edges(keys=True, data=True):
            line = data.get("geometry")
            if line is None:
                line = LineString(
                    [
                        (graph.nodes[u]["x"], graph.nodes[u]["y"]),
                        (graph.nodes[v]["x"], graph.nodes[v]["y"]),
                    ]
                )
            self.edges.append((u, v, key))
            self.lines.append(line)
        if not self.lines:
            raise ValueError("Graf jalan tidak memiliki edge")
        self.tree = STRtree(self.lines)

    def nearest_edge(self, lat, lon):
        index = int(self.tree.nearest(ShPoint(lon, lat)))
        return self.edges[index]


def _edge_index(graph):
    try:
        return _EDGE_INDEX_CACHE[graph]
    except KeyError:
        with _EDGE_INDEX_LOCK:
            index = _EDGE_INDEX_CACHE.get(graph)
            if index is None:
                index = _RoadEdgeIndex(graph)
                _EDGE_INDEX_CACHE[graph] = index
            return index


def _highway_types(edge_data):
    value = edge_data.get("highway", "road")
    if isinstance(value, (list, tuple, set)):
        return [str(item) for item in value if item]
    return [str(value)] if value else ["road"]


def _profile_penalty(edge_data, profile):
    penalties = _ROAD_CLASS_PENALTIES.get(
        profile, _ROAD_CLASS_PENALTIES[ROUTE_PROFILE_DISTRIBUTION]
    )
    return min(penalties.get(kind, 1.75) for kind in _highway_types(edge_data))


def _edge_cost(edge_data, profile):
    try:
        length = float(edge_data.get("length", 0.0))
    except (TypeError, ValueError):
        length = 0.0
    return max(length, 0.001) * _profile_penalty(edge_data, profile)


def _graph_weight(profile):
    """Weight callable yang mendukung Graph dan MultiGraph NetworkX."""
    def weight(_u, _v, data):
        if "length" in data:  # Graph biasa: data adalah attribute dict.
            return _edge_cost(data, profile)
        # MultiGraph: data adalah {key: attribute dict}.
        return min(_edge_cost(attrs, profile) for attrs in data.values())

    return weight


def _append_unique(target, coords, tolerance=1e-12):
    for coord in coords:
        coord = (float(coord[0]), float(coord[1]))
        if not target or math.dist(target[-1], coord) > tolerance:
            target.append(coord)


def _trace_edge_line(line, from_latlon, to_latlon):
    """Ambil potongan geometri edge dengan arah from -> to."""
    from_point = ShPoint(from_latlon[1], from_latlon[0])
    to_point = ShPoint(to_latlon[1], to_latlon[0])
    t1 = line.project(from_point)
    t2 = line.project(to_point)
    if math.isclose(t1, t2, abs_tol=1e-12):
        return [from_latlon, to_latlon]

    piece = substring(line, min(t1, t2), max(t1, t2))
    coords = [(lat, lon) for lon, lat in piece.coords]
    if t2 < t1:
        coords.reverse()
    coords[0] = from_latlon
    coords[-1] = to_latlon
    return coords


def _node_latlon(graph, node):
    return float(graph.nodes[node]["y"]), float(graph.nodes[node]["x"])


def _partial_edge_cost(info, node_latlon, profile):
    if info["len_deg"] <= 0:
        return 0.0
    node_position = info["line"].project(ShPoint(node_latlon[1], node_latlon[0]))
    fraction = abs(node_position - info["t_deg"]) / info["len_deg"]
    return fraction * info["len_m"] * _profile_penalty(info["data"], profile)


def _same_physical_edge(first, second):
    u1, v1, key1 = first["edge"]
    u2, v2, key2 = second["edge"]
    if {u1, v1} != {u2, v2} or key1 != key2:
        return False
    osmids1 = first["data"].get("osmid")
    osmids2 = second["data"].get("osmid")
    if osmids1 is None or osmids2 is None:
        return True
    if not isinstance(osmids1, (list, tuple, set)):
        osmids1 = [osmids1]
    if not isinstance(osmids2, (list, tuple, set)):
        osmids2 = [osmids2]
    return bool(set(osmids1) & set(osmids2))


def _best_edge_data(graph, u, v, profile):
    groups = [graph.get_edge_data(u, v)]
    if graph.is_directed():
        groups.append(graph.get_edge_data(v, u))
    groups = [group for group in groups if group is not None]
    if not groups:
        return None

    candidates = []
    for group in groups:
        if "length" in group:  # Graph biasa.
            candidates.append(group)
        else:
            candidates.extend(group.values())
    return min(candidates, key=lambda data: _edge_cost(data, profile))


def _edge_path_coords(graph, u, v, profile):
    data = _best_edge_data(graph, u, v, profile)
    if not data:
        return [_node_latlon(graph, u), _node_latlon(graph, v)]
    line = data.get("geometry")
    if line is None:
        return [_node_latlon(graph, u), _node_latlon(graph, v)]

    coords = [(lat, lon) for lon, lat in line.coords]
    if math.dist(coords[0], _node_latlon(graph, v)) < math.dist(
        coords[0], _node_latlon(graph, u)
    ):
        coords.reverse()
    return coords


def _snapped_latlon(info):
    point = info["line"].interpolate(info["t_deg"])
    return float(point.y), float(point.x)


def route_along_road(
    road_graph,
    from_latlon,
    to_latlon,
    profile=ROUTE_PROFILE_DISTRIBUTION,
    max_snap_distance_m=250.0,
):
    """Cari rute kabel di sepanjang geometri jaringan jalan.

    Titik awal/akhir boleh sedikit di luar jalan; hanya konektor pendek dari
    titik tersebut ke hasil snap yang berupa garis lurus. Seluruh bagian di
    antara kedua hasil snap selalu dibangun dari geometri edge OSM.
    """
    if road_graph is None or road_graph.number_of_edges() == 0:
        return None

    try:
        start_info = locate_on_road(road_graph, *from_latlon)
        end_info = locate_on_road(road_graph, *to_latlon)
    except Exception as exc:
        logger.warning("Gagal snap titik ke graf jalan: %s", exc)
        return None

    snapped_start = _snapped_latlon(start_info)
    snapped_end = _snapped_latlon(end_info)
    if (
        haversine_m(*from_latlon, *snapped_start) > max_snap_distance_m
        or haversine_m(*to_latlon, *snapped_end) > max_snap_distance_m
    ):
        logger.warning(
            "Titik routing terlalu jauh dari jalan (batas %.0f m): %s -> %s",
            max_snap_distance_m,
            from_latlon,
            to_latlon,
        )
        return None

    # Kabel tidak terikat aturan one-way kendaraan.
    graph = road_graph.to_undirected(as_view=True)
    weight = _graph_weight(profile)
    best = None

    if _same_physical_edge(start_info, end_info):
        fraction = (
            abs(start_info["t_deg"] - end_info["t_deg"]) / start_info["len_deg"]
            if start_info["len_deg"] > 0
            else 0.0
        )
        best = {
            "cost": fraction
            * start_info["len_m"]
            * _profile_penalty(start_info["data"], profile),
            "direct": True,
        }

    start_nodes = list(dict.fromkeys(start_info["edge"][:2]))
    end_nodes = list(dict.fromkeys(end_info["edge"][:2]))
    for start_node in start_nodes:
        start_node_latlon = _node_latlon(road_graph, start_node)
        start_cost = _partial_edge_cost(start_info, start_node_latlon, profile)
        for end_node in end_nodes:
            end_node_latlon = _node_latlon(road_graph, end_node)
            end_cost = _partial_edge_cost(end_info, end_node_latlon, profile)
            try:
                network_cost, node_path = nx.single_source_dijkstra(
                    graph, start_node, end_node, weight=weight
                )
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                continue
            total_cost = start_cost + network_cost + end_cost
            if best is None or total_cost < best["cost"]:
                best = {
                    "cost": total_cost,
                    "direct": False,
                    "path": node_path,
                    "start_node": start_node,
                    "end_node": end_node,
                }

    if best is None:
        logger.warning("Tidak ada rute jalan dari %s ke %s", from_latlon, to_latlon)
        return None

    coords = []
    _append_unique(coords, [from_latlon, snapped_start])
    if best["direct"]:
        _append_unique(
            coords,
            _trace_edge_line(start_info["line"], snapped_start, snapped_end),
        )
    else:
        start_node_latlon = _node_latlon(road_graph, best["start_node"])
        _append_unique(
            coords,
            _trace_edge_line(start_info["line"], snapped_start, start_node_latlon),
        )
        for u, v in zip(best["path"], best["path"][1:]):
            _append_unique(coords, _edge_path_coords(road_graph, u, v, profile))
        end_node_latlon = _node_latlon(road_graph, best["end_node"])
        _append_unique(
            coords,
            _trace_edge_line(end_info["line"], end_node_latlon, snapped_end),
        )
    _append_unique(coords, [to_latlon])
    return coords


def _edge_geometry_and_length(road_graph, u, v, key):
    """Ambil geometri (shapely LineString, koordinat lon/lat) dan panjang
    riil (meter) suatu edge di graf jalan. Kalau edge tidak punya atribut
    'geometry' (garis lurus antar node), bikin LineString dari koordinat
    node-nya. Kalau tidak ada atribut 'length' (meter), hitung sendiri via
    haversine sepanjang garisnya."""
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
    u, v, key = _edge_index(road_graph).nearest_edge(lat, lon)
    line, len_m = _edge_geometry_and_length(road_graph, u, v, key)
    edge_data = road_graph.edges[u, v, key]
    t_deg = line.project(ShPoint(lon, lat))
    len_deg = line.length
    return {
        "edge": (u, v, key),
        "data": edge_data,
        "line": line,
        "len_deg": len_deg,
        "len_m": float(len_m),
        "t_deg": t_deg,
    }


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
                    # Jangan memindahkan kabinet ke pekarangan. Coba beberapa
                    # target radial lalu snap kembali ke ruas jalan.
                    for attempt in range(12):
                        bearing = (137.5 * (j + attempt + 1)) % 360
                        target = offset_latlon(
                            a.lat, a.lon, min_dist_m * (1 + attempt // 4), bearing
                        )
                        try:
                            candidate = snap_to_road(road_graph, *target)
                        except Exception:
                            continue
                        if all(
                            haversine_m(*candidate, odcs[k].lat, odcs[k].lon)
                            >= min_dist_m
                            for k in range(n)
                            if k != j
                        ):
                            result = candidate
                            break

                if result is None:
                    logger.warning(
                        "%s tidak dapat digeser %.0f m tanpa keluar dari jalan; "
                        "posisi jalan saat ini dipertahankan",
                        b.id,
                        min_dist_m,
                    )
                    continue

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


def build_distribution_tree(odc, road_graph=None):
    """Bangun segmen distribusi sebagai minimum spanning tree sederhana.

    Topologi tree dipilih dengan jarak geografis lokal, lalu hanya segmen yang
    terpilih yang dirutekan pada graf jalan. Ini menjaga jumlah shortest-path
    tetap linear terhadap jumlah ODP dan penting untuk desain berskala besar.
    """
    if not odc.odps:
        return []

    connected = [("ODC", (odc.lat, odc.lon))]
    remaining = list(enumerate(odc.odps, start=1))
    segments = []

    while remaining:
        candidates = []
        for odp_index, odp in remaining:
            destination = (odp.lat, odp.lon)
            for from_label, origin in connected:
                candidates.append(
                    (
                        haversine_m(*origin, *destination),
                        odp_index,
                        from_label,
                        origin,
                        odp,
                    )
                )

        _, odp_index, from_label, origin, odp = min(
            candidates, key=lambda candidate: (candidate[0], candidate[1])
        )
        destination = (odp.lat, odp.lon)
        path = None
        if road_graph is not None:
            try:
                path = route_along_road(
                    road_graph,
                    origin,
                    destination,
                    profile=ROUTE_PROFILE_DISTRIBUTION,
                )
            except Exception as exc:
                logger.warning(
                    "Routing distribusi gagal untuk %s -> %s: %s",
                    origin,
                    destination,
                    exc,
                )
        if not path:
            path = [origin, destination]
        segments.append(
            {
                "from_label": from_label,
                "from_latlon": origin,
                "odp_index": odp_index,
                "odp": odp,
                "coords": path,
            }
        )
        connected.append((f"ODP-{odp_index}", (odp.lat, odp.lon)))
        remaining = [item for item in remaining if item[0] != odp_index]

    return segments


def _build_feeder_segments(pop, odcs, road_graph):
    segments = []
    current_label = pop["name"]
    current_latlon = (pop["lat"], pop["lon"])
    for odc in odcs:
        target_latlon = (odc.lat, odc.lon)
        path = None
        if road_graph is not None:
            try:
                path = route_along_road(
                    road_graph,
                    current_latlon,
                    target_latlon,
                    profile=ROUTE_PROFILE_FEEDER,
                )
            except Exception as exc:
                logger.warning(
                    "Routing feeder %s -> %s gagal: %s",
                    current_label,
                    odc.id,
                    exc,
                )
        if not path:
            if road_graph is not None:
                logger.warning(
                    "Routing feeder %s -> %s tidak tersedia; memakai garis lurus",
                    current_label,
                    odc.id,
                )
            path = [current_latlon, target_latlon]
        segments.append(
            {"from_label": current_label, "to_label": odc.id, "coords": path}
        )
        current_label = odc.id
        current_latlon = target_latlon
    return segments


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

    return _build_feeder_segments(pop, ordered, road_graph), ordered


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
    return _build_feeder_segments(pop, odcs, road_graph), odcs


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
