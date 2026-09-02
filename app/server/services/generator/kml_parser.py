import os
import re
import copy
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from shapely.geometry import Polygon, Point
from shapely.ops import unary_union

KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}
KML_NAMESPACE = KML_NS["kml"]
POP_MARKER_RE = re.compile(
    r"(?<![A-Z0-9])(?:POP|OLT|SENTRAL|RBS)(?:\s*[-_ ]?\s*\d+)?(?![A-Z0-9])",
    re.IGNORECASE,
)


def _mapping_group_key(name, kind):
    """Extract an explicit ODC/ODP group number from a mapping name.

    Supported examples are ``ODC 17``, ``ODC-17``, and ``ODP 17/01``. The
    shared group key lets custom mapping preserve the user's intended parent
    ODC instead of guessing from geographic proximity.
    """
    normalized = str(name or "").strip().upper()
    if kind == "odc":
        match = re.search(r"(?<![A-Z0-9])ODC\s*[-_ ]?\s*(\d+)\b", normalized)
    else:
        # Reference exports use names such as ``ODC004.ODP003``. The ODC
        # number is the parent group; the ODP number is only the child index.
        odc_match = re.search(
            r"(?<![A-Z0-9])ODC\s*[-_ ]?\s*(\d+)\b", normalized
        )
        if odc_match:
            return odc_match.group(1)
        match = re.search(r"(?<![A-Z0-9])ODP\s*[-_ ]?\s*(\d+)\s*/\s*\d+\b", normalized)
        if not match:
            # Compact ODP names such as ``17/01`` commonly live in an
            # ``ODC 17`` folder or carry that parent in description.
            match = re.search(r"(?<![A-Z0-9])ODC\s*[-_ ]?\s*(\d+)\b", normalized)
    return match.group(1) if match else None

def _extract_kml_bytes(path):
    """Ambil isi file .kml mentah, baik dari file .kml langsung maupun dari
    dalam arsip .kmz (kmz = kml yang di-zip)."""
    # API penyimpanan per akun menggunakan pathlib.Path, sedangkan pemanggil
    # lama masih menggunakan string. Normalisasi keduanya di satu tempat.
    path = os.fspath(path)
    if path.lower().endswith(".kmz"):
        with zipfile.ZipFile(path, "r") as z:
            kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not kml_name:
                raise ValueError(f"Tidak ditemukan file .kml di dalam arsip: {path}")
            return z.read(kml_name)
    with open(path, "rb") as f:
        return f.read()


def _polygon_from_element(polygon_el):
    outer_el = polygon_el.find(
        "kml:outerBoundaryIs/kml:LinearRing/kml:coordinates", KML_NS
    )
    if outer_el is None or not outer_el.text:
        return None

    def parse_ring(ring_el):
        return [
            tuple(float(value) for value in pair.split(",")[:2])
            for pair in ring_el.text.strip().split()
        ]

    outer = parse_ring(outer_el)
    holes = []
    for inner_el in polygon_el.findall(
        "kml:innerBoundaryIs/kml:LinearRing/kml:coordinates", KML_NS
    ):
        if inner_el.text:
            holes.append(parse_ring(inner_el))
    polygon = Polygon(outer, holes)
    if not polygon.is_valid:
        polygon = polygon.buffer(0)
    return polygon if not polygon.is_empty else None


def read_boundary_geometry(path):
    """Read and union every Polygon in a KML/KMZ into one geometry.

    Disconnected service areas intentionally remain a ``MultiPolygon``. The
    generator can query, cluster, route, and export one design for that
    geometry; it must not silently discard all but the first area.
    """
    root = ET.fromstring(_extract_kml_bytes(path))
    polygons = [
        polygon
        for polygon_el in root.findall(".//kml:Polygon", KML_NS)
        if (polygon := _polygon_from_element(polygon_el)) is not None
    ]
    if not polygons:
        raise ValueError(f"Tidak ditemukan elemen <Polygon> di {path}. "
                          f"Pastikan boundary digambar sebagai Polygon, bukan LineString.")
    boundary = unary_union(polygons)
    if not boundary.is_valid:
        repaired = boundary.buffer(0)
        if repaired.is_empty:
            raise ValueError(f"Boundary pada {path} tidak valid dan tidak dapat diperbaiki.")
        boundary = repaired
    return boundary


