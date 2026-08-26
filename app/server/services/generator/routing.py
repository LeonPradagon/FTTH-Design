import math
import ast
import networkx as nx
import osmnx as ox
from shapely.geometry import Point as ShPoint, LineString
from shapely.ops import substring
from server.utils.geometry import haversine_m, bearing_between, offset_latlon
from server.core.logging import logger

# Bump this whenever the allowed edge set or cost model changes.  Existing
# GraphML caches are re-sanitised instead of silently reusing an old profile.
ROAD_PROFILE_VERSION = "vehicle-roads-v5"
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


def prepare_road_graph(road_graph, routing_strategy="priority_road"):
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

        factor = (
            1.0
            if routing_strategy == "shortest"
            else min(ROAD_PRIORITY_FACTORS.get(kind, 1.5) for kind in allowed_types)
        )
        length = float(data.get("length") or 0.0)
        data["routing_cost"] = max(length, 0.01) * factor

    road_graph.remove_edges_from(invalid_edges)
    road_graph.remove_nodes_from(list(nx.isolates(road_graph)))
    if road_graph.number_of_edges() == 0:
        raise ValueError("Road graph tidak memiliki jalan kendaraan yang valid.")

    road_graph.graph["ftth_road_profile"] = f"{ROAD_PROFILE_VERSION}:{routing_strategy}"
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
    route_cache=None,
    return_metadata=False,
):
    """Cari rute terpendek di graf jalan `G` antara dua titik (lat, lon) 
    dengan menelusuri geometri jalan secara presisi."""
    import networkx as nx
    import osmnx as ox
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
    if not str(G.graph.get("ftth_road_profile", "")).startswith(ROAD_PROFILE_VERSION):
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
                # Ensure continuity: stitch this edge geometry to the
                # previous segment by replacing its first point with the
                # last point already in route_coords.  Without this,
                # OSM edge geometries can have tiny gaps at graph nodes
                # that make the cable look disconnected on the map.
                if route_coords:
                    coords[0] = route_coords[-1]
                coords[-1] = (G.nodes[v]["y"], G.nodes[v]["x"])
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

    # Guarantee the path starts and ends at the originally requested
    # endpoints. We insert them if they differ from the snapped points
    # so we don't overwrite the perpendicular snap point on the road.
    if len(final_coords) >= 1:
        if final_coords[0] != from_latlon:
            final_coords.insert(0, from_latlon)
        if final_coords[-1] != to_latlon:
            final_coords.append(to_latlon)

    result = route_result(final_coords, best_len)
    if route_cache is not None and return_metadata:
        route_cache.setdefault("routes", {})[route_key] = result
    return result if return_metadata else result_coords(result)


def route_with_connectivity_fallback(
    road_graph,
    from_latlon,
    to_latlon,
    route_cache=None,
    return_metadata=False,
):
    """Route on roads and retry on an undirected view when needed.

    OSM vehicle graphs can be directed because of one-way traffic rules. A
    fiber cable can be installed along that same road in either direction, so
    rejecting a path only because the vehicle graph is one-way creates false
    disconnected ODP/ODC segments. The retry still uses road geometry; it is
    not a straight-line fallback through buildings.
    """
    try:
        result = route_along_road(
            road_graph,
            from_latlon,
            to_latlon,
            route_cache=route_cache,
            return_metadata=return_metadata,
        )
    except Exception as exc:
        logger.debug(
            "Rute directed gagal untuk %s -> %s, mencoba konektivitas dua arah: %s",
            from_latlon,
            to_latlon,
            exc,
        )
        result = None
    if result or not road_graph.is_directed():
        return result

    try:
        undirected_graph = road_graph.to_undirected(as_view=True)
        # Do not reuse a failed directed route cache for the retry. The cache
        # is keyed by endpoints, not by graph directionality.
        retry_cache = {"distances": {}, "targeted": True}
        result = route_along_road(
            undirected_graph,
            from_latlon,
            to_latlon,
            route_cache=retry_cache,
            return_metadata=return_metadata,
        )
        if result:
            logger.info(
                "Rute kabel memakai retry road-undirected: %s -> %s",
                from_latlon,
                to_latlon,
            )
        return result
    except Exception as exc:
        logger.warning(
            "Retry konektivitas road-undirected gagal untuk %s -> %s: %s",
            from_latlon,
            to_latlon,
            exc,
        )
        return None


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
    if not str(road_graph.graph.get("ftth_road_profile", "")).startswith(ROAD_PROFILE_VERSION):
        road_graph = prepare_road_graph(road_graph)
    u, v, key = ox.distance.nearest_edges(road_graph, X=lon, Y=lat)
    line, len_m = _edge_geometry_and_length(road_graph, u, v, key)
    t_deg = line.project(ShPoint(lon, lat))
    len_deg = line.length
    return {"edge": (u, v, key), "line": line, "len_deg": len_deg, "len_m": len_m, "t_deg": t_deg}


