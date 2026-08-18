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
