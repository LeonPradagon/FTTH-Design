import math
import ast
import networkx as nx
import osmnx as ox
from shapely.geometry import Point as ShPoint, LineString
from shapely.ops import substring
from backend.utils.geometry import haversine_m, bearing_between, offset_latlon
from backend.core.logging import logger

# Bump this whenever the allowed edge set or cost model changes.  Existing
# GraphML caches are re-sanitised instead of silently reusing an old profile.
ROAD_PROFILE_VERSION = "road-priority-v4"
ALLOWED_HIGHWAY_TYPES = {
    "motorway", "motorway_link", "trunk", "trunk_link",
    "primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "residential", "living_street",
    "unclassified", "service", "road",
}
ROAD_PRIORITY_FACTORS = {
    # Main roads are deliberately preferred.  A shorter residential/service
    # shortcut must not win over a practical trunk/primary route.
    "motorway": 0.90,
    "motorway_link": 0.95,
    "trunk": 0.85,
    "trunk_link": 0.90,
    "primary": 0.90,
    "primary_link": 0.95,
    "secondary": 1.00,
    "secondary_link": 1.05,
    "tertiary": 1.15,
    "tertiary_link": 1.20,
    "residential": 1.75,
    "unclassified": 2.00,
    "living_street": 2.25,
    "road": 2.50,
    "service": 3.00,
}


def _highway_values(value):
    if isinstance(value, (list, tuple, set)):
        return {str(item).lower() for item in value}
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("["):
            try:
                parsed = ast.literal_eval(stripped)
                if isinstance(parsed, (list, tuple, set)):
                    return {str(item).lower() for item in parsed}
            except (ValueError, SyntaxError):
                pass
        return {stripped.lower()}
    return set()


def prepare_road_graph(road_graph):
    """Keep actual vehicle roads only and add a road-class routing cost.

    Native OSM XML also contains railways and other ways without a ``highway``
    tag. Those edges must never be considered cable routes.
    """
    invalid_edges = []
    for u, v, key, data in road_graph.edges(keys=True, data=True):
        highway_types = _highway_values(data.get("highway"))
        allowed_types = highway_types & ALLOWED_HIGHWAY_TYPES
        if not allowed_types:
            invalid_edges.append((u, v, key))
            continue

        factor = min(ROAD_PRIORITY_FACTORS.get(kind, 1.5) for kind in allowed_types)
        length = float(data.get("length") or 0.0)
        data["routing_cost"] = max(length, 0.01) * factor

    road_graph.remove_edges_from(invalid_edges)
    road_graph.remove_nodes_from(list(nx.isolates(road_graph)))
    if road_graph.number_of_edges() == 0:
        raise ValueError("Road graph tidak memiliki jalan kendaraan yang valid.")

    road_graph.graph["ftth_road_profile"] = ROAD_PROFILE_VERSION
    logger.info(
        "Road graph sanitized: removed %s non-road edges; %s road edges remain",
        len(invalid_edges),
        road_graph.number_of_edges(),
    )
    return road_graph