def snap_to_road(road_graph, lat, lon, max_distance_m=None):
    """Geser satu titik (lat, lon) ke posisi terdekat DI SEPANJANG jalan
    (diproyeksikan ke garis jalan itu sendiri, bukan cuma ke node/
    persimpangan terdekat). Return (lat, lon) baru."""
    info = locate_on_road(road_graph, lat, lon)
    p = info["line"].interpolate(info["t_deg"])
    distance_m = haversine_m(lat, lon, p.y, p.x)
    if max_distance_m is not None and distance_m > max_distance_m:
        raise ValueError(
            f"Nearest road is {distance_m:.0f}m away, beyond the {max_distance_m:.0f}m snapping limit."
        )
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
      - Semua ODP ditempatkan terpisah dari ODC agar kabel ODC -> ODP
        memiliki geometri yang terlihat. Jarak minimalnya `offset_m` meter.
      - Kalau `road_graph` tersedia, jaraknya ditempuh dengan BERJALAN
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

    # Jangan menaruh ODP persis di ODC. Dua marker yang bertumpuk membuat
    # kabel distribusi menjadi LineString nol-panjang dan tampak patah/hilang.
    used_points = []
    n = len(ordered)
    for idx, odp in enumerate(ordered):
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
                      f"cari titik jalan terdekat.")
            bearing = (360.0 / n) * idx if n else 0
            result = offset_latlon(odc.lat, odc.lon, offset_m, bearing)
            if road_graph is not None:
                try:
                    # Never leave an ODP fallback inside a building block;
                    # route endpoints must remain on the road graph.
                    result = snap_to_road(road_graph, result[0], result[1])
                except Exception:
                    pass

        odp.lat, odp.lon = result
        used_points.append(result)


