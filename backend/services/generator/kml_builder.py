import simplekml
from backend.services.generator.routing import build_distribution_tree

def export_kmz(pop, odcs, feeder_segments, output_path, include_homepass=False, road_graph=None, road_feeder=False, boundary=None, boundary_style=None):
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

    if boundary is not None:
        fol_bound = kml.newfolder(name="Boundary Area")
        coords = list(boundary.exterior.coords)
        pol = fol_bound.newpolygon(name="Boundary")
        pol.outerboundaryis = coords
        if boundary_style:
            pol.style.polystyle.color = boundary_style.get("poly_color", "4dff0000")
            pol.style.linestyle.color = boundary_style.get("line_color", "ffff0000")
            pol.style.linestyle.width = boundary_style.get("line_width", 3.0)
        else:
            pol.style.polystyle.color = '4dff0000'
            pol.style.linestyle.color = 'ffff0000'
            pol.style.linestyle.width = 3.0

    # -- OLT --
    fol_olt = kml.newfolder(name="OLT")
    p = fol_olt.newpoint(name=pop["name"], description="SERVER OLT", coords=[(pop["lon"], pop["lat"])])
    p.style.iconstyle.color = simplekml.Color.red
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
    for i, odc in enumerate(odcs, start=1):
        odc_label = f"ODC {i:02d}"          # label titik, mis. "ODC 01"
        fol_odc_top = kml.newfolder(name=f"ODC {i}")  # folder utama, mis. "ODC 1"

        fol_odc = fol_odc_top.newfolder(name="ODC")
        fol_closure = fol_odc_top.newfolder(name="JOIN CLOSURE")
        fol_odp = fol_odc_top.newfolder(name="ODP")
        fol_dist = fol_odc_top.newfolder(name="LINE ODC TO ODP")
        if include_homepass:
            fol_hc = fol_odc_top.newfolder(name="HC")
            fol_hc.visibility = 0
            fol_drop = fol_odc_top.newfolder(name="LINE ODP TO HC")
            fol_drop.visibility = 0

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

        routing_graph = road_graph if road_graph is not None and road_feeder else None
        for segment in build_distribution_tree(odc, routing_graph):
            odp_label = f"{i:02d}/{segment['odp_index']:02d}"
            coords = [(lon, lat) for lat, lon in segment["coords"]]
            dist = fol_dist.newlinestring(
                name=f"ODC {i:02d} TO ODP {odp_label}",
                coords=coords,
            )
            dist.style.linestyle.color = simplekml.Color.blue
            dist.style.linestyle.width = 2

        if not include_homepass:
            total_houses += sum(len(odp.houses) for odp in odc.odps)
            continue

        # Drop cable memang berupa konektor last-mile dari ODP ke bangunan;
        # feeder dan distribusi tetap dirutekan di jaringan jalan.
        for j, odp in enumerate(odc.odps, start=1):
            odp_label = f"{i:02d}/{j:02d}"
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
