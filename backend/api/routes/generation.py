from fastapi import APIRouter, HTTPException, UploadFile, File
import os
import zipfile
import time
import shutil
import asyncio
import glob
from typing import Optional
from backend.core.logging import logger

from backend.services.generator.core_logic import regenerate_cables_only, generate_cables_from_custom_points
from backend.services.generator.kml_parser import read_boundary, read_points, read_houses_from_file
from backend.services.generator.osm_local import fetch_houses_in_boundary, fetch_road_graph
from backend.services.generator.clustering import build_design
from backend.services.generator.routing import build_feeder_chain, enforce_min_distance_between_odcs
from backend.services.generator.core_logic import save_design_state
from backend.services.generator.kml_builder import export_kmz
from backend.services.generator.csv_exporter import export_csv
import math

router = APIRouter()

def cleanup_old_files(directory="dashboard/public/data", max_age_seconds=3600):
    """Hapus file generate yang lebih lama dari max_age_seconds (default 1 jam)"""
    try:
        if not os.path.exists(directory):
            return
        
        now = time.time()
        for ext in ["*.kml", "*.kmz", "*.csv"]:
            for f in glob.glob(os.path.join(directory, ext)):
                if os.path.isfile(f) and now - os.path.getmtime(f) > max_age_seconds:
                    try:
                        os.remove(f)
                    except Exception:
                        pass
    except Exception as e:
        logger.warning(f"Error during cleanup: {e}")

from shapely.geometry import Point

def haversine_dist(lon1, lat1, lon2, lat2):
    """Hitung jarak (dalam meter) antara dua titik koordinat."""
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2)**2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))

# Helper for the main generation logic
def _run_generator_logic(boundary_path, pop_path, output_kmz, output_csv=None, has_custom_pop=False):
    boundary = read_boundary(boundary_path)
    
    if has_custom_pop:
        pop_points = read_points(pop_path)
        pop = pop_points[0]
        # Validasi Jarak jika POP custom di-upload
        dist = haversine_dist(boundary.centroid.x, boundary.centroid.y, pop["lon"], pop["lat"])
        if dist > 3000: # 3 km
            raise ValueError("POP (Sentral) terlalu jauh dari area perancangan (> 3 km). Hal ini dapat membebani server saat meroute jalan. Harap letakkan POP lebih dekat dengan area boundary.")
    else:
        # Jika tidak ada POP yang di-upload, otomatis buat POP di lokasi strategis
        from backend.services.generator.osm_local import find_strategic_pop
        pop = find_strategic_pop(boundary)
        logger.info(f"Auto-generated POP at {pop['lon']}, {pop['lat']} (Location: {pop['name']})")
    
    houses = fetch_houses_in_boundary(boundary)
    if not houses:
        raise ValueError("Tidak ada rumah yang ditemukan di OpenStreetMap untuk area ini.")
        
    road_graph = None
    try:
        road_graph = fetch_road_graph(boundary, pop)
    except Exception as e:
        logger.warning(f"Gagal mengambil data jalan ({e}). Feeder akan pakai garis lurus.")
        
    odcs = build_design(houses=houses, odp_capacity=8, odc_capacity=4, road_graph=road_graph)
    enforce_min_distance_between_odcs(odcs, min_dist_m=40.0)
    feeder_segments, odcs = build_feeder_chain(pop, odcs, road_graph=road_graph)
    
    try:
        save_design_state(pop, odcs, road_graph=road_graph)
    except Exception as e:
        logger.warning(f"Gagal menyimpan design state ({e})")
        
    export_kmz(pop, odcs, feeder_segments, output_kmz, include_homepass=True, road_graph=road_graph, road_feeder=True)
    if output_csv:
        try:
            export_csv(pop, odcs, feeder_segments, output_csv)
        except Exception as e:
            logger.warning(f"Gagal generate CSV ({e})")