def rebalance_odps_by_road_connectivity(
    odcs,
    road_graph,
    max_distribution_length_m=500.0,
    odc_capacity=4,
):
    """Move generated ODPs to a reachable ODC when the cluster parent is bad.

    Clustering uses geographic centroids, while cables must use the road
    network. A point can therefore be only 100 m from its ODC as the crow
    flies but require a multi-kilometre detour because of a railway, highway,
    river, or disconnected road component. Before exporting the distribution
    tree, try nearby ODCs and choose a valid road connection under the design
    limit. Explicit custom ODC/ODP mappings do not call this function.

    ODC capacity is never exceeded. When a nearby ODC is full, a capacity-safe
    swap is attempted if it improves the combined road length.
    """
    if road_graph is None or not odcs:
        return odcs

    route_cache = {"distances": {}, "targeted": True}
    all_odps = [(odc, odp) for odc in odcs for odp in odc.odps]

    # Solve the parent assignment globally for every design. A
    # greedy move cannot repair a full target ODC (ODP-025 was exactly this
    # case: ODC-002 was the best road parent but already had four ODPs).
    # The flow keeps every ODC within capacity while minimizing total road
    # length. The assignment only routes each ODP to a bounded set of nearby
    # ODCs, so the flow remains practical for large dashboard designs. The
    # previous size cutoff sent large designs through greedy mapping and left
    # capacity-full ODC clusters with disconnected ODPs.
    if _assign_odps_globally_by_road(
        odcs,
        road_graph,
        max_distribution_length_m=max_distribution_length_m,
        odc_capacity=odc_capacity,
        route_cache=route_cache,
    ):
        return odcs

    def route(source, target):
        try:
            return route_with_connectivity_fallback(
                road_graph,
                (source.lat, source.lon),
                (target.lat, target.lon),
                route_cache=route_cache,
                return_metadata=True,
            )
        except Exception as exc:
            logger.debug("ODP rebalancing route gagal: %s", exc)
            return None

    def geo_distance(odc, odp):
        return haversine_m(odc.lat, odc.lon, odp.lat, odp.lon)

    def candidate_odcs(odp, current):
        return sorted(
            (odc for odc in odcs if odc is not current),
            key=lambda odc: geo_distance(odc, odp),
        )[:12]

    # Iterate because moving one ODP can open a slot for another one.
    for original_current, odp in list(all_odps):
        # A previous capacity-safe swap may have moved this ODP. Always use
        # its current parent rather than the parent captured before the loop.
        current = next(
            (odc for odc in odcs if odp in odc.odps),
            original_current,
        )
        current_route = route(current, odp)
        current_length = current_route.get("length_m") if current_route else None
        if current_length is not None and current_length <= max_distribution_length_m:
            continue

        best_move = None
        for candidate in candidate_odcs(odp, current):
            candidate_route = route(candidate, odp)
            candidate_length = candidate_route.get("length_m") if candidate_route else None
            if candidate_length is None or candidate_length > max_distribution_length_m:
                continue

            if len(candidate.odps) < odc_capacity:
                best_move = (candidate, None, current_length, candidate_length)
                break

            # Keep the capacity limit by swapping with one ODP from the
            # candidate ODC. Only accept a swap when both new routes exist and
            # their total is strictly better than the old pair.
            for swap_odp in candidate.odps:
                swap_route = route(current, swap_odp)
                swap_length = swap_route.get("length_m") if swap_route else None
                if swap_length is None or swap_length > max_distribution_length_m:
                    continue
                old_swap_route = route(candidate, swap_odp)
                old_swap_length = old_swap_route.get("length_m") if old_swap_route else None
                old_total = (current_length or float("inf")) + (old_swap_length or float("inf"))
                new_total = candidate_length + swap_length
                if new_total < old_total:
                    best_move = (candidate, swap_odp, current_length, candidate_length)
                    break
            if best_move:
                break

        if not best_move:
            continue

        candidate, swap_odp, old_length, new_length = best_move
        current.odps.remove(odp)
        candidate.odps.append(odp)
        if swap_odp is not None:
            candidate.odps.remove(swap_odp)
            current.odps.append(swap_odp)
            logger.info(
                "Rebalance ODP %s: %s <-> %s untuk rute jalan yang lebih pendek",
                odp.id,
                current.id,
                candidate.id,
            )
        else:
            logger.info(
                "Rebalance ODP %s: %s -> %s (rute %.0fm -> %.0fm)",
                odp.id,
                current.id,
                candidate.id,
                old_length if old_length is not None else 0,
                new_length,
            )

    return odcs


