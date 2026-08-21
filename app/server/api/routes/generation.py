from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
import os
import zipfile
import time
import shutil
import asyncio
import glob
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Iterator, Optional
from uuid import uuid4
from server.core.logging import logger
from server.core.paths import DATA_DIR, SAMPLES_KML_DIR
from server.storage.base import ObjectStorage
from server.storage.dependencies import get_object_storage

from server.services.generator.core_logic import (
    regenerate_cables_only,
    generate_cables_from_custom_points,
)
from server.services.generator.kml_parser import read_boundary, read_points
from server.services.generator.osm_local import (
    fetch_houses_in_boundary,
    fetch_road_graph,
)
from server.services.generator.clustering import build_design
from server.services.generator.routing import (
    build_feeder_chain,
    enforce_min_distance_between_odcs,
)
from server.services.generator.core_logic import save_design_state
from server.services.generator.kml_builder import export_kmz
from server.services.generator.csv_exporter import export_csv
import math

router = APIRouter()

GENERATED_ARTIFACTS = {
    "url": ("design.kml", "application/vnd.google-earth.kml+xml", "inline"),
    "kmz_url": ("design.kmz", "application/vnd.google-earth.kmz", "attachment"),
    "csv_url": ("design.csv", "text/csv", "attachment"),
}


@dataclass(frozen=True)
class GenerationWorkspace:
    run_id: str
    directory: Path
    artifact_paths: dict[str, Path]


def cleanup_old_files(directory: Path | str | None = None, max_age_seconds=3600):
    """Hapus file generate yang lebih lama dari max_age_seconds (default 1 jam)"""
    directory = directory or DATA_DIR
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


@contextmanager
def _generation_workspace() -> Iterator[GenerationWorkspace]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    run_id = uuid4().hex

    with TemporaryDirectory(prefix=f"generation-{run_id}-", dir=DATA_DIR) as scratch:
        directory = Path(scratch)
        yield GenerationWorkspace(
            run_id=run_id,
            directory=directory,
            artifact_paths={
                "url": directory / "design.kml",
                "kmz_url": directory / "design.kmz",
                "csv_url": directory / "design.csv",
            },
        )


def _extract_kml(kmz_path: Path, kml_path: Path) -> None:
    with zipfile.ZipFile(kmz_path, "r") as archive:
        kml_name = next(
            (name for name in archive.namelist() if name.lower().endswith(".kml")),
            None,
        )
        if not kml_name:
            raise RuntimeError("No KML found inside generated KMZ")
        kml_path.write_bytes(archive.read(kml_name))


def _publish_generated_artifacts(
    storage: ObjectStorage,
    run_id: str,
    artifact_paths: dict[str, Path],
) -> dict[str, str | None]:
    urls: dict[str, str | None] = {}
    uploaded_keys: list[str] = []

    try:
        for response_field, (
            filename,
            content_type,
            disposition,
        ) in GENERATED_ARTIFACTS.items():
            artifact_path = artifact_paths[response_field]
            if not artifact_path.exists():
                raise FileNotFoundError(f"Generated artifact not found: {filename}")

            object_key = f"generated/{run_id}/{filename}"
            with artifact_path.open("rb") as source:
                storage.upload(
                    object_key,
                    source,
                    content_type=content_type,
                    content_disposition=f'{disposition}; filename="{filename}"',
                )
            uploaded_keys.append(object_key)
            urls[response_field] = storage.url_for(object_key)
    except Exception:
        for object_key in uploaded_keys:
            try:
                storage.delete(object_key)
            except Exception:
                logger.warning("Failed to roll back object %s", object_key)
        raise

    return urls


async def _finalize_generated_artifacts(
    storage: ObjectStorage,
    workspace: GenerationWorkspace,
) -> dict[str, str | None]:
    await asyncio.to_thread(
        _extract_kml,
        workspace.artifact_paths["kmz_url"],
        workspace.artifact_paths["url"],
    )
    return await asyncio.to_thread(
        _publish_generated_artifacts,
        storage,
        workspace.run_id,
        workspace.artifact_paths,
    )


