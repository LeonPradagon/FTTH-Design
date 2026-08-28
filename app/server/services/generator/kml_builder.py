import math
import re
import struct
import tempfile
import zlib
from pathlib import Path

import simplekml
from shapely.geometry import shape
from server.core.logging import logger
from server.services.generator.routing import route_along_road


DEFAULT_FEATURE_COLORS = {
    "pop": "#eab308",
    "odc": "#ff0000",
    "odp": "#0000ff",
    "house": "#6b7280",
    "feeder": "#ff0000",
    "distribution": "#aa00ff",
}

ICON_CANVAS_SIZE = 96
DESIGN_ICON_SCALES = {
    # House is a custom 96px PNG, so its scale is normalized to the web map's
    # 20px icon size. ODC/ODP use Google Earth's native icon dimensions.
    "house": 20 / ICON_CANVAS_SIZE,
    "pop": 1.2,
    "odc": 1.2,
    "odp": 1.0,
}


LEGACY_DEFAULT_FEATURE_COLORS = {
    "pop": "#eab308",
    "odc": "#ef4444",
    "odp": "#3b82f6",
    "house": "#6b7280",
    "feeder": "#ef4444",
    "distribution": "#8b5cf6",
}

OLDER_DEFAULT_FEATURE_COLORS = {
    "pop": "#ef4444",
    "odc": "#3b82f6",
    "odp": "#10b981",
    "house": "#6b7280",
    "feeder": "#ef4444",
    "distribution": "#3b82f6",
}


def normalize_feature_colors(feature_colors=None):
    """Return safe, complete feature colors for KML export."""
    colors = DEFAULT_FEATURE_COLORS.copy()
    if not isinstance(feature_colors, dict):
        return colors

    for key in colors:
        value = feature_colors.get(key)
        if not isinstance(value, str):
            continue
        value = value.strip()
        if re.fullmatch(r"#[0-9a-fA-F]{6}", value):
            colors[key] = value.lower()
        elif re.fullmatch(r"#[0-9a-fA-F]{3}", value):
            colors[key] = "#" + "".join(char * 2 for char in value[1:]).lower()

    # A complete old palette is safe to migrate.  Individual colours must be
    # preserved because an admin may intentionally choose a colour that also
    # happened to be used by an older default.
    for legacy_palette in (LEGACY_DEFAULT_FEATURE_COLORS, OLDER_DEFAULT_FEATURE_COLORS):
        if all(colors[key] == value for key, value in legacy_palette.items()):
            return DEFAULT_FEATURE_COLORS.copy()
    return colors


def _kml_color(hex_color):
    """Convert a CSS #RRGGBB color to an opaque simplekml color."""
    value = hex_color.lstrip("#")
    return simplekml.Color.rgb(
        int(value[0:2], 16),
        int(value[2:4], 16),
        int(value[4:6], 16),
    )


def _add_extended_data(placemark, name):
    """Add ExtendedData with a name field to a placemark (matching reference KMZ)."""
    placemark.extendeddata = simplekml.ExtendedData()
    placemark.extendeddata.newdata(name="name", value=name)


