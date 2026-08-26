import pytest
import os
import struct
import zipfile
import xml.etree.ElementTree as ET
import zlib
from shapely.geometry import Point
from server.services.generator.models import ODC, ODP, Splitter
from server.services.generator.kml_builder import export_kmz, normalize_feature_colors


def _png_pixel(png_bytes, x, y):
    """Read one pixel from the dependency-free RGBA PNG emitted by the exporter."""
    width, height, bit_depth, color_type, _, _, _ = struct.unpack(
        ">IIBBBBB", png_bytes[16:29]
    )
    assert bit_depth == 8 and color_type == 6
    chunks = []
    offset = 8
    while offset < len(png_bytes):
        length = struct.unpack(">I", png_bytes[offset:offset + 4])[0]
        chunk_type = png_bytes[offset + 4:offset + 8]
        payload = png_bytes[offset + 8:offset + 8 + length]
        offset += length + 12
        if chunk_type == b"IDAT":
            chunks.append(payload)
    raw = zlib.decompress(b"".join(chunks))
    stride = width * 4
    row = raw[y * (stride + 1) + 1:y * (stride + 1) + 1 + stride]
    return tuple(row[x * 4:x * 4 + 4])

@pytest.fixture
def sample_data():
    pop = {"name": "POP_1", "lat": -6.2, "lon": 106.8}
    odps = [
        ODP(id="ODP-1", lat=-6.201, lon=106.801, houses=[(-6.2011, 106.8011)], splitter=Splitter("1:8", "ODP")),
    ]
    odcs = [
        ODC(id="ODC-1", lat=-6.202, lon=106.802, odps=odps, closure_id="CL-001", splitter=Splitter("1:4", "ODC"))
    ]
    feeder_segments = [
        {"coords": [(-6.2, 106.8), (-6.202, 106.802)], "from_label": "POP_1", "to_label": "ODC 01"}
    ]
    return pop, odcs, feeder_segments

def test_export_kmz(tmp_path, sample_data):
    pop, odcs, feeder_segments = sample_data
    out_path = tmp_path / "design.kmz"

    export_kmz(pop, odcs, feeder_segments, str(out_path), include_homepass=True, road_graph=None, road_feeder=False)

    assert os.path.exists(out_path)
    with zipfile.ZipFile(str(out_path), "r") as z:
        namelist = z.namelist()
        assert "doc.kml" in namelist

        # Check folders inside KMZ
        doc = z.read("doc.kml").decode("utf-8")
        assert "OLT001" in doc
        assert "ODC001" in doc
        assert "ODC001.ODP001" in doc


def test_export_kmz_uses_distribution_tree_labels(tmp_path):
    pop = {"name": "POP_1", "lat": -6.2, "lon": 106.8}
    odps = [
        ODP(id="ODP-A", lat=-6.201, lon=106.801, houses=[], splitter=Splitter("1:10", "ODP")),
        ODP(id="ODP-B", lat=-6.2015, lon=106.8015, houses=[], splitter=Splitter("1:10", "ODP")),
    ]
    odcs = [ODC(
        id="ODC-1",
        lat=-6.202,
        lon=106.802,
        odps=odps,
        closure_id="CL-001",
        splitter=Splitter("1:4", "ODC"),
    )]
    segments = {
        "ODP-A": {
            "source_id": "ODC-1",
            "target_id": "ODP-A",
            "coords": [[-6.202, 106.802], [-6.201, 106.801]],
            "connected": True,
        },
        "ODP-B": {
            "source_id": "ODP-A",
            "target_id": "ODP-B",
            "coords": [[-6.201, 106.801], [-6.2015, 106.8015]],
            "connected": True,
        },
    }
    output = tmp_path / "tree.kmz"
    export_kmz(
        pop,
        odcs,
        [{"coords": [(pop["lat"], pop["lon"]), (-6.202, 106.802)], "from_label": "POP_1", "to_label": "ODC-1"}],
        str(output),
        distribution_segments=segments,
    )

    with zipfile.ZipFile(str(output), "r") as archive:
        document = archive.read("doc.kml").decode("utf-8")
    assert "ODC001-ODC001.ODP001" in document
    assert "ODC001.ODP001-ODC001.ODP002" in document

    root = ET.fromstring(document)
    namespace = {"kml": "http://www.opengis.net/kml/2.2"}

    def route_coordinates(name):
        placemark = next(
            item for item in root.findall(".//kml:Placemark", namespace)
            if item.findtext("kml:name", namespaces=namespace) == name
        )
        values = placemark.findtext("kml:LineString/kml:coordinates", namespaces=namespace)
        return [tuple(float(value) for value in item.split(",")[:2]) for item in values.split()]

    assert route_coordinates("ODC001-ODC001.ODP001") == [
        (106.802, -6.202), (106.801, -6.201)
    ]
    assert route_coordinates("ODC001.ODP001-ODC001.ODP002") == [
        (106.801, -6.201), (106.8015, -6.2015)
    ]


