from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
import os
import zipfile
import time
import shutil
import asyncio
import glob
import mimetypes
from typing import Optional
from backend.core.logging import logger
from backend.api.deps import get_current_user
from backend.services.user_storage import (
    create_user_filename,
    get_user_cache_dir,
    get_user_storage_dir,
    resolve_user_file,
    user_file_url,
)

from backend.services.generator.core_logic import regenerate_cables_only, generate_cables_from_custom_points
from backend.services.generator.kml_parser import read_boundary, read_points, read_pop_point, read_houses_from_file
from backend.services.generator.osm_local import fetch_houses_in_boundary, fetch_road_graph
from backend.services.generator.clustering import build_design
from backend.services.generator.routing import (
    build_feeder_chain,
    enforce_min_distance_between_odcs,
    enforce_min_distance_between_odcs_on_road,
)
from backend.services.generator.core_logic import save_design_state
from backend.services.generator.kml_builder import export_kmz
from backend.services.generator.csv_exporter import export_csv
import math

router = APIRouter()

def cleanup_old_files(directory, max_age_seconds=3600):
    """Hapus input sementara lama tanpa menghapus hasil milik akun."""
    try:
        if not os.path.exists(directory):
            return
        
        now = time.time()
        for pattern in ["boundary_*.kml", "pop_*.kml", "custom_mapping_*.kml"]:
            for f in glob.glob(os.path.join(directory, pattern)):
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
def _run_generator_logic(boundary_path, pop_path, output_kmz, output_csv=None, has_custom_pop=False, cache_dir=None):
    boundary = read_boundary(boundary_path)
    
    if has_custom_pop:
        pop_points = read_points(pop_path)
        pop = pop_points[0]
        # Validasi Jarak jika POP custom di-upload
        dist = haversine_dist(boundary.centroid.x, boundary.centroid.y, pop["lon"], pop["lat"])
        if dist > 3000: # 3 km
            raise ValueError("POP (Sentral) terlalu jauh dari area perancangan (> 3 km). Hal ini dapat membebani server saat meroute jalan. Harap letakkan POP lebih dekat dengan area boundary.")
    else:
        pop = read_pop_point(boundary_path)

    if pop is None:
        # Jika tidak ada POP yang di-upload, otomatis buat POP di lokasi strategis
        from backend.services.generator.osm_local import find_strategic_pop
        pop = find_strategic_pop(boundary)
        logger.info(f"Auto-generated POP at {pop['lon']}, {pop['lat']} (Location: {pop['name']})")
    else:
        logger.info(f"Using uploaded/existing POP at {pop['lon']}, {pop['lat']} (Location: {pop['name']})")
    
    houses = fetch_houses_in_boundary(boundary)
    if not houses:
        raise ValueError("Tidak ada rumah yang ditemukan di OpenStreetMap untuk area ini.")
        
    road_graph = None
    try:
        road_graph = fetch_road_graph(boundary, pop)
    except Exception as e:
        raise RuntimeError(
            f"Gagal mengambil jaringan jalan OSM ({e}). Generate dihentikan agar kabel tidak memotong rel atau sungai."
        ) from e

    odcs = build_design(houses=houses, odp_capacity=8, odc_capacity=4, road_graph=road_graph)
    if road_graph is not None:
        enforce_min_distance_between_odcs_on_road(road_graph, odcs, min_dist_m=40.0)
    else:
        enforce_min_distance_between_odcs(odcs, min_dist_m=40.0)
    feeder_segments, odcs = build_feeder_chain(pop, odcs, road_graph=road_graph)
    
    try:
        save_design_state(pop, odcs, road_graph=road_graph, cache_dir=cache_dir)
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
    popFile: Optional[UploadFile] = File(None),
    current_user: dict = Depends(get_current_user),
):
    user_dir = get_user_storage_dir(current_user["id"])
    cache_dir = get_user_cache_dir(current_user["id"])
    cleanup_old_files(user_dir)

    if not boundaryFile or not boundaryFile.filename:
        raise HTTPException(status_code=400, detail="Boundary KML/KMZ wajib diunggah.")

    boundary_path = user_dir / create_user_filename("boundary", "kml")
    pop_path = None
    has_custom_pop = False

    with open(boundary_path, "wb") as buffer:
        shutil.copyfileobj(boundaryFile.file, buffer)

    if popFile and popFile.filename:
        pop_path = user_dir / create_user_filename("pop", "kml")
        with open(pop_path, "wb") as buffer:
            shutil.copyfileobj(popFile.file, buffer)
        has_custom_pop = True
    
    if not os.path.exists(boundary_path):
        raise HTTPException(status_code=404, detail=f"Boundary file not found: {boundary_path}")
    if has_custom_pop and not os.path.exists(pop_path):
        raise HTTPException(status_code=404, detail=f"POP file not found: {pop_path}")

    output_kmz_name = create_user_filename("design_ftth", "kmz")
    output_kml_name = create_user_filename("design_ftth", "kml")
    output_csv_name = create_user_filename("design_ftth", "csv")
    output_kmz_path = user_dir / output_kmz_name
    output_kml = user_dir / output_kml_name
    output_csv_path = user_dir / output_csv_name

    try:
        # Run generator in a thread to avoid blocking the event loop
        logger.info(f"Running FTTH generation: boundary={boundary_path}, pop={pop_path}, output={output_kmz_path}")
        await asyncio.to_thread(
            _run_generator_logic,
            boundary_path,
            pop_path,
            output_kmz_path,
            output_csv_path,
            has_custom_pop,
            cache_dir,
        )

        if not os.path.exists(output_kmz_path):
            raise HTTPException(status_code=500, detail="Script ran successfully but KMZ output not found.")

        with zipfile.ZipFile(output_kmz_path, 'r') as z:
            kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not kml_name:
                raise HTTPException(status_code=500, detail="No KML found inside generated KMZ")
            
            kml_content = z.read(kml_name)
            with open(output_kml, "wb") as f:
                f.write(kml_content)

        # Do not delete KMZ so user can download it
        return {
            "status": "success", 
            "message": "FTTH design generated successfully", 
            "url": user_file_url(output_kml_name),
            "kmz_url": user_file_url(output_kmz_name),
            "csv_url": user_file_url(output_csv_name),
        }

    except ValueError as e:
        logger.warning(f"Validation error during generation: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Exception during generation")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/regenerate-cables")
