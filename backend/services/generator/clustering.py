import math
import os
import numpy as np
import concurrent.futures
import json
from backend.services.generator.models import Splitter, ODP, ODC
from backend.services.generator.generation_config import GenerationConfig
from backend.core.config import settings
from backend.core.logging import logger
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


def snap_centroid_to_road(target_centroid, road_graph):
    """Snap a generated cabinet position to a valid vehicle road.

    Returning an unsnapped centroid here creates a straight connector in the
    exporter, which can cut across a railway, river, or private property.  A
    routing-backed generation must fail loudly instead so the caller can
    retry with a larger/valid OSM area.
    """
    if road_graph is None:
        return target_centroid
    return snap_to_road(road_graph, target_centroid[0], target_centroid[1])


def build_design(houses, odp_capacity=None, odc_capacity=None, road_graph=None, config=None):
    """Bangun struktur ODC -> ODP -> rumah dari daftar titik rumah.
    Penomoran ODC di sini masih berdasar urutan cluster (belum urutan
    rantai feeder) -- akan di-renumber ulang oleh build_feeder_chain().

    Accepts either a ``GenerationConfig`` via *config*, or the legacy
    *odp_capacity* / *odc_capacity* integers for backward compatibility.
    """
    import concurrent.futures

    if config is None:
        config = GenerationConfig(
            odp_capacity=odp_capacity or 10,
            odc_capacity=odc_capacity or 4,
        )

    logger.info(
        "build_design: odp_capacity=%d, odc_capacity=%d, houses=%d",
        config.odp_capacity,
        config.odc_capacity,
        len(houses),
    )

    # -- Tahap 1: rumah -> ODP (tiap ODP dapat splitter 1:odp_capacity) --
    house_clusters = capacitated_clustering(houses, config.odp_capacity)
    
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
            splitter=Splitter(ratio=f"1:{config.odp_capacity}", location="ODP"),
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
    odp_clusters = capacitated_clustering(odp_coords, config.odc_capacity)
    
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
            splitter=Splitter(ratio=f"1:{config.odc_capacity}", location="ODC"),
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