def haversine_dist(lon1, lat1, lon2, lat2):
    """Hitung jarak (dalam meter) antara dua titik koordinat."""
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# Helper for the main generation logic
def _run_generator_logic(
    boundary_path, pop_path, output_kmz, output_csv=None, has_custom_pop=False
):
    boundary = read_boundary(boundary_path)

    if has_custom_pop:
        pop_points = read_points(pop_path)
        pop = pop_points[0]
        # Validasi Jarak jika POP custom di-upload
        dist = haversine_dist(
            boundary.centroid.x, boundary.centroid.y, pop["lon"], pop["lat"]
        )
        if dist > 3000:  # 3 km
            raise ValueError(
                "POP (Sentral) terlalu jauh dari area perancangan (> 3 km). Hal ini dapat membebani server saat meroute jalan. Harap letakkan POP lebih dekat dengan area boundary."
            )
    else:
        # Jika tidak ada POP yang di-upload, otomatis buat POP di lokasi strategis
        from server.services.generator.osm_local import find_strategic_pop

        pop = find_strategic_pop(boundary)
        logger.info(
            f"Auto-generated POP at {pop['lon']}, {pop['lat']} (Location: {pop['name']})"
        )

    houses = fetch_houses_in_boundary(boundary)
    if not houses:
        raise ValueError(
            "Tidak ada rumah yang ditemukan di OpenStreetMap untuk area ini."
        )

    road_graph = None
    try:
        road_graph = fetch_road_graph(boundary, pop)
    except Exception as e:
        logger.warning(
            f"Gagal mengambil data jalan ({e}). Feeder akan pakai garis lurus."
        )

    odcs = build_design(
        houses=houses, odp_capacity=8, odc_capacity=4, road_graph=road_graph
    )
    enforce_min_distance_between_odcs(odcs, min_dist_m=40.0)
    feeder_segments, odcs = build_feeder_chain(pop, odcs, road_graph=road_graph)

    try:
        save_design_state(pop, odcs, road_graph=road_graph)
    except Exception as e:
        logger.warning(f"Gagal menyimpan design state ({e})")

    export_kmz(
        pop,
        odcs,
        feeder_segments,
        output_kmz,
        include_homepass=True,
        road_graph=road_graph,
        road_feeder=True,
    )
    if output_csv:
        export_csv(pop, odcs, feeder_segments, output_csv)


@router.post("/generate")
async def generate_design(
    boundaryFile: Optional[UploadFile] = File(None),
    popFile: Optional[UploadFile] = File(None),
    storage: ObjectStorage = Depends(get_object_storage),
):
    cleanup_old_files()

    with _generation_workspace() as workspace:
        scratch_dir = workspace.directory
        boundary_path = SAMPLES_KML_DIR / "boundary.kml"
        pop_path = SAMPLES_KML_DIR / "POP.kml"
        has_custom_pop = False

        if boundaryFile and boundaryFile.filename:
            boundary_path = scratch_dir / "boundary.kml"
            with boundary_path.open("wb") as buffer:
                shutil.copyfileobj(boundaryFile.file, buffer)

        if popFile and popFile.filename:
            pop_path = scratch_dir / "pop.kml"
            with pop_path.open("wb") as buffer:
                shutil.copyfileobj(popFile.file, buffer)
            has_custom_pop = True

        if not boundary_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"Boundary file not found: {boundary_path}",
            )
        if has_custom_pop and not pop_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"POP file not found: {pop_path}",
            )

        try:
            logger.info(
                "Running FTTH generation: boundary=%s, pop=%s, output=%s",
                boundary_path,
                pop_path,
                workspace.artifact_paths["kmz_url"],
            )
            await asyncio.to_thread(
                _run_generator_logic,
                str(boundary_path),
                str(pop_path),
                str(workspace.artifact_paths["kmz_url"]),
                str(workspace.artifact_paths["csv_url"]),
                has_custom_pop,
            )
            artifact_urls = await _finalize_generated_artifacts(
                storage,
                workspace,
            )

            return {
                "status": "success",
                "message": "FTTH design generated successfully",
                **artifact_urls,
            }
        except ValueError as exc:
            logger.warning("Validation error during generation: %s", exc)
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Exception during generation")
            raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/regenerate-cables")
async def regenerate_cables(
    storage: ObjectStorage = Depends(get_object_storage),
):
    cleanup_old_files()

    with _generation_workspace() as workspace:
        try:
            logger.info(
                "Starting regenerate_cables_only -> %s",
                workspace.artifact_paths["kmz_url"],
            )
            await asyncio.to_thread(
                regenerate_cables_only,
                output_path=str(workspace.artifact_paths["kmz_url"]),
                include_homepass=True,
                output_csv=str(workspace.artifact_paths["csv_url"]),
            )
            artifact_urls = await _finalize_generated_artifacts(
                storage,
                workspace,
            )

            return {
                "status": "success",
                "message": "Kabel berhasil di-regenerate",
                **artifact_urls,
            }
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Exception during cable regeneration")
            raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/generate-custom")
async def generate_custom(
    customFile: UploadFile = File(...),
    storage: ObjectStorage = Depends(get_object_storage),
):
    with _generation_workspace() as workspace:
        scratch_dir = workspace.directory
        custom_path = scratch_dir / "custom.kml"
        with custom_path.open("wb") as buffer:
            shutil.copyfileobj(customFile.file, buffer)

        try:
            await asyncio.to_thread(
                generate_cables_from_custom_points,
                file_path=str(custom_path),
                output_path=str(workspace.artifact_paths["kmz_url"]),
                include_homepass=True,
                output_csv=str(workspace.artifact_paths["csv_url"]),
            )
            artifact_urls = await _finalize_generated_artifacts(
                storage,
                workspace,
            )

            return {
                "status": "success",
                "message": "Jalur kabel berhasil dibuat dari custom mapping KML.",
                **artifact_urls,
            }
        except ValueError as exc:
            logger.warning("Validation error during generation: %s", exc)
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Exception during custom cable generation")
            raise HTTPException(status_code=500, detail=str(exc)) from exc