class _IconCanvas:
    """Tiny dependency-free rasterizer for the icons used by the web map.

    KMZ viewers do not consistently render SVG or data-URI icons.  Rendering
    these few simple shapes here keeps the exported archive self-contained
    without adding Pillow/Cairo as a server dependency.
    """

    def __init__(self, width=96, height=96, supersample=4):
        self.supersample = supersample
        self.width = width * supersample
        self.height = height * supersample
        self.view_scale = self.width / 24
        self.pixels = [
            [0, 0, 0, 0]
            for _ in range(self.width * self.height)
        ]

    def _index(self, x, y):
        return y * self.width + x

    def _blend(self, x, y, color, alpha=255):
        if not (0 <= x < self.width and 0 <= y < self.height):
            return
        alpha = max(0, min(255, int(alpha)))
        if alpha == 0:
            return
        pixel = self.pixels[self._index(x, y)]
        source_alpha = alpha / 255
        destination_alpha = pixel[3] / 255
        output_alpha = source_alpha + destination_alpha * (1 - source_alpha)
        if output_alpha <= 0:
            pixel[:] = [0, 0, 0, 0]
            return
        for channel in range(3):
            pixel[channel] = int(
                (color[channel] * source_alpha
                 + pixel[channel] * destination_alpha * (1 - source_alpha))
                / output_alpha
                + 0.5
            )
        pixel[3] = int(output_alpha * 255 + 0.5)

    def _coord(self, value):
        return value * self.view_scale

    def circle(self, cx, cy, radius, color, alpha=255):
        cx = self._coord(cx)
        cy = self._coord(cy)
        radius = self._coord(radius)
        min_x = max(0, int(math.floor(cx - radius)))
        max_x = min(self.width - 1, int(math.ceil(cx + radius)))
        min_y = max(0, int(math.floor(cy - radius)))
        max_y = min(self.height - 1, int(math.ceil(cy + radius)))
        radius_sq = radius * radius
        for y in range(min_y, max_y + 1):
            for x in range(min_x, max_x + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= radius_sq:
                    self._blend(x, y, color, alpha)

    def rounded_rect(self, left, top, right, bottom, radius, color, alpha=255):
        left = self._coord(left)
        top = self._coord(top)
        right = self._coord(right)
        bottom = self._coord(bottom)
        radius = self._coord(radius)
        min_x = max(0, int(math.floor(left)))
        max_x = min(self.width - 1, int(math.ceil(right)))
        min_y = max(0, int(math.floor(top)))
        max_y = min(self.height - 1, int(math.ceil(bottom)))
        for y in range(min_y, max_y + 1):
            for x in range(min_x, max_x + 1):
                nearest_x = min(max(x, left + radius), right - radius)
                nearest_y = min(max(y, top + radius), bottom - radius)
                if (x - nearest_x) ** 2 + (y - nearest_y) ** 2 <= radius ** 2:
                    self._blend(x, y, color, alpha)

    def polygon(self, points, color, alpha=255):
        scaled = [(self._coord(x), self._coord(y)) for x, y in points]
        min_x = max(0, int(math.floor(min(x for x, _ in scaled))))
        max_x = min(self.width - 1, int(math.ceil(max(x for x, _ in scaled))))
        min_y = max(0, int(math.floor(min(y for _, y in scaled))))
        max_y = min(self.height - 1, int(math.ceil(max(y for _, y in scaled))))

        for y in range(min_y, max_y + 1):
            for x in range(min_x, max_x + 1):
                inside = False
                previous_x, previous_y = scaled[-1]
                for current_x, current_y in scaled:
                    crosses = ((current_y > y) != (previous_y > y))
                    if crosses and x < (
                        (previous_x - current_x) * (y - current_y)
                        / (previous_y - current_y)
                        + current_x
                    ):
                        inside = not inside
                    previous_x, previous_y = current_x, current_y
                if inside:
                    self._blend(x, y, color, alpha)

    def line(self, points, color, width=1, alpha=255, closed=False):
        if len(points) < 2:
            return
        segments = list(zip(points, points[1:]))
        if closed:
            segments.append((points[-1], points[0]))
        radius = width / 2
        for (x1, y1), (x2, y2) in segments:
            x1, y1, x2, y2 = (
                self._coord(x1), self._coord(y1),
                self._coord(x2), self._coord(y2),
            )
            radius_px = self._coord(radius)
            min_x = max(0, int(math.floor(min(x1, x2) - radius_px)))
            max_x = min(self.width - 1, int(math.ceil(max(x1, x2) + radius_px)))
            min_y = max(0, int(math.floor(min(y1, y2) - radius_px)))
            max_y = min(self.height - 1, int(math.ceil(max(y1, y2) + radius_px)))
            dx = x2 - x1
            dy = y2 - y1
            length_sq = dx * dx + dy * dy
            for y in range(min_y, max_y + 1):
                for x in range(min_x, max_x + 1):
                    if length_sq:
                        projection = ((x - x1) * dx + (y - y1) * dy) / length_sq
                        projection = max(0, min(1, projection))
                    else:
                        projection = 0
                    nearest_x = x1 + projection * dx
                    nearest_y = y1 + projection * dy
                    if (x - nearest_x) ** 2 + (y - nearest_y) ** 2 <= radius_px ** 2:
                        self._blend(x, y, color, alpha)
        if closed:
            for x, y in points:
                self.circle(x, y, radius, color, alpha)

    def png_bytes(self, downsample=4):
        rows = []
        for y in range(0, self.height, downsample):
            row = bytearray()
            for x in range(0, self.width, downsample):
                samples = [
                    self.pixels[self._index(x + dx, y + dy)]
                    for dy in range(downsample)
                    for dx in range(downsample)
                ]
                row.extend(
                    int(sum(pixel[channel] for pixel in samples) / len(samples) + 0.5)
                    for channel in range(4)
                )
            rows.append(b"\x00" + bytes(row))

        def chunk(kind, payload):
            return (
                struct.pack(">I", len(payload))
                + kind
                + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
            )

        width = self.width // downsample
        height = self.height // downsample
        header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
            + chunk(b"IEND", b"")
        )