def test_export_kmz_matches_reference_google_earth_palette(tmp_path, sample_data):
    pop, odcs, feeder_segments = sample_data
    output = tmp_path / "reference-palette.kmz"
    export_kmz(pop, odcs, feeder_segments, str(output))

    with zipfile.ZipFile(str(output), "r") as archive:
        document = archive.read("doc.kml").decode("utf-8")

    root = ET.fromstring(document)
    namespace = {"kml": "http://www.opengis.net/kml/2.2"}
    styles = {
        style.attrib["id"]: style
        for style in root.findall(".//kml:Style", namespace)
    }
    placemark_styles = {}
    for placemark in root.findall(".//kml:Placemark", namespace):
        name = placemark.findtext("kml:name", namespaces=namespace)
        style_url = placemark.findtext("kml:styleUrl", namespaces=namespace)
        if name and style_url:
            placemark_styles[name] = styles[style_url[1:]]

    icon_hrefs = {
        name: placemark_styles[name].findtext(
            "kml:IconStyle/kml:Icon/kml:href", namespaces=namespace
        )
        for name in ("OLT001", "ODC001", "ODC001.ODP001")
    }
    assert icon_hrefs == {
        "OLT001": "http://maps.google.com/mapfiles/kml/shapes/electronics.png",
        "ODC001": "http://maps.google.com/mapfiles/kml/shapes/triangle.png",
        "ODC001.ODP001": "http://maps.google.com/mapfiles/kml/shapes/triangle.png",
    }
    assert placemark_styles["OLT001"].findtext(
        "kml:IconStyle/kml:color", namespaces=namespace
    ) == "ff08b3ea"
    assert placemark_styles["POP_1-ODC 01"].findtext(
        "kml:LineStyle/kml:color", namespaces=namespace
    ) == "ff0000ff"
    assert placemark_styles["POP_1-ODC 01"].findtext(
        "kml:LineStyle/kml:width", namespaces=namespace
    ) == "4"
    assert placemark_styles["ODC001-ODC001.ODP001"].findtext(
        "kml:LineStyle/kml:color", namespaces=namespace
    ) == "ffff00aa"
    assert placemark_styles["ODC001-ODC001.ODP001"].findtext(
        "kml:LineStyle/kml:width", namespaces=namespace
    ) == "4"