@router.post("/generate")
async def generate_design(
    boundaryFile: Optional[UploadFile] = File(None),
    popFile: Optional[UploadFile] = File(None)
):
    # Bersihkan file lama setiap kali request baru
    cleanup_old_files()
    
    boundary_path = "boundary.kml"
    pop_path = "POP.kml"
    has_custom_pop = False

    if boundaryFile and boundaryFile.filename:
        os.makedirs("dashboard/public/data", exist_ok=True)
        boundary_path = f"dashboard/public/data/custom_boundary_{int(time.time())}.kml"
        with open(boundary_path, "wb") as buffer:
            shutil.copyfileobj(boundaryFile.file, buffer)

    if popFile and popFile.filename:
        os.makedirs("dashboard/public/data", exist_ok=True)
        pop_path = f"dashboard/public/data/custom_pop_{int(time.time())}.kml"
        with open(pop_path, "wb") as buffer:
            shutil.copyfileobj(popFile.file, buffer)
        has_custom_pop = True
    
    if not os.path.exists(boundary_path):
        raise HTTPException(status_code=404, detail=f"Boundary file not found: {boundary_path}")
    if has_custom_pop and not os.path.exists(pop_path):
        raise HTTPException(status_code=404, detail=f"POP file not found: {pop_path}")

    timestamp = int(time.time())
    output_kmz_name = f"design_ftth_{timestamp}.kmz"
    output_kmz_path = f"dashboard/public/data/{output_kmz_name}"
    output_kml = f"dashboard/public/data/design_ftth_{timestamp}.kml"
    output_csv_name = f"design_ftth_{timestamp}.csv"
    output_csv_path = f"dashboard/public/data/{output_csv_name}"

    try:
        # Run generator in a thread to avoid blocking the event loop
        logger.info(f"Running FTTH generation: boundary={boundary_path}, pop={pop_path}, output={output_kmz_path}")
        await asyncio.to_thread(_run_generator_logic, boundary_path, pop_path, output_kmz_path, output_csv_path, has_custom_pop)

        if not os.path.exists(output_kmz_path):
            raise HTTPException(status_code=500, detail="Script ran successfully but KMZ output not found.")

        with zipfile.ZipFile(output_kmz_path, 'r') as z:
            kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not kml_name:
                raise HTTPException(status_code=500, detail="No KML found inside generated KMZ")
            
            kml_content = z.read(kml_name)
            os.makedirs("dashboard/public/data", exist_ok=True)
            with open(output_kml, "wb") as f:
                f.write(kml_content)

        # Do not delete KMZ so user can download it
        return {
            "status": "success", 
            "message": "FTTH design generated successfully", 
            "url": f"/data/design_ftth_{timestamp}.kml",
            "kmz_url": f"/data/{output_kmz_name}",
            "csv_url": f"/data/{output_csv_name}"
        }

    except ValueError as e:
        logger.warning(f"Validation error during generation: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Exception during generation")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/regenerate-cables")
async def regenerate_cables():
    cleanup_old_files()
    timestamp = int(time.time())
    output_kmz_name = f"design_ftth_regen_{timestamp}.kmz"
    output_kmz_path = f"dashboard/public/data/{output_kmz_name}"
    output_kml = f"dashboard/public/data/design_ftth_regen_{timestamp}.kml"
    output_csv_name = f"design_ftth_regen_{timestamp}.csv"
    output_csv_path = f"dashboard/public/data/{output_csv_name}"

    try:
        logger.info(f"Starting regenerate_cables_only -> {output_kmz_path}")
        await asyncio.to_thread(regenerate_cables_only, output_path=output_kmz_path, include_homepass=True, output_csv=output_csv_path)

        if not os.path.exists(output_kmz_path):
            raise HTTPException(status_code=500, detail="Regenerate succeeded but KMZ output not found.")

        with zipfile.ZipFile(output_kmz_path, 'r') as z:
            kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not kml_name:
                raise HTTPException(status_code=500, detail="No KML found inside regenerated KMZ")

            kml_content = z.read(kml_name)
            os.makedirs("dashboard/public/data", exist_ok=True)
            with open(output_kml, "wb") as f:
                f.write(kml_content)

        return {
            "status": "success", 
            "message": "Kabel berhasil di-regenerate", 
            "url": f"/data/design_ftth_regen_{timestamp}.kml",
            "kmz_url": f"/data/{output_kmz_name}",
            "csv_url": f"/data/{output_csv_name}"
        }

    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("Exception during cable regeneration")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/generate-custom")
async def generate_custom(
    customFile: UploadFile = File(...)
):
    timestamp = int(time.time())
    custom_path = f"dashboard/public/data/custom_mapping_{timestamp}.kml"
    output_kmz_name = f"design_ftth_custom_{timestamp}.kmz"
    output_kmz_path = f"dashboard/public/data/{output_kmz_name}"
    output_kml = f"dashboard/public/data/design_ftth_{timestamp}.kml"
    output_csv_name = f"design_ftth_custom_{timestamp}.csv"
    output_csv_path = f"dashboard/public/data/{output_csv_name}"

    os.makedirs("dashboard/public/data", exist_ok=True)
    with open(custom_path, "wb") as buffer:
        shutil.copyfileobj(customFile.file, buffer)

    try:
        await asyncio.to_thread(generate_cables_from_custom_points, file_path=custom_path, output_path=output_kmz_path, include_homepass=True, output_csv=output_csv_path)

        if not os.path.exists(output_kmz_path):
            raise HTTPException(status_code=500, detail="Generate succeeded but KMZ output not found.")

        with zipfile.ZipFile(output_kmz_path, 'r') as z:
            kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not kml_name:
                raise HTTPException(status_code=500, detail="No KML found inside regenerated KMZ")

            kml_content = z.read(kml_name)
            with open(output_kml, "wb") as f:
                f.write(kml_content)

        return {
            "status": "success", 
            "message": "Jalur kabel berhasil dibuat dari custom mapping KML.", 
            "url": f"/data/design_ftth_{timestamp}.kml",
            "kmz_url": f"/data/{output_kmz_name}",
            "csv_url": f"/data/{output_csv_name}"
        }

    except ValueError as e:
        logger.warning(f"Validation error during generation: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Exception during custom cable generation")
        raise HTTPException(status_code=500, detail=str(e))