def _hex_rgb(hex_color):
    value = hex_color.lstrip("#")
    return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4))


def _render_house_icon(hex_color):
    canvas = _IconCanvas()
    color = _hex_rgb(hex_color)
    background = (249, 250, 251)
    # Match the SVG circle's centred 2px stroke (path radius 11, outer
    # radius 12, inner fill radius 10).
    canvas.circle(12, 12, 12, color)
    canvas.circle(12, 12, 10, background)
    house_outline = [
        (6.75, 10.25), (12, 6.166), (17.25, 10.25),
        (17.25, 16.67), (16.08, 17.83), (7.92, 17.83),
        (6.75, 16.67), (6.75, 10.25),
    ]
    canvas.line(house_outline, color, width=2)
    canvas.line([(10.25, 17.83), (10.25, 12), (13.75, 12), (13.75, 17.83)], color, width=2)
    return canvas.png_bytes()


def _create_icon_hrefs(kml, directory, colors):
    """Add custom device icons used by ``Map.tsx`` to the KMZ."""
    assets = {
        "house": _render_house_icon(colors["house"]),
    }
    hrefs = {}
    for name, content in assets.items():
        path = Path(directory) / f"ftth-{name}.png"
        path.write_bytes(content)
        hrefs[name] = kml.addfile(str(path))
    return hrefs


def _new_icon_style(kml, href, scale, color=None):
    style = simplekml.Style()
    style.iconstyle.icon.href = href
    if color:
        style.iconstyle.color = _kml_color(color)
    style.iconstyle.scale = scale
    # The web map centers all four design icons on their coordinates.
    style.iconstyle.hotspot = simplekml.HotSpot(
        x=0.5, y=0.5, xunits="fraction", yunits="fraction"
    )
    kml.document.styles.append(style)
    return style


def _route_coords(coords, label):
    """Convert generator (lat, lon) paths to KML (lon, lat) paths."""
    converted = [(float(lon), float(lat)) for lat, lon in coords]
    if not converted:
        return []
    if len(converted) < 2:
        raise ValueError(f"Jalur {label} harus memiliki minimal dua titik.")
    return converted