def read_boundary(path):
    """Read all boundary polygons, preserving disconnected areas."""
    return read_boundary_geometry(path)


def count_boundary_polygons(path):
    """Count all Polygon geometries in a KML/KMZ input."""
    root = ET.fromstring(_extract_kml_bytes(path))
    return len(root.findall(".//kml:Polygon", KML_NS))


def read_points(path):
    """Baca semua Placemark berupa Point dari file KML/KMZ."""
    root = ET.fromstring(_extract_kml_bytes(path))
    points = []
    for pm in root.findall(".//kml:Placemark", KML_NS):
        pt_el = pm.find(".//kml:Point/kml:coordinates", KML_NS)
        if pt_el is None:
            continue
        lon, lat, *_ = pt_el.text.strip().split(",")
        name_el = pm.find("kml:name", KML_NS)
        name = name_el.text.strip() if name_el is not None and name_el.text else "POP"
        points.append({"name": name, "lon": float(lon), "lat": float(lat)})
    if not points:
        raise ValueError(f"Tidak ditemukan Placemark berupa Point di {path}.")
    return points


def _new_kml_document():
    root = ET.Element(f"{{{KML_NAMESPACE}}}kml")
    return root, ET.SubElement(root, f"{{{KML_NAMESPACE}}}Document")


def _placemark_name(placemark, fallback):
    name_el = placemark.find("kml:name", KML_NS)
    return name_el.text.strip() if name_el is not None and name_el.text else fallback


def split_boundary_file(path, output_dir):
    """Split every boundary Polygon in a KML/KMZ into its own KML file.

    The generator operates on one boundary per job. Keeping the split at the
    input boundary makes the existing batch pipeline reusable and avoids
    accidentally merging disconnected service areas into one design. Some
    exporters put each Polygon in its own Placemark while others put several
    Polygons inside one MultiGeometry, so the split must happen at Polygon
    level rather than Placemark level.
    """
    root = ET.fromstring(_extract_kml_bytes(path))
    polygon_entries = []
    for placemark in root.findall(".//kml:Placemark", KML_NS):
        polygons = placemark.findall(".//kml:Polygon", KML_NS)
        for polygon_index, polygon in enumerate(polygons, start=1):
            polygon_entries.append((placemark, polygon, polygon_index, len(polygons)))
    if not polygon_entries:
        raise ValueError(f"Tidak ditemukan Placemark berupa Polygon di {path}.")
    if len(polygon_entries) == 1:
        placemark, _, _, _ = polygon_entries[0]
        return [(_placemark_name(placemark, "boundary"), Path(path))]

    destination_dir = Path(output_dir)
    destination_dir.mkdir(parents=True, exist_ok=True)
    parts = []
    for index, (placemark, _, polygon_index, polygons_in_placemark) in enumerate(
        polygon_entries, start=1
    ):
        placemark_copy = copy.deepcopy(placemark)
        copied_polygons = placemark_copy.findall(".//kml:Polygon", KML_NS)
        selected_polygon = copied_polygons[polygon_index - 1]
        for parent in placemark_copy.iter():
            for child in list(parent):
                if child.tag == selected_polygon.tag and child is not selected_polygon:
                    parent.remove(child)

        base_name = _placemark_name(placemark, f"boundary_{index}")
        name = (
            f"{base_name}_{polygon_index}"
            if polygons_in_placemark > 1
            else base_name
        )
        destination = destination_dir / f"boundary_{index:03d}.kml"
        root_part, document = _new_kml_document()
        document.append(placemark_copy)
        ET.ElementTree(root_part).write(
            destination,
            encoding="utf-8",
            xml_declaration=True,
        )
        parts.append((name, destination))
    return parts