def _assign_odps_globally_by_road(
    odcs,
    road_graph,
    max_distribution_length_m,
    odc_capacity,
    route_cache,
):
    """Capacity-constrained minimum-cost assignment of ODPs to ODCs.

    The geographically nearest ODC candidates are routed first for each ODP;
    the current parent is always included. If that local candidate graph is
    infeasible, or selects an over-limit route, candidates are expanded to
    every ODC for the affected ODPs. Costs are actual road lengths, so a
    nearby ODC on the wrong side of a barrier loses to a slightly farther ODC
    with a valid road connection without making large boundaries pay the
    all-pairs routing cost up front.
    """
    all_odps = [odp for odc in odcs for odp in odc.odps]
    if not all_odps or not odcs:
        return True

    candidate_count = min(len(odcs), max(12, odc_capacity * 4))
    route_options = {}
    route_lengths = {}
    current_parent = {
        odp.id: odc
        for odc in odcs
        for odp in odc.odps
    }

    def add_route_option(odp, odc):
        """Cache one ODC candidate and return its actual road length."""
        key = (odp.id, odc.id)
        if key in route_lengths:
            return route_lengths[key]
        try:
            result = route_with_connectivity_fallback(
                road_graph,
                (odc.lat, odc.lon),
                (odp.lat, odp.lon),
                route_cache=route_cache,
                return_metadata=True,
            )
        except Exception as exc:
            logger.debug("Global ODP mapping route gagal %s -> %s: %s", odc.id, odp.id, exc)
            route_lengths[key] = None
            return None
        if not result:
            route_lengths[key] = None
            return None

        length_m = float(result.get("length_m") or 0.0)
        route_lengths[key] = length_m
        # Integer weights are required by network_simplex. The penalty is
        # intentionally much larger than normal local route differences.
        penalty = max_distribution_length_m * 1000 if length_m > max_distribution_length_m else 0
        route_options[key] = int(round((length_m + penalty) * 100))
        return length_m

    def add_local_candidates(odp):
        current = current_parent[odp.id]
        candidates = sorted(
            odcs,
            key=lambda odc: haversine_m(odc.lat, odc.lon, odp.lat, odp.lon),
        )[:candidate_count]
        if current not in candidates:
            candidates.append(current)
        for odc in candidates:
            add_route_option(odp, odc)

    for odp in all_odps:
        add_local_candidates(odp)

    def solve_assignments():
        """Solve the current candidate graph and return assignments."""
        # Build a min-cost flow: source -> ODP (one each) -> ODC
        # (capacity) -> sink.
        flow_graph = nx.DiGraph()
        source, sink = "__odp_source__", "__odc_sink__"
        flow_graph.add_node(source, demand=-len(all_odps))
        flow_graph.add_node(sink, demand=len(all_odps))
        for odp in all_odps:
            odp_node = ("odp", odp.id)
            flow_graph.add_node(odp_node, demand=0)
            flow_graph.add_edge(source, odp_node, capacity=1, weight=0)
        for odc in odcs:
            odc_node = ("odc", odc.id)
            flow_graph.add_node(odc_node, demand=0)
            flow_graph.add_edge(odc_node, sink, capacity=odc_capacity, weight=0)
        for (odp_id, odc_id), weight in route_options.items():
            flow_graph.add_edge(
                ("odp", odp_id),
                ("odc", odc_id),
                capacity=1,
                weight=weight,
            )

        try:
            _, flow = nx.network_simplex(flow_graph)
        except (nx.NetworkXError, nx.NetworkXUnfeasible) as exc:
            logger.warning("Global mapping ODP-ODC tidak feasible: %s", exc)
            return None

        assignments = {}
        for odp in all_odps:
            odp_flow = flow.get(("odp", odp.id), {})
            selected = next(
                (node[1] for node, amount in odp_flow.items() if amount > 0 and node[0] == "odc"),
                None,
            )
            if selected is None:
                logger.warning("ODP %s tidak mendapat parent ODC dari global mapping", odp.id)
                return None
            assignments[odp.id] = selected
        return assignments

    assignments = solve_assignments()
    if assignments is None:
        # The local candidate graph can be disconnected in a large boundary.
        # Expand all candidates once before falling back to the legacy local
        # repair, otherwise a valid ODC outside the first 16 geometric
        # neighbours is never considered.
        for odp in all_odps:
            for odc in odcs:
                add_route_option(odp, odc)
        assignments = solve_assignments()

    if assignments is None:
        return False

    def over_limit_or_missing(assignment):
        return [
            odp for odp in all_odps
            if route_lengths.get((odp.id, assignment.get(odp.id))) is None
            or route_lengths[(odp.id, assignment[odp.id])] > max_distribution_length_m
        ]

    problematic = over_limit_or_missing(assignments)
    if problematic:
        # The first solve is intentionally local. Only ODPs that still have a
        # missing/over-limit selected route are expanded to every ODC, keeping
        # large designs fast while still repairing cross-barrier assignments.
        for odp in problematic:
            for odc in odcs:
                add_route_option(odp, odc)
        assignments = solve_assignments()
        if assignments is None:
            return False
        if over_limit_or_missing(assignments):
            logger.warning(
                "Global mapping tidak menemukan rute distribusi <= %.0fm untuk semua ODP",
                max_distribution_length_m,
            )
            return False

    changed = sum(
        assignments[odp.id] != current_parent[odp.id].id
        for odp in all_odps
    )
    if changed == 0:
        return True

    odc_by_id = {odc.id: odc for odc in odcs}
    for odc in odcs:
        odc.odps.clear()
    for odp in all_odps:
        odc_by_id[assignments[odp.id]].odps.append(odp)
    logger.info(
        "Global road mapping selesai: %d/%d ODP berpindah parent ODC",
        changed,
        len(all_odps),
    )
    return True