def _normalize_route_endpoints(coords, start=None, end=None):
    """Snap only the displayed endpoints to their connected devices."""
    normalized = list(coords)
    if start is not None and normalized:
        normalized[0] = start
    if end is not None and normalized:
        normalized[-1] = end
    return normalized


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
    feature_colors=None,
):
    """Export desain ke KMZ dengan struktur folder flat mengikuti template
    referensi industri (Google Earth Pro), seperti contoh:

    Root
     |- BOUNDARY               -> polygon area desain (opsional)
     |- Assets
     |    |- OLT               -> titik SERVER OLT (OLT001)
     |    |- ODC               -> semua titik ODC (ODC001, ODC002, ...)
     |    |- ODP               -> semua titik ODP (ODC001.ODP001, ...)
     |    |- HC                -> semua titik homepass (opsional)
     |- Routes
     |    |- Feeder Route      -> kabel feeder (merah, width 4)
     |    |- Distribution Route -> kabel distribusi (ungu, width 4)
     |    |- Drop Route        -> kabel drop ke HC (opsional)
    """
    kml = simplekml.Kml()
    colors = normalize_feature_colors(feature_colors)
    # TemporaryDirectory is kept alive until after savekmz(), while
    # ``simplekml`` copies the custom house icon into the archive. Google
    # Earth's built-in POP/ODC/ODP icons remain remote references by design.
    icon_directory = tempfile.TemporaryDirectory(prefix="ftth-kmz-icons-")
    icon_hrefs = _create_icon_hrefs(kml, icon_directory.name, colors)
    electronics_icon = "http://maps.google.com/mapfiles/kml/shapes/electronics.png"
    triangle_icon = "http://maps.google.com/mapfiles/kml/shapes/triangle.png"

    # Shared Document Styles for better compatibility with strict KML parsers
    # (e.g. Google Earth Web).  POP/ODC/ODP use Google Earth's built-in icons;
    # their colours are applied through KML. HC remains a custom local icon.
    style_olt = _new_icon_style(
        kml,
        electronics_icon,
        scale=DESIGN_ICON_SCALES["pop"],
        color=colors["pop"],
    )
    # Use Google Earth's built-in triangle so ODC/ODP remain recognizable in
    # Google Earth and do not require another asset inside the KMZ.
    style_odc = _new_icon_style(
        kml,
        triangle_icon,
        scale=DESIGN_ICON_SCALES["odc"],
        color=colors["odc"],
    )
    style_odp = _new_icon_style(
        kml,
        triangle_icon,
        scale=DESIGN_ICON_SCALES["odp"],
        color=colors["odp"],
    )

    style_feeder = simplekml.Style()
    style_feeder.linestyle.color = _kml_color(colors["feeder"])
    style_feeder.linestyle.width = 4
    kml.document.styles.append(style_feeder)

    style_dist = simplekml.Style()
    style_dist.linestyle.color = _kml_color(colors["distribution"])
    style_dist.linestyle.width = 4
    kml.document.styles.append(style_dist)

    style_house = _new_icon_style(kml, icon_hrefs["house"], scale=DESIGN_ICON_SCALES["house"])

    style_drop = simplekml.Style()
    style_drop.linestyle.color = _kml_color(colors["house"])
    style_drop.linestyle.width = 3
    kml.document.styles.append(style_drop)

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
            bnd_name = "Boundary" if len(geometries) == 1 else f"Boundary {index:02d}"
            boundary_polygon = boundary_folder.newpolygon(
                name=bnd_name,
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

    # ================================================================
    # ASSETS — flat folders for all device placemarks
    # ================================================================
    fol_assets = kml.newfolder(name="Assets")

    # -- OLT --
    fol_olt = fol_assets.newfolder(name="OLT")
    olt_name = "OLT001"
    p = fol_olt.newpoint(
        name=olt_name,
        description="SERVER OLT",
        coords=[(pop["lon"], pop["lat"])],
    )
    p.style = style_olt
    _add_extended_data(p, olt_name)

    # -- ODC (all in one flat folder) --
    fol_odc = fol_assets.newfolder(name="ODC")

    # -- ODP (all in one flat folder) --
    fol_odp = fol_assets.newfolder(name="ODP")

    # -- HC (optional, all in one flat folder) --
    fol_hc = None
    if include_homepass:
        fol_hc = fol_assets.newfolder(name="HC")

    # ================================================================
    # ROUTES — flat folders for all cable linestrings
    # ================================================================
    fol_routes = kml.newfolder(name="Routes")

    # -- Feeder Route --
    fol_feeder = fol_routes.newfolder(name="Feeder Route")
    feeder_coords = []
    feeder_name_parts = []
    previous_feeder_end = None
    for seg in feeder_segments:
        seg_name = f"{seg['from_label']}-{seg['to_label']}"
        route_coords = _route_coords(seg["coords"], seg_name)
        # Make adjacent segments share exactly the same coordinate before
        # appending them to the single feeder cable placemark.
        route_coords = _normalize_route_endpoints(
            route_coords,
            start=previous_feeder_end,
        )
        previous_feeder_end = route_coords[-1] if route_coords else previous_feeder_end
        if not route_coords:
            continue
        if not feeder_coords:
            feeder_coords.extend(route_coords)
            feeder_name_parts.append(seg["from_label"])
        elif feeder_coords[-1] == route_coords[0]:
            feeder_coords.extend(route_coords[1:])
        else:
            feeder_coords.extend(route_coords)
        feeder_name_parts.append(seg["to_label"])

    if feeder_coords:
        feeder_name = "-".join(feeder_name_parts) or "Feeder Route"
        feeder = fol_feeder.newlinestring(name=feeder_name, coords=feeder_coords)
        feeder.style = style_feeder
        _add_extended_data(feeder, feeder_name)

    # -- Distribution Route --
    fol_dist = fol_routes.newfolder(name="Distribution Route")
    distribution_route = None

    # -- Drop Route (optional) --
    fol_drop = None
    drop_route = None
    if include_homepass:
        fol_drop = fol_routes.newfolder(name="Drop Route")

    # ================================================================
    # Populate ODC, ODP, Distribution, HC, Drop
    # ================================================================
    total_houses = 0
    total_items = sum(
        1 + (len(odp.houses) if include_homepass else 0)
        for odc in odcs
        for odp in odc.odps
    )
    processed_items = 0

    # Build label lookup tables using the reference naming convention:
    #   ODC -> ODC001, ODC002, ...
    #   ODP -> ODC001.ODP001, ODC001.ODP002, ...
    odp_labels = {
        odp.id: (
            odp.id
            if re.fullmatch(r"ODC\d+\.ODP\d+", str(odp.id or ""), re.IGNORECASE)
            else f"ODC{i:03d}.ODP{j:03d}"
        )
        for i, odc in enumerate(odcs, start=1)
        for j, odp in enumerate(odc.odps, start=1)
    }
    odc_labels = {odc.id: f"ODC{i:03d}" for i, odc in enumerate(odcs, start=1)}
    device_points = {
        odc.id: (odc.lon, odc.lat)
        for odc in odcs
    }
    device_points.update({
        odp.id: (odp.lon, odp.lat)
        for odc in odcs
        for odp in odc.odps
    })

    def report_progress(message):
        if progress_callback:
            progress_callback(processed_items, total_items, message)

    report_progress("Menyiapkan folder perangkat...")
    for i, odc in enumerate(odcs, start=1):
        odc_label = f"ODC{i:03d}"

        # -- ODC placemark (into flat Assets > ODC folder) --
        pt = fol_odc.newpoint(
            name=odc_label,
            description=(f"Splitter: {odc.splitter.ratio}\n"
                          f"Jumlah ODP: {len(odc.odps)}"),
            coords=[(odc.lon, odc.lat)],
        )
        pt.style = style_odc
        _add_extended_data(pt, odc_label)

        for j, odp in enumerate(odc.odps, start=1):
            odp_label = odp_labels[odp.id]
            # Keep the Dijkstra distance trees only for this ODP. All drop
            # cables below start at the same ODP, so they can reuse the
            # expensive graph traversal without retaining every ODP's tree
            # in memory.
            odp_route_cache = {"distances": {}, "targeted": True}

            # -- ODP placemark (into flat Assets > ODP folder) --
            opt = fol_odp.newpoint(
                name=odp_label,
                description=(f"Splitter: {odp.splitter.ratio}\n"
                              f"Jumlah rumah: {len(odp.houses)}\n"
                              f"Induk: {odc_label}"),
                coords=[(odp.lon, odp.lat)],
            )
            opt.style = style_odp
            _add_extended_data(opt, odp_label)

            coords = [(odc.lon, odc.lat), (odp.lon, odp.lat)]
            # When routing metadata is supplied, it is the source of truth.
            # Never silently recreate a missing segment with a direct line.
            distribution_connected = distribution_segments is None
            distribution_source_label = odc_label
            cached_distribution = (
                distribution_segments.get(odp.id)
                if distribution_segments is not None else None
            )
            if isinstance(cached_distribution, dict):
                path = cached_distribution.get("coords") or []
                distribution_connected = bool(cached_distribution.get("connected")) and bool(path)
                source_id = cached_distribution.get("source_id")
                distribution_source_label = (
                    odc_labels.get(source_id)
                    or odp_labels.get(source_id)
                    or source_id
                    or odc_label
                )
                if distribution_connected and path:
                    coords = _route_coords(
                        path,
                        f"{distribution_source_label}-{odp_label}",
                    )
            elif cached_distribution is not None:
                # Backward-compatible v2 cache format: target_id -> coords.
                coords = _route_coords(
                    cached_distribution,
                    f"{distribution_source_label}-{odp_label}",
                )
                distribution_connected = bool(coords)
            elif distribution_segments is None and road_graph and road_feeder:
                path = route_along_road(
                    road_graph, (odc.lat, odc.lon), (odp.lat, odp.lon),
                    route_cache=odp_route_cache,
                )
                if not path:
                    raise RuntimeError(f"Tidak ada koneksi jalan untuk kabel distribusi {odc_label} -> {odp_label}.")
                coords = _route_coords(
                    path,
                    f"{distribution_source_label}-{odp_label}",
                )
            elif distribution_segments is not None:
                logger.warning(
                    "Segmen distribusi %s -> %s tidak ada di metadata routing; kabel dilewati.",
                    odc_label,
                    odp_label,
                )

            # Distribution is a branched network, so keep each physical branch
            # as a LineString inside one MultiGeometry placemark. This gives
            # Google Earth one selectable distribution cable without drawing
            # false lines between unrelated branches.
            if distribution_connected:
                dist_name = f"{distribution_source_label}-{odp_label}"
                source_id = (
                    cached_distribution.get("source_id")
                    if isinstance(cached_distribution, dict)
                    else None
                )
                source_point = device_points.get(source_id)
                if source_point is None:
                    source_point = (odc.lon, odc.lat)
                target_point = device_points.get(odp.id, (odp.lon, odp.lat))
                coords = _normalize_route_endpoints(coords, source_point, target_point)
                if distribution_route is None:
                    distribution_route = fol_dist.newmultigeometry(
                        name="Distribution Route"
                    )
                    distribution_route.style = style_dist
                    _add_extended_data(distribution_route, "Distribution Route")
                dist = distribution_route.newlinestring(name=dist_name, coords=coords)
                dist.style = style_dist
                processed_items += 1
                if processed_items == total_items or processed_items % max(1, total_items // 100) == 0:
                    report_progress(f"Membuat kabel distribusi dan HC ({processed_items}/{total_items})...")

            if not include_homepass:
                total_houses += len(odp.houses)
                continue

            for k, (h_lat, h_lon) in enumerate(odp.houses, start=1):
                total_houses += 1
                hc_label = f"{odp_label}-{k:02d}"

                # -- HC placemark (into flat Assets > HC folder) --
                hc = fol_hc.newpoint(
                    name=hc_label,
                    description=f"Induk ODP: {odp_label}",
                    coords=[(h_lon, h_lat)],
                )
                hc.style = style_house
                _add_extended_data(hc, hc_label)

                drop_coords = [(odp.lon, odp.lat), (h_lon, h_lat)]
                # Drop cable is intentionally a direct visual connection from
                # the ODP/pole to the house. It must not follow the road graph;
                # otherwise one ODP serving up to 10 houses is hard to see.
                if road_graph and road_feeder and road_drop:
                    path = route_along_road(
                        road_graph, (odp.lat, odp.lon), (h_lat, h_lon),
                        route_cache=odp_route_cache,
                    )
                    if not path:
                        raise RuntimeError(f"Tidak ada koneksi jalan untuk kabel drop {odp_label} -> {hc_label}.")
                    drop_coords = _route_coords(path, f"{odp_label} -> {hc_label}")
                drop_coords = _normalize_route_endpoints(
                    drop_coords,
                    start=(odp.lon, odp.lat),
                    end=(h_lon, h_lat),
                )

                # Drop cables form a branched network at the ODP, so group
                # all branches in one placemark just like Distribution Route.
                # Each branch remains its own LineString to avoid drawing
                # false connections between houses.
                drop_name = f"ODP {odp_label} TO HC {hc_label}"
                if drop_route is None:
                    drop_route = fol_drop.newmultigeometry(name="Drop Route")
                    drop_route.style = style_drop
                    drop_route.description = "KABEL DROP ODP KE HC"
                    _add_extended_data(drop_route, "Drop Route")
                drop = drop_route.newlinestring(name=drop_name, coords=drop_coords)
                drop.style = style_drop
                processed_items += 1
                if processed_items == total_items or processed_items % max(1, total_items // 100) == 0:
                    report_progress(f"Membuat kabel distribusi dan HC ({processed_items}/{total_items})...")

    kml.savekmz(output_path)
    icon_directory.cleanup()

    print(f"\nDesain selesai:")
    print(f"  Total rumah   : {total_houses}")
    print(f"  Total ODC     : {len(odcs)}")
    print(f"  Total ODP     : {sum(len(o.odps) for o in odcs)}")
    print(f"  Segmen feeder : {len(feeder_segments)} (POP -> {' -> '.join(s['to_label'] for s in feeder_segments)})")
    print(f"Output disimpan di: {output_path}")
