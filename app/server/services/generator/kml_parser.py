import os
import re
import xml.etree.ElementTree as ET
import zipfile
from shapely.geometry import Polygon, Point

KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}


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


def read_boundary(path):
    """Baca Polygon pertama dari file boundary KML/KMZ -> shapely Polygon."""
    root = ET.fromstring(_extract_kml_bytes(path))
    poly_el = root.find(".//kml:Polygon//kml:coordinates", KML_NS)
    if poly_el is None:
        raise ValueError(f"Tidak ditemukan elemen <Polygon> di {path}. "
                          f"Pastikan boundary digambar sebagai Polygon, bukan LineString.")
    coords = []
    for pair in poly_el.text.strip().split():
        lon, lat, *_ = pair.split(",")
        coords.append((float(lon), float(lat)))
    return Polygon(coords)


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
        if "pop" not in folder_name and "olt" not in folder_name:
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
        if "pop" not in searchable_text and "olt" not in searchable_text:
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
        inside = [(lat, lon) for lat, lon in houses if boundary.contains(Point(lon, lat))]
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
        if re.search(r"(?<![A-Z0-9])ODC(?![A-Z0-9])", text, re.IGNORECASE):
            return "odc"
        if re.search(r"(?<![A-Z0-9])ODP(?![A-Z0-9])", text, re.IGNORECASE):
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

        # A compact name such as ``17/01`` is an ODP even when its
        # description mentions its parent ODC. Prefer that unambiguous form
        # before scanning description text.
        if re.fullmatch(r"\s*\d+\s*/\s*\d+\s*", display_name):
            role = "odp"
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
