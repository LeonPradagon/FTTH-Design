import xml.etree.ElementTree as ET
import zipfile
from shapely.geometry import Polygon, Point

KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}

def read_boundary_style(path):
    """Membaca gaya (warna, ketebalan garis) dari file boundary KML/KMZ."""
    root = ET.fromstring(_extract_kml_bytes(path))
    pm_el = None
    for pm in root.findall(".//kml:Placemark", KML_NS):
        if pm.find(".//kml:Polygon", KML_NS) is not None:
            pm_el = pm
            break
            
    # Default: biru semi-transparan dengan garis tegas biru
    poly_color = '4dff0000' # 30% alpha, blue
    line_color = 'ffff0000' # 100% alpha, blue
    line_width = 3.0
    
    if pm_el is not None:
        style_el = pm_el.find("kml:Style", KML_NS)
        if style_el is not None:
            p_col = style_el.find("kml:PolyStyle/kml:color", KML_NS)
            if p_col is not None and p_col.text: poly_color = p_col.text.strip()
            l_col = style_el.find("kml:LineStyle/kml:color", KML_NS)
            if l_col is not None and l_col.text: line_color = l_col.text.strip()
            l_wid = style_el.find("kml:LineStyle/kml:width", KML_NS)
            if l_wid is not None and l_wid.text: line_width = float(l_wid.text.strip())
        else:
            style_url_el = pm_el.find("kml:styleUrl", KML_NS)
            if style_url_el is not None and style_url_el.text:
                style_id = style_url_el.text.strip().lstrip("#")
                doc_style = root.find(f".//kml:Style[@id='{style_id}']", KML_NS)
                if doc_style is None:
                    style_map = root.find(f".//kml:StyleMap[@id='{style_id}']", KML_NS)
                    if style_map is not None:
                        pair = style_map.find(".//kml:Pair[kml:key='normal']/kml:styleUrl", KML_NS)
                        if pair is not None and pair.text:
                            normal_id = pair.text.strip().lstrip("#")
                            doc_style = root.find(f".//kml:Style[@id='{normal_id}']", KML_NS)
                
                if doc_style is not None:
                    p_col = doc_style.find(".//kml:PolyStyle/kml:color", KML_NS)
                    if p_col is not None and p_col.text: poly_color = p_col.text.strip()
                    l_col = doc_style.find(".//kml:LineStyle/kml:color", KML_NS)
                    if l_col is not None and l_col.text: line_color = l_col.text.strip()
                    l_wid = doc_style.find(".//kml:LineStyle/kml:width", KML_NS)
                    if l_wid is not None and l_wid.text: line_width = float(l_wid.text.strip())

    return {
        "poly_color": poly_color,
        "line_color": line_color,
        "line_width": line_width
    }

def _extract_kml_bytes(path):
    """Ambil isi file .kml mentah, baik dari file .kml langsung maupun dari
    dalam arsip .kmz (kmz = kml yang di-zip)."""
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


def check_has_pop_point(path):
    """Mengecek apakah file KML memiliki Placemark berupa Point (POP/OLT)."""
    try:
        points = read_points(path)
        if points:
            # Cari jika ada yang namanya mengandung POP/OLT
            for pt in points:
                if "pop" in pt["name"].lower() or "olt" in pt["name"].lower():
                    return True, pt
            # Jika tidak ada yang spesifik, gunakan titik pertama
            return True, points[0]
    except ValueError:
        pass
    return False, None
