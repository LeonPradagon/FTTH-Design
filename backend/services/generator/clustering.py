import math
import os
import numpy as np
import concurrent.futures
import json
from backend.services.generator.models import Splitter, ODP, ODC
from backend.core.config import settings
from backend.services.generator.routing import snap_to_road

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
            import random
            random.seed(42)  # Deterministic seed
            seed_pos = random.randint(0, len(rem_coords) - 1)
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


def snap_centroid_to_road(target_centroid, road_graph, max_snap_dist_m=200.0):
    """Fallback ke road snapping (Nearest Node). 
    Jika hasil snap terlalu jauh dari centroid (> max_snap_dist_m), 
    gunakan centroid asli agar ODP/ODC tidak nyasar jauh dari rumah."""
    if road_graph is None:
        return target_centroid
    try:
        snapped = snap_to_road(road_graph, target_centroid[0], target_centroid[1])
        # Validasi jarak — jangan snap jika terlalu jauh
        from backend.utils.geometry import haversine_m
        dist = haversine_m(target_centroid[0], target_centroid[1], snapped[0], snapped[1])
        if dist > max_snap_dist_m:
            return target_centroid
        return snapped
    except Exception:
        return target_centroid


def build_design(houses, odp_capacity=10, odc_capacity=4, road_graph=None):
    """Bangun struktur ODC -> ODP -> rumah dari daftar titik rumah.
    Penomoran ODC di sini masih berdasar urutan cluster (belum urutan
    rantai feeder) -- akan di-renumber ulang oleh build_feeder_chain()."""
    import concurrent.futures

    # -- Tahap 1: rumah -> ODP (tiap ODP dapat splitter 1:odp_capacity) --
    house_clusters = capacitated_clustering(houses, odp_capacity)
    
    def process_odp(i, idxs):
        cluster_houses = [houses[j] for j in idxs]
        c_lat, c_lon = centroid_of(cluster_houses)
        lat, lon = snap_centroid_to_road(
            target_centroid=(c_lat, c_lon),
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
        lat, lon = snap_centroid_to_road(
            target_centroid=(c_lat, c_lon),
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
