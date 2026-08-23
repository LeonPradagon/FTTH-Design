import os
import xml.etree.ElementTree as ET
import zipfile
from shapely.geometry import Polygon, Point

KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}

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
    """Membaca file KML custom dan mengkategorikan titik berdasarkan namanya."""
    root = ET.fromstring(_extract_kml_bytes(path))
    points = {'olt': [], 'odc': [], 'odp': [], 'hc': []}
    
    for pm in root.findall(".//kml:Placemark", KML_NS):
        pt_el = pm.find(".//kml:Point/kml:coordinates", KML_NS)
        if pt_el is None:
            continue
            
        lon, lat, *_ = pt_el.text.strip().split(",")
        lat, lon = float(lat), float(lon)
        
        name_el = pm.find("kml:name", KML_NS)
        name = name_el.text.strip().lower() if name_el is not None and name_el.text else ""
        
        pt_data = {"name": name_el.text.strip() if name_el is not None and name_el.text else "Unknown", "lat": lat, "lon": lon}
        
        if "olt" in name or "pop" in name:
            points['olt'].append(pt_data)
        elif "odc" in name:
            points['odc'].append(pt_data)
        elif "odp" in name:
            points['odp'].append(pt_data)
        elif "hc" in name or "rumah" in name:
            points['hc'].append(pt_data)
            
    return points
