import argparse
import math
import sys

from backend.services.generator.kml_parser import read_boundary, read_points, read_houses_from_file
from backend.services.generator.osm_client import fetch_houses_in_boundary, fetch_road_graph
from backend.services.generator.clustering import build_design
from backend.services.generator.routing import build_feeder_chain, enforce_min_distance_between_odcs
from backend.services.generator.core_logic import save_design_state
from backend.services.generator.kml_builder import export_kmz
from backend.utils.geometry import haversine_m
from backend.core.logging import logger

def main():
    parser = argparse.ArgumentParser(description="FTTH Auto Design Generator")
    parser.add_argument("--input", help="Satu file KML/KMZ berisi Polygon (boundary) DAN Point (POP) sekaligus")
    parser.add_argument("--boundary", help="File boundary area (KML/KMZ) -- dipakai jika tidak pakai --input")
    parser.add_argument("--pop", help="File titik POP/OLT (KML/KMZ) -- dipakai jika tidak pakai --input")
    parser.add_argument("--output", default="design_ftth.kmz", help="Path output KMZ")
    parser.add_argument("--odp-capacity", type=int, default=10,
                         help="Kapasitas splitter di ODP / max rumah per ODP (default: 10)")
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
        pass

    feeder_segments, odcs = build_feeder_chain(pop, odcs, road_graph=road_graph)

    # Cache design state untuk fitur regenerate-cables
    try:
        save_design_state(pop, odcs, road_graph=road_graph)
    except Exception as e:
        print(f"Peringatan: gagal menyimpan design state ({e}), regenerate-cables tidak tersedia.")

    export_kmz(pop, odcs, feeder_segments, args.output, include_homepass=args.show_homepass, road_graph=road_graph, road_feeder=not args.no_road_feeder)

if __name__ == "__main__":
    main()
