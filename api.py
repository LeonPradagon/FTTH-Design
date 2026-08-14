from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import subprocess
import os
import zipfile
import time
import shutil
import logging
from typing import Optional

# Setup logging
os.makedirs("dashboard/public/data", exist_ok=True)
logging.basicConfig(
    filename='dashboard/public/data/app.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(title="FTTH Design API")

# Allow Next.js frontend to call the API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # For development, allow all origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files for frontend to fetch immediately
app.mount("/data", StaticFiles(directory="dashboard/public/data"), name="data")

@app.post("/generate")
async def generate_design(
    boundaryFile: Optional[UploadFile] = File(None),
    popFile: Optional[UploadFile] = File(None)
):
    boundary_path = "boundary.kml"
    pop_path = "POP.kml"

    # Save uploaded boundary if exists
    if boundaryFile and boundaryFile.filename:
        os.makedirs("dashboard/public/data", exist_ok=True)
        boundary_path = f"dashboard/public/data/custom_boundary_{int(time.time())}.kml"
        with open(boundary_path, "wb") as buffer:
            shutil.copyfileobj(boundaryFile.file, buffer)

    # Save uploaded POP if exists
    if popFile and popFile.filename:
        os.makedirs("dashboard/public/data", exist_ok=True)
        pop_path = f"dashboard/public/data/custom_pop_{int(time.time())}.kml"
        with open(pop_path, "wb") as buffer:
            shutil.copyfileobj(popFile.file, buffer)
    
    if not os.path.exists(boundary_path):
        raise HTTPException(status_code=404, detail=f"Boundary file not found: {boundary_path}")
    if not os.path.exists(pop_path):
        raise HTTPException(status_code=404, detail=f"POP file not found: {pop_path}")

    # The script generates design_ftth.kmz by default, but let's make it unique
    timestamp = int(time.time())
    output_kmz = f"design_ftth_{timestamp}.kmz"
    output_kml = f"dashboard/public/data/design_ftth_{timestamp}.kml"

    try:
        # Run the existing FTTH python script
        # Command: python3 ftth_design_generator.py --boundary boundary.kml --pop POP.kml --output design_ftth_{ts}.kmz
        print(f"Running FTTH generation: boundary={boundary_path}, pop={pop_path}, output={output_kmz}")
        process = subprocess.run(
            [
                "python3", "ftth_design_generator.py",
                "--boundary", boundary_path,
                "--pop", pop_path,
                "--output", output_kmz
            ],
            capture_output=True,
            text=True
        )

        if process.returncode != 0:
            print("Error output:", process.stderr)
            raise HTTPException(status_code=500, detail=f"Script failed: {process.stderr}")

        # Ensure KMZ was generated
        if not os.path.exists(output_kmz):
            raise HTTPException(status_code=500, detail="Script ran successfully but KMZ output not found.")

        # Extract doc.kml from the KMZ to the Next.js public directory
        with zipfile.ZipFile(output_kmz, 'r') as z:
            kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not kml_name:
                raise HTTPException(status_code=500, detail="No KML found inside generated KMZ")
            
            # Read KML content
            kml_content = z.read(kml_name)
            
            # Write to Next.js public directory
            os.makedirs("dashboard/public/data", exist_ok=True)
            with open(output_kml, "wb") as f:
                f.write(kml_content)

        # Optional: cleanup the generated KMZ in the root
        os.remove(output_kmz)

        # Return the public URL for the Next.js frontend to fetch
        return {"status": "success", "message": "FTTH design generated successfully", "url": f"http://localhost:8000/data/design_ftth_{timestamp}.kml"}

    except Exception as e:
        print(f"Exception during generation: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/regenerate-cables")
async def regenerate_cables():
    """Regenerate hanya jalur kabel (feeder, distribusi, drop) tanpa mengubah
    posisi ODC/ODP/tiang/rumah. Membaca posisi dari cache design state."""
    timestamp = int(time.time())
    output_kmz = f"design_ftth_regen_{timestamp}.kmz"
    output_kml = f"dashboard/public/data/design_ftth_regen_{timestamp}.kml"

    try:
        from ftth_design_generator import regenerate_cables_only

        logger.info(f"Starting regenerate_cables_only -> {output_kmz}")
        print(f"Regenerating cables only -> {output_kmz}")
        regenerate_cables_only(output_path=output_kmz, include_homepass=False)

        if not os.path.exists(output_kmz):
            logger.error("Regenerate succeeded but KMZ output not found.")
            raise HTTPException(status_code=500, detail="Regenerate succeeded but KMZ output not found.")

        # Extract KML from KMZ
        with zipfile.ZipFile(output_kmz, 'r') as z:
            kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not kml_name:
                logger.error("No KML found inside regenerated KMZ")
                raise HTTPException(status_code=500, detail="No KML found inside regenerated KMZ")

            kml_content = z.read(kml_name)
            os.makedirs("dashboard/public/data", exist_ok=True)
            with open(output_kml, "wb") as f:
                f.write(kml_content)

        os.remove(output_kmz)
        logger.info("regenerate_cables_only completed successfully.")

        return {"status": "success", "message": "Kabel berhasil di-regenerate (posisi tiang/ODC/ODP tetap)", "url": f"http://localhost:8000/data/design_ftth_regen_{timestamp}.kml"}

    except FileNotFoundError as e:
        logger.error(f"FileNotFoundError: {str(e)}")
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception(f"Exception during cable regeneration: {str(e)}")
        print(f"Exception during cable regeneration: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate-custom")
async def generate_custom(
    customFile: UploadFile = File(...)
):
    """Membaca file KML custom yang berisi titik-titik mapping OLT, ODC, ODP, Rumah.
    Lalu men-generate jalur kabelnya."""
    timestamp = int(time.time())
    custom_path = f"dashboard/public/data/custom_mapping_{timestamp}.kml"
    output_kmz = f"design_ftth_custom_{timestamp}.kmz"
    output_kml = f"dashboard/public/data/design_ftth_{timestamp}.kml"

    os.makedirs("dashboard/public/data", exist_ok=True)
    with open(custom_path, "wb") as buffer:
        shutil.copyfileobj(customFile.file, buffer)

    try:
        from ftth_design_generator import generate_cables_from_custom_points

        print(f"Generating cables from custom points -> {output_kmz}")
        generate_cables_from_custom_points(file_path=custom_path, output_path=output_kmz, include_homepass=True)

        if not os.path.exists(output_kmz):
            raise HTTPException(status_code=500, detail="Generate succeeded but KMZ output not found.")

        # Extract KML from KMZ
        with zipfile.ZipFile(output_kmz, 'r') as z:
            kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not kml_name:
                raise HTTPException(status_code=500, detail="No KML found inside regenerated KMZ")

            kml_content = z.read(kml_name)
            with open(output_kml, "wb") as f:
                f.write(kml_content)

        os.remove(output_kmz)
        
        # Optional: update design state cache if you want "Regenerate Kabel" to work on this custom map later
        # We can skip it or just do it inside generate_cables_from_custom_points if needed.

        return {"status": "success", "message": "Jalur kabel berhasil dibuat dari custom mapping KML.", "url": f"http://localhost:8000/data/design_ftth_{timestamp}.kml"}

    except Exception as e:
        print(f"Exception during custom cable generation: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)