def merge_boundary_files(paths, destination):
    """Create one KML containing every Polygon from multiple boundary files."""
    root, document = _new_kml_document()
    for path in paths:
        source_root = ET.fromstring(_extract_kml_bytes(path))
        for placemark in source_root.findall(".//kml:Placemark", KML_NS):
            if placemark.find(".//kml:Polygon", KML_NS) is not None:
                document.append(copy.deepcopy(placemark))
    if not list(document):
        raise ValueError("Tidak ditemukan Polygon pada file boundary.")
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(root).write(destination, encoding="utf-8", xml_declaration=True)
    return destination


def write_points_file(path, destination, pop_only=False):
    """Write Point placemarks from a KML/KMZ into a standalone KML."""
    root = ET.fromstring(_extract_kml_bytes(path))
    point_entries = []

    def walk(element, folders=()):
        tag = element.tag.rsplit("}", 1)[-1]
        current_folders = folders
        if tag == "Folder":
            current_folders = folders + (
                _placemark_name(element, ""),
            )
        if tag == "Placemark" and element.find(".//kml:Point", KML_NS) is not None:
            name = _placemark_name(element, "")
            description = element.findtext("kml:description", default="", namespaces=KML_NS)
            folder_text = " ".join(folder for folder in current_folders if folder)
            point_entries.append((element, f"{name} {description or ''} {folder_text}"))
        for child in element:
            walk(child, current_folders)

    walk(root)
    if pop_only:
        point_entries = [
            (placemark, text)
            for placemark, text in point_entries
            if POP_MARKER_RE.search(text)
        ]
    point_placemarks = [placemark for placemark, _ in point_entries]
    if not point_placemarks:
        raise ValueError(f"Tidak ditemukan Placemark berupa Point di {path}.")

    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    root_points, document = _new_kml_document()
    for placemark in point_placemarks:
        document.append(copy.deepcopy(placemark))
    ET.ElementTree(root_points).write(
        destination,
        encoding="utf-8",
        xml_declaration=True,
    )
    return destination


def _point_from_placemark(placemark):
    point_el = placemark.find(".//kml:Point/kml:coordinates", KML_NS)
    if point_el is None or not point_el.text:
        return None
    lon, lat, *_ = point_el.text.strip().split(",")
    name_el = placemark.find("kml:name", KML_NS)
    name = name_el.text.strip() if name_el is not None and name_el.text else "POP"
    return {"name": name, "lon": float(lon), "lat": float(lat)}


def read_pop_point(path):
    """Return POP/OLT from a combined KML/KMZ, or ``None`` when absent.

    Folder context is checked first because exported POP placemarks often use
    a location name (for example ``Waru``) rather than the literal word POP.
    """
    root = ET.fromstring(_extract_kml_bytes(path))

    for folder in root.findall(".//kml:Folder", KML_NS):
        folder_name_el = folder.find("kml:name", KML_NS)
        folder_name = (
            folder_name_el.text.strip().lower()
            if folder_name_el is not None and folder_name_el.text
            else ""
        )
        if not POP_MARKER_RE.search(folder_name):
            continue
        for placemark in folder.findall(".//kml:Placemark", KML_NS):
            point = _point_from_placemark(placemark)
            if point:
                return point

    for placemark in root.findall(".//kml:Placemark", KML_NS):
        name_el = placemark.find("kml:name", KML_NS)
        description_el = placemark.find("kml:description", KML_NS)
        searchable_text = " ".join(
            text.strip().lower()
            for text in (
                name_el.text if name_el is not None else None,
                description_el.text if description_el is not None else None,
            )
            if text
        )
        if not POP_MARKER_RE.search(searchable_text):
            continue
        point = _point_from_placemark(placemark)
        if point:
            return point

    return None


def read_houses_from_file(path, boundary=None):
    """Baca titik rumah manual (hasil digitasi sendiri di Google Earth/dsb)
    dari file KML/KMZ berisi banyak Placemark Point. Lebih reliable daripada
    OSM untuk area yang datanya belum lengkap. Jika `boundary` diberikan,
    titik di luar boundary akan dibuang (dengan peringatan)."""
    pts = read_points(path)
    houses = [(p["lat"], p["lon"]) for p in pts]
    if boundary is not None:
        inside = [(lat, lon) for lat, lon in houses if boundary.covers(Point(lon, lat))]
        dropped = len(houses) - len(inside)
        if dropped:
            print(f"  Peringatan: {dropped} titik rumah di luar boundary, diabaikan.")
        houses = inside
    print(f"Memakai {len(houses)} titik rumah dari file manual: {path}")
    return houses