def route_along_road(
    G,
    from_latlon,
    to_latlon,
    use_external_routing=False,
    route_cache=None,
    return_metadata=False,
):
    """Cari rute terpendek di graf jalan `G` antara dua titik (lat, lon) 
    dengan menelusuri geometri jalan secara presisi."""
    import networkx as nx
    import osmnx as ox
    import requests
    import os
    from shapely.geometry import Point as ShPoint
    from shapely.ops import substring

    def route_result(coords, routing_cost=None):
        if not return_metadata:
            return coords
        length_m = sum(
            haversine_m(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1])
            for i in range(len(coords) - 1)
        )
        return {
            "coords": coords,
            "length_m": float(length_m),
            "routing_cost": float(routing_cost if routing_cost is not None else length_m),
        }

    def result_coords(value):
        """Normalize both metadata results and legacy coordinate-list results."""
        return value["coords"] if isinstance(value, dict) else value

    route_key = (
        round(from_latlon[0], 7), round(from_latlon[1], 7),
        round(to_latlon[0], 7), round(to_latlon[1], 7),
    )
    if route_cache is not None:
        cached_routes = route_cache.setdefault("routes", {})
        cached = cached_routes.get(route_key)
        if cached is not None:
            return cached if return_metadata else result_coords(cached)

    # GraphHopper is useful for a small number of feeder routes, but calling
    # it once for every HC/drop cable makes large exports spend up to the
    # HTTP timeout on every cable when the service is unavailable. Exporters
    # can disable it and use the already loaded local graph directly.
    if use_external_routing:
        gh_url = os.getenv("GRAPHHOPPER_URL", "http://localhost:8989")
        try:
            res = requests.get(
                f"{gh_url}/route?point={from_latlon[0]},{from_latlon[1]}&point={to_latlon[0]},{to_latlon[1]}&profile=car&points_encoded=false",
                timeout=2
            )
            if res.status_code == 200:
                data = res.json()
                if data.get("paths"):
                    coords = data["paths"][0]["points"]["coordinates"]
                    # GraphHopper mengembalikan [lon, lat], kita butuh [lat, lon]
                    result = route_result([(lat, lon) for lon, lat in coords])
                    if route_cache is not None and return_metadata:
                        route_cache.setdefault("routes", {})[route_key] = result
                    return result if return_metadata else result_coords(result)
        except Exception as e:
            logger.debug(f"GraphHopper routing skipped/failed: {e}. Fallback to networkx.")

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

    # Preparing the graph removes invalid edges and computes routing costs.
    # It is invariant for the lifetime of this graph, so do it only once.
    if G.graph.get("ftth_road_profile") != ROAD_PROFILE_VERSION:
        G = prepare_road_graph(G)

    # 1. Snap start and end. Reuse nearest-edge lookups for repeated endpoints.
    point_cache = route_cache.setdefault("points", {}) if route_cache is not None else {}

    def locate_cached(point):
        key = (round(point[0], 7), round(point[1], 7))
        if key not in point_cache:
            point_cache[key] = locate_on_road(G, point[0], point[1])
        return point_cache[key]

    try:
        start_info = locate_cached(from_latlon)
        start_point = start_info["line"].interpolate(start_info["t_deg"])
        snapped_start = (start_point.y, start_point.x)
        u_orig, v_orig, _ = start_info["edge"]
    except Exception:
        snapped_start = from_latlon
        u_orig = ox.distance.nearest_nodes(G, X=from_latlon[1], Y=from_latlon[0])
        v_orig = u_orig
        start_info = None

    try:
        end_info = locate_cached(to_latlon)
        end_point = end_info["line"].interpolate(end_info["t_deg"])
        snapped_end = (end_point.y, end_point.x)
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
        result = route_result(route_coords)
        if route_cache is not None and return_metadata:
            route_cache.setdefault("routes", {})[route_key] = result
        return result if return_metadata else result_coords(result)

    # 3. Cari rute terpendek antar node
    valid_starts = list(set([u_orig, v_orig]))
    valid_ends = list(set([u_dest, v_dest]))
    
    best_source = None
    best_target = None
    best_len = float('inf')

    for s in valid_starts:
        try:
            # For all houses belonging to one ODP, the source edge is usually
            # the same. Reuse the Dijkstra distance tree for that source
            # instead of traversing the entire graph for every house.
            distance_cache = route_cache.setdefault("distances", {}) if route_cache is not None else {}
            for e in valid_ends:
                if route_cache is not None and route_cache.get("targeted"):
                    # For feeder/distribution there is one destination.
                    # A* stops at that destination instead of exploring the
                    # complete graph like a full Dijkstra tree.
                    def heuristic(node, goal):
                        return 0.85 * haversine_m(
                            G.nodes[node]["y"], G.nodes[node]["x"],
                            G.nodes[goal]["y"], G.nodes[goal]["x"],
                        )
                    try:
                        length = nx.astar_path_length(
                            G, s, e, heuristic=heuristic, weight="routing_cost"
                        )
                    except (nx.NetworkXNoPath, nx.NodeNotFound):
                        length = None
                else:
                    if s not in distance_cache:
                        distance_cache[s] = nx.single_source_dijkstra_path_length(
                            G, s, weight="routing_cost"
                        )
                    length = distance_cache[s].get(e)
                if length is None:
                    continue
                dist_s = haversine_m(
                    snapped_start[0], snapped_start[1],
                    G.nodes[s]['y'], G.nodes[s]['x'],
                )
                dist_e = haversine_m(
                    snapped_end[0], snapped_end[1],
                    G.nodes[e]['y'], G.nodes[e]['x'],
                )
                total_len = dist_s + length + dist_e

                if total_len < best_len:
                    best_len = total_len
                    best_source = s
                    best_target = e
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            continue

    if best_source is None or best_target is None:
        logger.warning(f"No path found in road_graph from {from_latlon} to {to_latlon}")
        return None

    # Reconstruct only the selected path. Distances are cached per ODP, while
    # this path remains specific to this house/target.
    try:
        if route_cache is not None and route_cache.get("targeted"):
            best_path = nx.astar_path(
                G,
                best_source,
                best_target,
                heuristic=lambda node, goal: 0.85 * haversine_m(
                    G.nodes[node]["y"], G.nodes[node]["x"],
                    G.nodes[goal]["y"], G.nodes[goal]["x"],
                ),
                weight="routing_cost",
            )
        else:
            best_path = nx.shortest_path(
                G, best_source, best_target, weight="routing_cost"
            )
    except (nx.NetworkXNoPath, nx.NodeNotFound):
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
            data = min(edge_data.values(), key=lambda d: d.get("routing_cost", float('inf')))
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
            
    result = route_result(final_coords, best_len)
    if route_cache is not None and return_metadata:
        route_cache.setdefault("routes", {})[route_key] = result
    return result if return_metadata else result_coords(result)


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

    # The graph profile is immutable during routing. Re-sanitising every
    # time a house is snapped makes large exports effectively O(houses *
    # road_edges), because this function is called for every cable endpoint.
    if road_graph.graph.get("ftth_road_profile") != ROAD_PROFILE_VERSION:
        road_graph = prepare_road_graph(road_graph)
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
    Kalau tidak ada posisi alternatif yang valid, pertahankan posisi jalan
    semula agar ODC tidak pernah terdorong ke rel, sungai, atau pekarangan.
    Mutasi in-place."""
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
                    print(
                        f"  Peringatan: {b.id} tidak bisa dipindah {min_dist_m:.0f} m di jaringan jalan; "
                        "posisi jalan semula dipertahankan."
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


def build_distribution_tree(odc, road_graph, max_distance_m=500.0):
    """Build a road-constrained distribution tree for one ODC.

    The ODC remains the root and every ODP still counts towards the ODC
    capacity.  An ODP may nevertheless feed another ODP when that candidate
    route is valid.  Candidate routes are ordered by the existing routing
    cost (which prefers major roads) and then by physical length.  A
    Kruskal-style minimum tree prevents cycles while keeping the operation
    small: the ODC capacity bounds the number of ODPs in this graph.

    Return value is a dict keyed by target ODP id.  Connected entries contain
    source/target metadata and road coordinates; disconnected entries are
    explicit and intentionally contain no straight-line fallback.
    """
    odps = list(odc.odps)
    segments = {}
    if not odps:
        return segments

    for odp in odps:
        odp.upstream_id = None

    if road_graph is None:
        for odp in odps:
            segments[odp.id] = {
                "source_id": None,
                "target_id": odp.id,
                "source_label": None,
                "target_label": odp.id,
                "coords": [],
                "length_m": None,
                "routing_cost": None,
                "connected": False,
            }
        return segments

    route_cache = {"distances": {}, "targeted": True}
    candidates = []

    def add_candidate(source_id, source_point, target_id, target_point):
        try:
            result = route_along_road(
                road_graph,
                source_point,
                target_point,
                use_external_routing=False,
                route_cache=route_cache,
                return_metadata=True,
            )
        except Exception as exc:
            logger.debug(
                "Distribution route %s -> %s gagal: %s",
                source_id,
                target_id,
                exc,
            )
            return
        if not result or result["length_m"] > max_distance_m:
            return
        candidates.append({
            "source_id": source_id,
            "target_id": target_id,
            "coords": result["coords"],
            "length_m": result["length_m"],
            "routing_cost": result["routing_cost"],
        })

    for odp in odps:
        add_candidate(
            odc.id,
            (odc.lat, odc.lon),
            odp.id,
            (odp.lat, odp.lon),
        )

    for index, source in enumerate(odps):
        for target in odps[index + 1:]:
            add_candidate(
                source.id,
                (source.lat, source.lon),
                target.id,
                (target.lat, target.lon),
            )

    candidates.sort(key=lambda item: (
        item["routing_cost"],
        item["length_m"],
        item["source_id"],
        item["target_id"],
    ))

    parent = {odc.id: odc.id}

    def find(node):
        root = node
        while parent.get(root, root) != root:
            root = parent[root]
        while parent.get(node, node) != node:
            next_node = parent[node]
            parent[node] = root
            node = next_node
        return root

    def union(left, right):
        left_root, right_root = find(left), find(right)
        if left_root == right_root:
            return False
        parent[right_root] = left_root
        return True

    selected = []
    for candidate in candidates:
        if union(candidate["source_id"], candidate["target_id"]):
            selected.append(candidate)
        if len(selected) == len(odps):
            break

    # If a component could not be reached through the first tree pass, use a
    # valid direct ODC route as a deterministic fallback. Never fabricate a
    # straight line when the road graph cannot connect the device.
    selected_targets = {item["target_id"] for item in selected}
    for odp in odps:
        if odp.id in selected_targets:
            continue
        direct = next((item for item in candidates
                       if item["source_id"] == odc.id and item["target_id"] == odp.id), None)
        if direct is not None and union(direct["source_id"], direct["target_id"]):
            selected.append(direct)

    adjacency = {}
    for item in selected:
        adjacency.setdefault(item["source_id"], []).append((item["target_id"], item, False))
        adjacency.setdefault(item["target_id"], []).append((item["source_id"], item, True))

    visited = {odc.id}
    queue = [odc.id]
    while queue:
        source_id = queue.pop(0)
        for target_id, item, reverse in adjacency.get(source_id, []):
            if target_id in visited:
                continue
            visited.add(target_id)
            queue.append(target_id)
            coords = list(reversed(item["coords"])) if reverse else item["coords"]
            target = next(odp for odp in odps if odp.id == target_id)
            target.upstream_id = source_id
            segments[target_id] = {
                "source_id": source_id,
                "target_id": target_id,
                "source_label": source_id,
                "target_label": target_id,
                "coords": coords,
                "length_m": item["length_m"],
                "routing_cost": item["routing_cost"],
                "connected": True,
            }

    for odp in odps:
        if odp.id not in segments:
            segments[odp.id] = {
                "source_id": None,
                "target_id": odp.id,
                "source_label": None,
                "target_label": odp.id,
                "coords": [],
                "length_m": None,
                "routing_cost": None,
                "connected": False,
            }
            logger.warning("ODP %s tidak terhubung ke tree ODC %s", odp.id, odc.id)

    return segments


def build_feeder_chain(pop, odcs, road_graph=None, route_cache=None):
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
    # Reuse endpoint and route caches for the complete feeder chain. Keeping
    # one cache here avoids repeating nearest-edge work when a generated ODC
    # becomes the next segment's starting point.
    route_cache = route_cache or {"distances": {}, "targeted": True}
    current_label = pop["name"]
    current_latlon = (pop["lat"], pop["lon"])
    for odc in ordered:
        target_latlon = (odc.lat, odc.lon)
        path = None
        if road_graph is not None:
            try:
                result = route_along_road(
                    road_graph, current_latlon, target_latlon,
                    route_cache=route_cache,
                    return_metadata=True,
                )
                path = result.get("coords") if isinstance(result, dict) else result
            except Exception as e:
                raise RuntimeError(
                    f"Gagal membuat feeder {current_label}->{odc.id} melalui jalan: {e}"
                ) from e
            if not path:
                raise RuntimeError(
                    f"Tidak ada koneksi jalan untuk feeder {current_label}->{odc.id}."
                )
        if not path:
            path = [current_latlon, target_latlon]
        segments.append({"from_label": current_label, "to_label": odc.id, "coords": path})
        current_label = odc.id
        current_latlon = target_latlon

    return segments, ordered


def build_feeder_segments_preserving_order(pop, odcs, road_graph=None, route_cache=None):
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
    route_cache = route_cache or {"distances": {}, "targeted": True}
    current_label = pop["name"]
    current_latlon = (pop["lat"], pop["lon"])
    for odc in odcs:
        target_latlon = (odc.lat, odc.lon)
        path = None
        if road_graph is not None:
            try:
                result = route_along_road(
                    road_graph, current_latlon, target_latlon,
                    route_cache=route_cache,
                    return_metadata=True,
                )
                path = result.get("coords") if isinstance(result, dict) else result
            except Exception as e:
                raise RuntimeError(
                    f"Gagal membuat feeder {current_label}->{odc.id} melalui jalan: {e}"
                ) from e
            if not path:
                raise RuntimeError(
                    f"Tidak ada koneksi jalan untuk feeder {current_label}->{odc.id}."
                )
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
    distances = {}

    def point_key(point):
        if isinstance(point, dict):
            return (point["lat"], point["lon"])
        return (point.lat, point.lon)

    def distance(left, right):
        key = tuple(sorted((point_key(left), point_key(right))))
        if key not in distances:
            left_lat, left_lon = point_key(left)
            right_lat, right_lon = point_key(right)
            distances[key] = haversine_m(left_lat, left_lon, right_lat, right_lon)
        return distances[key]

    best_len = _chain_length_m(pop, best)
    improved = True
    it = 0
    while improved and it < max_iter:
        improved = False
        it += 1
        for i in range(n - 1):
            for j in range(i + 1, n):
                # Reversing best[i:j] changes only the two boundary edges.
                # This preserves the old 2-opt choice while reducing each
                # candidate evaluation from O(n) to O(1).
                left = pop if i == 0 else best[i - 1]
                first = best[i]
                last = best[j]
                right = best[j + 1] if j + 1 < n else None
                old_len = distance(left, first)
                new_len = distance(left, last)
                if right is not None:
                    old_len += distance(last, right)
                    new_len += distance(first, right)
                cand_len = best_len - old_len + new_len
                if cand_len < best_len - 1e-6:
                    best = best[:i] + best[i:j + 1][::-1] + best[j + 1:]
                    # The candidate length already reflects the exact two
                    # changed edges. Rebuilding the complete chain here was
                    # O(n) for every accepted move and became a major cost on
                    # large ODC sets, while producing the same value.
                    best_len = cand_len
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
