import simplekml
from shapely.geometry import shape
from backend.services.generator.routing import route_along_road

def export_kmz(
    pop,
    odcs,
    feeder_segments,
    output_path,
    include_homepass=False,
    road_graph=None,
    road_feeder=False,
    road_drop=False,
    distribution_segments=None,
    progress_callback=None,
    boundary=None,
):
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

    # Keep the source boundary in the same KMZ as the generated network so
    # the downloaded file is a complete, self-contained design artifact.
    if boundary is not None:
        boundary_geometry = shape(boundary) if isinstance(boundary, dict) else boundary
        boundary_folder = kml.newfolder(name="BOUNDARY")
        geometries = (
            list(boundary_geometry.geoms)
            if boundary_geometry.geom_type == "MultiPolygon"
            else [boundary_geometry]
        )
        for index, polygon in enumerate(geometries, start=1):
            boundary_polygon = boundary_folder.newpolygon(
                name="Boundary" if len(geometries) == 1 else f"Boundary {index:02d}",
                outerboundaryis=[(x, y) for x, y in polygon.exterior.coords],
                innerboundaryis=[
                    [(x, y) for x, y in ring.coords]
                    for ring in polygon.interiors
                ],
            )
            boundary_polygon.style.polystyle.color = simplekml.Color.changealphaint(
                70, simplekml.Color.blue
            )
            boundary_polygon.style.linestyle.color = simplekml.Color.blue
            boundary_polygon.style.linestyle.width = 2

    # -- OLT --
    fol_olt = kml.newfolder(name="OLT")
    p = fol_olt.newpoint(name=pop["name"], description="SERVER OLT", coords=[(pop["lon"], pop["lat"])])
    p.style.iconstyle.icon.href = "http://maps.google.com/mapfiles/kml/shapes/electronics.png"
    p.style.iconstyle.color = simplekml.Color.yellow
    p.style.iconstyle.scale = 1.3

    # -- LINE FD (feeder): rantai POP -> ODC1 -> ODC2 -> ... mengikuti jalan --
    fol_fd = kml.newfolder(name="LINE FD")
    for seg in feeder_segments:
        coords_lonlat = [(lon, lat) for lat, lon in seg["coords"]]
        if len(coords_lonlat) == 1:
            coords_lonlat.append((coords_lonlat[0][0] + 0.00001, coords_lonlat[0][1] + 0.00001))
        
        feeder = fol_fd.newlinestring(
            name=f"FD {seg['from_label']} -> {seg['to_label']}",
            coords=coords_lonlat,
        )
        feeder.style.linestyle.color = simplekml.Color.red
        feeder.style.linestyle.width = 3

    total_houses = 0
    total_items = sum(
        1 + (len(odp.houses) if include_homepass else 0)
        for odc in odcs
        for odp in odc.odps
    )
    processed_items = 0
    odp_labels = {
        odp.id: f"{i:02d}/{j:02d}"
        for i, odc in enumerate(odcs, start=1)
        for j, odp in enumerate(odc.odps, start=1)
    }
    odc_labels = {odc.id: f"ODC {i:02d}" for i, odc in enumerate(odcs, start=1)}

    def report_progress(message):
        if progress_callback:
            progress_callback(processed_items, total_items, message)

    report_progress("Menyiapkan folder perangkat...")
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
            # Keep the Dijkstra distance trees only for this ODP. All drop
            # cables below start at the same ODP, so they can reuse the
            # expensive graph traversal without retaining every ODP's tree
            # in memory.
            odp_route_cache = {"distances": {}, "targeted": True}

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
            distribution_connected = True
            distribution_source_label = odc_label
            cached_distribution = (
                distribution_segments.get(odp.id)
                if distribution_segments is not None else None
            )
            if isinstance(cached_distribution, dict):
                distribution_connected = bool(cached_distribution.get("connected"))
                path = cached_distribution.get("coords") or []
                source_id = cached_distribution.get("source_id")
                distribution_source_label = (
                    odc_labels.get(source_id)
                    or odp_labels.get(source_id)
                    or source_id
                    or odc_label
                )
                if distribution_connected and path:
                    coords = [(lon, lat) for lat, lon in path]
            elif cached_distribution is not None:
                # Backward-compatible v2 cache format: target_id -> coords.
                coords = [(lon, lat) for lat, lon in cached_distribution]
            elif road_graph and road_feeder:
                path = route_along_road(
                    road_graph, (odc.lat, odc.lon), (odp.lat, odp.lon),
                    use_external_routing=False,
                    route_cache=odp_route_cache,
                )
                if not path:
                    raise RuntimeError(f"Tidak ada koneksi jalan untuk kabel distribusi {odc_label} -> {odp_label}.")
                coords = [(lon, lat) for lat, lon in path]
                if distribution_segments is not None:
                    distribution_segments[odp.id] = {
                        "source_id": odc.id,
                        "target_id": odp.id,
                        "source_label": odc.id,
                        "target_label": odp.id,
                        "coords": list(path),
                        "connected": True,
                    }

            if distribution_connected:
                if len(coords) == 1:
                    coords.append((coords[0][0] + 0.00001, coords[0][1] + 0.00001))

                dist = fol_dist.newlinestring(
                    name=f"{distribution_source_label} TO ODP {odp_label}",
                    coords=coords,
                )
                dist.style.linestyle.color = simplekml.Color.rgb(139, 92, 246)
                dist.style.linestyle.width = 2
                processed_items += 1
                if processed_items == total_items or processed_items % max(1, total_items // 100) == 0:
                    report_progress(f"Membuat kabel distribusi dan HC ({processed_items}/{total_items})...")

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
                # Drop cable is intentionally a direct visual connection from
                # the ODP/pole to the house. It must not follow the road graph;
                # otherwise one ODP serving up to 10 houses is hard to see.
                if road_graph and road_feeder and road_drop:
                    path = route_along_road(
                        road_graph, (odp.lat, odp.lon), (h_lat, h_lon),
                        use_external_routing=False,
                        route_cache=odp_route_cache,
                    )
                    if not path:
                        raise RuntimeError(f"Tidak ada koneksi jalan untuk kabel drop {odp_label} -> {hc_label}.")
                    drop_coords = [(lon, lat) for lat, lon in path]
                
                if len(drop_coords) == 1:
                    drop_coords.append((drop_coords[0][0] + 0.00001, drop_coords[0][1] + 0.00001))

                drop = fol_drop.newlinestring(
                    name=f"ODP {odp_label} TO HC {hc_label}",
                    coords=drop_coords,
                )
                drop.style.linestyle.color = simplekml.Color.white
                drop.style.linestyle.width = 1
                processed_items += 1
                if processed_items == total_items or processed_items % max(1, total_items // 100) == 0:
                    report_progress(f"Membuat kabel distribusi dan HC ({processed_items}/{total_items})...")

    kml.savekmz(output_path)

    print(f"\nDesain selesai:")
    print(f"  Total rumah   : {total_houses}")
    print(f"  Total ODC     : {len(odcs)}")
    print(f"  Total ODP     : {sum(len(o.odps) for o in odcs)}")
    print(f"  Segmen feeder : {len(feeder_segments)} (POP -> {' -> '.join(s['to_label'] for s in feeder_segments)})")
    print(f"Output disimpan di: {output_path}")