def build_distribution_tree(odc, road_graph, max_distance_m=500.0):
    """Build a road-constrained distribution tree for one ODC.

    The ODC remains the root and every ODP still counts towards the ODC
    capacity.  An ODP may nevertheless feed another ODP when that candidate
    route is valid. Candidate routes beyond ``max_distance_m`` are rejected;
    the caller can then reassign that ODP to another reachable ODC before
    export. Direct ODC→ODP routes are selected before ODP→ODP shortcuts so
    the exported cable layout remains easy to read. An ODP→ODP route is only
    used when the direct ODC route is unavailable. A Kruskal-style minimum
    tree prevents cycles while keeping the operation small: the ODC capacity
    bounds the number of ODPs in this graph.

    Return value is a dict keyed by target ODP id. Connected entries contain
    source/target metadata and road coordinates. ODPs without a valid road
    route remain disconnected rather than being connected by a line through
    buildings.
    """
    odps = list(odc.odps)
    segments = {}
    if not odps:
        return segments

    for odp in odps:
        odp.upstream_id = None

    if road_graph is None:
        return segments

    route_cache = {"distances": {}, "targeted": True}
    candidates = []

    def add_candidate(source_id, source_point, target_id, target_point):
        try:
            result = route_with_connectivity_fallback(
                road_graph,
                source_point,
                target_point,
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
        if not result:
            return
        if result["length_m"] > max_distance_m:
            logger.warning(
                "Rute distribusi %s -> %s terlalu jauh (%.0fm > %.0fm); "
                "ODP akan dicari-kan parent ODC lain.",
                source_id,
                target_id,
                result["length_m"],
                max_distance_m,
            )
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

    # Prefer the explicit ODC -> ODP relationship whenever it is routable.
    # Sorting only by route cost made a short ODP -> ODP edge win over a
    # valid direct ODC edge, which produced visually confusing branches and
    # labels such as "ODP 01/01 TO ODP 01/02" even though both ODPs had a
    # valid path from the ODC.
    candidates.sort(key=lambda item: (
        0 if item["source_id"] == odc.id else 1,
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
            coords = list(reversed(item["coords"])) if reverse else list(item["coords"])
            target = next(odp for odp in odps if odp.id == target_id)
            target.upstream_id = source_id
            # After reversing, enforce that the segment endpoints match
            # the actual device positions.  This prevents sub-meter gaps
            # that make a cable appear to stop in the middle of the road.
            if coords:
                source_obj = odc if source_id == odc.id else next(
                    (o for o in odps if o.id == source_id), None
                )
                if source_obj:
                    coords[0] = (source_obj.lat, source_obj.lon)
                coords[-1] = (target.lat, target.lon)
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
            logger.warning(
                "ODP %s tidak punya rute jalan ke tree ODC %s; kabel distribusi tidak dibuat.",
                odp.id,
                odc.id,
            )

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
                result = route_with_connectivity_fallback(
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

    _validate_feeder_chain(pop, ordered, segments)
    return segments, ordered


def _validate_feeder_chain(pop, odcs, segments):
    """Pastikan setiap ODC tersambung berurutan dalam feeder chain.

    Validasi ini mencegah hasil generate menyimpan feeder yang hilang atau
    endpoint yang tidak menempel ke POP/ODC. Hubungan ODP lintas ODC kemudian
    dapat mengikuti chain ini tanpa membuat kabel distribusi langsung antar-ODP.
    """
    if len(segments) != len(odcs):
        raise RuntimeError(
            f"Feeder chain tidak lengkap: {len(segments)} segmen untuk {len(odcs)} ODC."
        )

    expected_source = pop["name"]
    expected_source_point = (pop["lat"], pop["lon"])
    for index, (segment, odc) in enumerate(zip(segments, odcs), start=1):
        if segment.get("from_label") != expected_source or segment.get("to_label") != odc.id:
            raise RuntimeError(
                "Feeder chain tidak berurutan pada segmen "
                f"{index}: diharapkan {expected_source}->{odc.id}, "
                f"mendapatkan {segment.get('from_label')}->{segment.get('to_label')}."
            )

        coords = segment.get("coords") or []
        if len(coords) < 2:
            raise RuntimeError(f"Feeder {expected_source}->{odc.id} tidak memiliki geometri.")

        if haversine_m(*coords[0], *expected_source_point) > 1.0:
            raise RuntimeError(f"Endpoint awal feeder {expected_source}->{odc.id} tidak menempel.")
        if haversine_m(*coords[-1], odc.lat, odc.lon) > 1.0:
            raise RuntimeError(f"Endpoint akhir feeder {expected_source}->{odc.id} tidak menempel.")

        expected_source = odc.id
        expected_source_point = (odc.lat, odc.lon)


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
                result = route_with_connectivity_fallback(
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

    _validate_feeder_chain(pop, odcs, segments)
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