def test_export_kmz_uses_configured_feature_colors(tmp_path, sample_data):
    pop, odcs, feeder_segments = sample_data
    output = tmp_path / "custom-colors.kmz"
    colors = {
        "pop": "#123456",
        "odc": "#abcdef",
        "odp": "#fedcba",
        "house": "#010203",
        "feeder": "#112233",
        "distribution": "#445566",
    }

    export_kmz(
        pop,
        odcs,
        feeder_segments,
        str(output),
        include_homepass=True,
        feature_colors=colors,
    )

    with zipfile.ZipFile(str(output), "r") as archive:
        document = archive.read("doc.kml").decode("utf-8")

    # KML stores colors as opaque ABGR, unlike the CSS RRGGBB values used by
    # the web application.
    for kml_color in ("ff030201", "ff332211", "ff665544"):
        assert f"<color>{kml_color}</color>" in document
    assert document.count(
        "http://maps.google.com/mapfiles/kml/shapes/triangle.png"
    ) >= 2

    root = ET.fromstring(document)
    namespace = {"kml": "http://www.opengis.net/kml/2.2"}
    styles = {
        style.attrib["id"]: style
        for style in root.findall(".//kml:Style", namespace)
    }
    line_colors = {}
    line_widths = {}
    icon_hrefs = {}
    icon_colors = {}
    for placemark in root.findall(".//kml:Placemark", namespace):
        name = placemark.findtext("kml:name", namespaces=namespace)
        style_url = placemark.findtext("kml:styleUrl", namespaces=namespace)
        if name and style_url and style_url.startswith("#"):
            style = styles[style_url[1:]]
            line_color = style.findtext("kml:LineStyle/kml:color", namespaces=namespace)
            line_width = style.findtext("kml:LineStyle/kml:width", namespaces=namespace)
            if line_color:
                line_colors[name] = line_color
            if line_width:
                line_widths[name] = line_width
            icon_href = style.findtext(
                "kml:IconStyle/kml:Icon/kml:href", namespaces=namespace
            )
            if icon_href:
                icon_hrefs[name] = icon_href
            icon_color = style.findtext("kml:IconStyle/kml:color", namespaces=namespace)
            if icon_color:
                icon_colors[name] = icon_color

    assert line_colors["POP_1-ODC 01"] == "ff332211"
    assert line_colors["ODC001-ODC001.ODP001"] == "ff665544"
    assert line_colors["ODP ODC001.ODP001 TO HC ODC001.ODP001-01"] == "ff030201"
    assert line_widths["ODP ODC001.ODP001 TO HC ODC001.ODP001-01"] == "3"
    assert icon_hrefs["ODC001"] == "http://maps.google.com/mapfiles/kml/shapes/triangle.png"
    assert icon_hrefs["ODC001.ODP001"] == "http://maps.google.com/mapfiles/kml/shapes/triangle.png"
    assert icon_hrefs["OLT001"] == "http://maps.google.com/mapfiles/kml/shapes/electronics.png"
    assert icon_colors["ODC001"] == "ffefcdab"
    assert icon_colors["ODC001.ODP001"] == "ffbadcfe"
    assert icon_colors["OLT001"] == "ff563412"
    with zipfile.ZipFile(str(output), "r") as archive:
        assert _png_pixel(archive.read("files/ftth-house.png"), 48, 4) == (1, 2, 3, 255)


def test_export_kmz_preserves_configured_colors_for_all_odps(tmp_path):
    pop = {"name": "POP_1", "lat": -6.2, "lon": 106.8}
    odps = [
        ODP(
            id=f"ODC004.ODP00{index}",
            lat=-6.201 - index * 0.0001,
            lon=106.801,
            houses=[],
            splitter=Splitter("1:10", "ODP"),
        )
        for index in range(1, 5)
    ]
    odcs = [ODC(
        id="ODC-1",
        lat=-6.202,
        lon=106.802,
        odps=odps,
        closure_id="CL-001",
        splitter=Splitter("1:4", "ODC"),
    )]
    output = tmp_path / "stale-palette.kmz"
    export_kmz(
        pop,
        odcs,
        [{"coords": [(-6.2, 106.8), (-6.202, 106.802)], "from_label": "POP_1", "to_label": "ODC 01"}],
        str(output),
        feature_colors={
            "feeder": "#eab308",
            "odp": "#10b981",
            "distribution": "#3b82f6",
        },
    )

    assert normalize_feature_colors({"feeder": "#eab308", "odp": "#10b981"})["feeder"] == "#eab308"
    assert normalize_feature_colors({"feeder": "#eab308", "odp": "#10b981"})["odp"] == "#10b981"

    with zipfile.ZipFile(str(output), "r") as archive:
        document = archive.read("doc.kml").decode("utf-8")
    root = ET.fromstring(document)
    namespace = {"kml": "http://www.opengis.net/kml/2.2"}
    styles = {style.attrib["id"]: style for style in root.findall(".//kml:Style", namespace)}

    def style_for(name):
        placemark = next(
            item for item in root.findall(".//kml:Placemark", namespace)
            if item.findtext("kml:name", namespaces=namespace) == name
        )
        return styles[placemark.findtext("kml:styleUrl", namespaces=namespace)[1:]]

    odp_names = [f"ODC004.ODP00{index}" for index in range(1, 5)]
    assert all(name in document for name in odp_names)
    assert all(
        style_for(name).findtext("kml:IconStyle/kml:Icon/kml:href", namespaces=namespace)
        == "http://maps.google.com/mapfiles/kml/shapes/triangle.png"
        for name in odp_names
    )
    assert all(
        style_for(name).findtext("kml:IconStyle/kml:color", namespaces=namespace)
        == "ff81b910"
        for name in odp_names
    )
    assert style_for("POP_1-ODC 01").findtext(
        "kml:LineStyle/kml:color", namespaces=namespace
    ) == "ff08b3ea"
