from fastapi import APIRouter, HTTPException, UploadFile, File
import os
import zipfile
import time
import shutil
import asyncio
from typing import Optional
from backend.core.logging import logger

from backend.services.generator.core_logic import regenerate_cables_only, generate_cables_from_custom_points
from backend.services.generator.kml_parser import read_boundary, read_points, read_houses_from_file
from backend.services.generator.osm_client import fetch_houses_in_boundary, fetch_road_graph
from backend.services.generator.clustering import build_design
from backend.services.generator.routing import build_feeder_chain, enforce_min_distance_between_odcs
from backend.services.generator.core_logic import save_design_state
from backend.services.generator.kml_builder import export_kmz
import math

router = APIRouter()

# Helper for the main generation logic
def _run_generator_logic(boundary_path, pop_path, output_kmz):
    boundary = read_boundary(boundary_path)
    pop_points = read_points(pop_path)
    pop = pop_points[0]
    
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
        
    export_kmz(pop, odcs, feeder_segments, output_kmz, include_homepass=False, road_graph=road_graph, road_feeder=True)


@router.post("/generate")
async def generate_design(
    boundaryFile: Optional[UploadFile] = File(None),
    popFile: Optional[UploadFile] = File(None)
):
    boundary_path = "boundary.kml"
    pop_path = "POP.kml"

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
    
    if not os.path.exists(boundary_path):
        raise HTTPException(status_code=404, detail=f"Boundary file not found: {boundary_path}")
    if not os.path.exists(pop_path):
        raise HTTPException(status_code=404, detail=f"POP file not found: {pop_path}")

    timestamp = int(time.time())
    output_kmz = f"design_ftth_{timestamp}.kmz"
    output_kml = f"dashboard/public/data/design_ftth_{timestamp}.kml"

    try:
        # Run generator in a thread to avoid blocking the event loop
        logger.info(f"Running FTTH generation: boundary={boundary_path}, pop={pop_path}, output={output_kmz}")
        await asyncio.to_thread(_run_generator_logic, boundary_path, pop_path, output_kmz)

        if not os.path.exists(output_kmz):
            raise HTTPException(status_code=500, detail="Script ran successfully but KMZ output not found.")

        with zipfile.ZipFile(output_kmz, 'r') as z:
            kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not kml_name:
                raise HTTPException(status_code=500, detail="No KML found inside generated KMZ")
            
            kml_content = z.read(kml_name)
            os.makedirs("dashboard/public/data", exist_ok=True)
            with open(output_kml, "wb") as f:
                f.write(kml_content)

        os.remove(output_kmz)
        return {"status": "success", "message": "FTTH design generated successfully", "url": f"http://localhost:8000/data/design_ftth_{timestamp}.kml"}

    except Exception as e:
        logger.exception("Exception during generation")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/regenerate-cables")
async def regenerate_cables():
    timestamp = int(time.time())
    output_kmz = f"design_ftth_regen_{timestamp}.kmz"
    output_kml = f"dashboard/public/data/design_ftth_regen_{timestamp}.kml"

    try:
        logger.info(f"Starting regenerate_cables_only -> {output_kmz}")
        await asyncio.to_thread(regenerate_cables_only, output_path=output_kmz, include_homepass=False)

        if not os.path.exists(output_kmz):
            raise HTTPException(status_code=500, detail="Regenerate succeeded but KMZ output not found.")

        with zipfile.ZipFile(output_kmz, 'r') as z:
            kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not kml_name:
                raise HTTPException(status_code=500, detail="No KML found inside regenerated KMZ")

            kml_content = z.read(kml_name)
            os.makedirs("dashboard/public/data", exist_ok=True)
            with open(output_kml, "wb") as f:
                f.write(kml_content)

        os.remove(output_kmz)
        return {"status": "success", "message": "Kabel berhasil di-regenerate", "url": f"http://localhost:8000/data/design_ftth_regen_{timestamp}.kml"}

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
    output_kmz = f"design_ftth_custom_{timestamp}.kmz"
    output_kml = f"dashboard/public/data/design_ftth_{timestamp}.kml"

    os.makedirs("dashboard/public/data", exist_ok=True)
    with open(custom_path, "wb") as buffer:
        shutil.copyfileobj(customFile.file, buffer)

    try:
        await asyncio.to_thread(generate_cables_from_custom_points, file_path=custom_path, output_path=output_kmz, include_homepass=True)

        if not os.path.exists(output_kmz):
            raise HTTPException(status_code=500, detail="Generate succeeded but KMZ output not found.")

        with zipfile.ZipFile(output_kmz, 'r') as z:
            kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not kml_name:
                raise HTTPException(status_code=500, detail="No KML found inside regenerated KMZ")

            kml_content = z.read(kml_name)
            with open(output_kml, "wb") as f:
                f.write(kml_content)

        os.remove(output_kmz)
        return {"status": "success", "message": "Jalur kabel berhasil dibuat dari custom mapping KML.", "url": f"http://localhost:8000/data/design_ftth_{timestamp}.kml"}

    except Exception as e:
        logger.exception("Exception during custom cable generation")
        raise HTTPException(status_code=500, detail=str(e))