def read_custom_mapped_kml(path):
    """Membaca file KML custom dan mengkategorikan titik secara konsisten.

    Export KML dari Google Earth sering menyimpan peran titik di nama Folder
    atau description, bukan di nama Placemark. Parser lama hanya melihat nama
    Placemark sehingga POP/OLT tidak ditemukan walaupun sebenarnya ada di
    file. Semua sumber teks tersebut sekarang dipakai untuk klasifikasi.
    """
    root = ET.fromstring(_extract_kml_bytes(path))
    points = {'olt': [], 'odc': [], 'odp': [], 'hc': []}

    def walk_placemarks(element, folders=()):
        tag = element.tag.rsplit("}", 1)[-1]
        current_folders = folders
        if tag == "Folder":
            folder_name_el = element.find("kml:name", KML_NS)
            folder_name = (
                folder_name_el.text.strip()
                if folder_name_el is not None and folder_name_el.text
                else ""
            )
            current_folders = folders + (folder_name,)
        if tag == "Placemark":
            yield element, current_folders
        for child in element:
            yield from walk_placemarks(child, current_folders)

    def role_from_text(text):
        text = str(text or "")
        if re.search(r"(?<![A-Z0-9])(?:OLT|POP)(?![A-Z0-9])", text, re.IGNORECASE):
            return "olt"
        if re.search(r"(?<![A-Z0-9])ODC(?:\s*[-_ ]?\s*\d+)?", text, re.IGNORECASE):
            return "odc"
        if re.search(r"(?<![A-Z0-9])ODP(?:\s*[-_ ]?\s*\d+)?", text, re.IGNORECASE):
            return "odp"
        if re.search(r"(?<![A-Z0-9])(?:HC|RUMAH|HOME\s*PASS)(?![A-Z0-9])", text, re.IGNORECASE):
            return "hc"
        return None

    for pm, folders in walk_placemarks(root):
        pt_el = pm.find(".//kml:Point/kml:coordinates", KML_NS)
        if pt_el is None:
            continue

        lon, lat, *_ = pt_el.text.strip().split(",")
        lat, lon = float(lat), float(lon)

        name_el = pm.find("kml:name", KML_NS)
        display_name = name_el.text.strip() if name_el is not None and name_el.text else "Unknown"
        description_el = pm.find("kml:description", KML_NS)
        description = description_el.text.strip() if description_el is not None and description_el.text else ""
        folder_text = " ".join(folder for folder in folders if folder)
        pt_data = {"name": display_name, "lat": lat, "lon": lon}

        # ODP identifiers from the reference KMZ can be compound, for
        # example ``ODC004.ODP003``. Check ODP in the placemark name before
        # ODC; otherwise the shared ODC prefix misclassifies the point.
        if (
            re.fullmatch(r"\s*\d+\s*/\s*\d+\s*", display_name)
            or re.search(r"(?<![A-Z0-9])ODP", display_name, re.IGNORECASE)
        ):
            role = "odp"
        elif re.search(r"(?<![A-Z0-9])ODC", display_name, re.IGNORECASE):
            role = "odc"
        else:
            # Prefer the Placemark name/description. Folder context is the
            # fallback because a folder may contain different point types.
            role = role_from_text(f"{display_name} {description}")
        if role is None:
            role = role_from_text(folder_text)

        mapping_text = " ".join((display_name, description, folder_text))
        if role == "olt":
            points['olt'].append(pt_data)
        elif role == "odc":
            pt_data["mapping_group"] = _mapping_group_key(mapping_text, "odc")
            points['odc'].append(pt_data)
        elif role == "odp":
            pt_data["mapping_group"] = _mapping_group_key(mapping_text, "odp")
            points['odp'].append(pt_data)
        elif role == "hc":
            points['hc'].append(pt_data)

    return points
