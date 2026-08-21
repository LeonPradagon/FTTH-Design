import math

def haversine_m(lat1, lon1, lat2, lon2):
    """Jarak permukaan bumi (meter) antara dua titik (lat, lon), rumus haversine."""
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def bearing_between(lat1, lon1, lat2, lon2):
    """Bearing awal (derajat, 0=utara) dari titik 1 ke titik 2."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlmb = math.radians(lon2 - lon1)
    x = math.sin(dlmb) * math.cos(phi2)
    y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlmb)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def offset_latlon(lat, lon, distance_m, bearing_deg):
    """Hitung titik (lat, lon) baru yang berjarak `distance_m` meter dari
    titik asal, ke arah `bearing_deg` derajat (0=utara, 90=timur, dst).
    Ini offset GEOMETRIS MURNI (garis lurus, tidak mengikuti jalan) --
    dipakai sebagai fallback kalau road_graph tidak tersedia/gagal."""
    R = 6371000.0  # radius bumi (meter)
    brg = math.radians(bearing_deg)
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)
    ang = distance_m / R

    lat2 = math.asin(math.sin(lat1) * math.cos(ang) + math.cos(lat1) * math.sin(ang) * math.cos(brg))
    lon2 = lon1 + math.atan2(
        math.sin(brg) * math.sin(ang) * math.cos(lat1),
        math.cos(ang) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), math.degrees(lon2)
