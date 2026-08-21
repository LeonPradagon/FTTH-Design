import csv
import math

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000  # radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi/2.0)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(delta_lambda/2.0)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def compute_segment_length(coords):
    total = 0
    for i in range(len(coords) - 1):
        total += haversine(coords[i][0], coords[i][1], coords[i+1][0], coords[i+1][1])
    return total

def export_csv(pop, odcs, feeder_segments, output_path):
    with open(output_path, mode='w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['Tipe', 'Nama', 'Kuantitas/Panjang', 'Satuan', 'Latitude', 'Longitude'])

        writer.writerow(['POP / Server OLT', pop['name'], 1, 'pcs', pop['lat'], pop['lon']])

        for i, odc in enumerate(odcs, start=1):
            odc_name = f"ODC {i:02d}"
            writer.writerow(['ODC', odc_name, 1, 'pcs', odc.lat, odc.lon])
            
            if hasattr(odc, 'closure_id') and odc.closure_id:
                writer.writerow(['Join Closure', f"JOIN CLOSURE {odc_name}", 1, 'pcs', odc.lat, odc.lon])

            for j, odp in enumerate(odc.odps, start=1):
                odp_name = f"{i:02d}/{j:02d}"
                writer.writerow(['ODP', odp_name, 1, 'pcs', odp.lat, odp.lon])
                
                # Jarak estimasi (haversine * 1.2 slack factor)
                dist = haversine(odc.lat, odc.lon, odp.lat, odp.lon) * 1.2
                writer.writerow(['Kabel Distribusi', f"{odc_name} -> {odp_name}", round(dist, 2), 'm', '', ''])
                
                for k, h in enumerate(odp.houses, start=1):
                    house_name = f"{i:02d}/{j:02d}-{k:02d}"
                    writer.writerow(['Homepass (Titik Rumah)', house_name, 1, 'pcs', h[0], h[1]])
                    drop_dist = haversine(odp.lat, odp.lon, h[0], h[1]) * 1.2
                    writer.writerow(['Kabel Drop', f"{odp_name} -> {house_name}", round(drop_dist, 2), 'm', '', ''])
        
        for seg in feeder_segments:
            length = compute_segment_length(seg["coords"])
            writer.writerow(['Kabel Feeder', f"{seg['from_label']} -> {seg['to_label']}", round(length, 2), 'm', '', ''])