async def regenerate_cables(current_user: dict = Depends(get_current_user)):
    user_dir = get_user_storage_dir(current_user["id"])
    cache_dir = get_user_cache_dir(current_user["id"])
    cleanup_old_files(user_dir)
    output_kmz_name = create_user_filename("design_ftth_regen", "kmz")
    output_kml_name = create_user_filename("design_ftth_regen", "kml")
    output_csv_name = create_user_filename("design_ftth_regen", "csv")
    output_kmz_path = user_dir / output_kmz_name
    output_kml = user_dir / output_kml_name
    output_csv_path = user_dir / output_csv_name

    try:
        logger.info(f"Starting regenerate_cables_only -> {output_kmz_path}")
        await asyncio.to_thread(
            regenerate_cables_only,
            output_path=output_kmz_path,
            include_homepass=True,
            output_csv=output_csv_path,
            cache_dir=cache_dir,
        )

        if not os.path.exists(output_kmz_path):
            raise HTTPException(status_code=500, detail="Regenerate succeeded but KMZ output not found.")

        with zipfile.ZipFile(output_kmz_path, 'r') as z:
            kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not kml_name:
                raise HTTPException(status_code=500, detail="No KML found inside regenerated KMZ")

            kml_content = z.read(kml_name)
            with open(output_kml, "wb") as f:
                f.write(kml_content)

        return {
            "status": "success", 
            "message": "Kabel berhasil di-regenerate", 
            "url": user_file_url(output_kml_name),
            "kmz_url": user_file_url(output_kmz_name),
            "csv_url": user_file_url(output_csv_name),
        }

    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("Exception during cable regeneration")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/generate-custom")
async def generate_custom(
    customFile: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
):
    user_dir = get_user_storage_dir(current_user["id"])
    cache_dir = get_user_cache_dir(current_user["id"])
    cleanup_old_files(user_dir)
    custom_path = user_dir / create_user_filename("custom_mapping", "kml")
    output_kmz_name = create_user_filename("design_ftth_custom", "kmz")
    output_kml_name = create_user_filename("design_ftth_custom", "kml")
    output_csv_name = create_user_filename("design_ftth_custom", "csv")
    output_kmz_path = user_dir / output_kmz_name
    output_kml = user_dir / output_kml_name
    output_csv_path = user_dir / output_csv_name

    with open(custom_path, "wb") as buffer:
        shutil.copyfileobj(customFile.file, buffer)

    try:
        await asyncio.to_thread(
            generate_cables_from_custom_points,
            file_path=custom_path,
            output_path=output_kmz_path,
            include_homepass=True,
            output_csv=output_csv_path,
            cache_dir=cache_dir,
        )

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
            "url": user_file_url(output_kml_name),
            "kmz_url": user_file_url(output_kmz_name),
            "csv_url": user_file_url(output_csv_name),
        }

    except ValueError as e:
        logger.warning(f"Validation error during generation: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Exception during custom cable generation")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/files/{filename}")
async def get_user_file(filename: str, current_user: dict = Depends(get_current_user)):
    try:
        file_path = resolve_user_file(current_user["id"], filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    media_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    return FileResponse(path=file_path, media_type=media_type, filename=file_path.name)
