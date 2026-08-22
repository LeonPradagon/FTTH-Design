import asyncio
import os
import json
from datetime import datetime, timezone
from pathlib import Path
from arq.connections import RedisSettings
from backend.core.logging import logger
from backend.services.generator.generation_config import GenerationConfig, ALGORITHM_VERSION, GENERATOR_VERSION
from backend.services.generator.progress import progress_manager
from backend.services.generator.core_logic import _run_generator_logic, _extract_kml_from_kmz, _compute_input_hash
from backend.services.generator.validation import validate_design, compute_design_stats
from backend.database import db
from backend.services.user_storage import upload_file, user_file_url
from prisma import Json

async def generate_task(
    ctx,
    boundary_path: str,
    pop_path: str | None,
    output_kmz_path: str,
    output_csv_path: str,
    has_custom_pop: bool,
    cache_dir: str,
    gen_config_dict: dict,
    job_id: str,
    project_id: str | None,
    user_id: str,
    output_kml_name: str,
    output_kmz_name: str,
    output_csv_name: str,
):
    try:
        config = GenerationConfig(**gen_config_dict)

        pop, odcs, feeder_segments, used_config, osm_ts = await asyncio.to_thread(
            _run_generator_logic,
            boundary_path,
            pop_path,
            output_kmz_path,
            output_csv_path,
            has_custom_pop,
            cache_dir,
            config,
            job_id,
        )
        
        if not os.path.exists(output_kmz_path):
            raise Exception("Script ran successfully but KMZ output not found.")
            
        progress_manager.update(job_id, "EXPORTING", "Ekstrak KML dari KMZ...", 87)
        output_kml_path = output_kmz_path.replace(".kmz", ".kml")
        await asyncio.to_thread(_extract_kml_from_kmz, output_kmz_path, output_kml_path)
        
        progress_manager.update(job_id, "EXPORTING", "Memvalidasi desain FTTH...", 89)
        validation_result = await asyncio.to_thread(
            validate_design, pop, odcs, used_config, feeder_segments=feeder_segments
        )
        stats = await asyncio.to_thread(
            compute_design_stats, pop, odcs, feeder_segments=feeder_segments
        )
        
        input_hash = await asyncio.to_thread(_compute_input_hash, boundary_path, pop_path)
        
        # Upload generated files to MinIO
        progress_manager.update(job_id, "EXPORTING", "Mengunggah file ke penyimpanan...", 92)
        await asyncio.to_thread(upload_file, user_id, output_kmz_name, Path(output_kmz_path))
        await asyncio.to_thread(upload_file, user_id, output_csv_name, Path(output_csv_path))
        await asyncio.to_thread(upload_file, user_id, output_kml_name, Path(output_kml_path))

        progress_manager.update(job_id, "EXPORTING", "Menyimpan ke database (bisa memakan waktu)...", 95)

        meta = {
            "input_hash": input_hash,
            "algorithm_version": ALGORITHM_VERSION,
            "generator_version": GENERATOR_VERSION,
            "config": used_config.model_dump(),
            "osm_timestamp": osm_ts,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        
        if project_id:
            await db.connect()
            try:
                last_version = await db.designversion.find_first(
                    where={"projectId": project_id},
                    order={"version": "desc"}
                )
                next_version = (last_version.version + 1) if last_version else 1
                
                new_version = await db.designversion.create(
                    data={
                        "projectId": project_id,
                        "version": next_version,
                        "config": Json(used_config.model_dump()),
                        "metadata": Json(meta),
                        "validation": Json(validation_result.to_dict()),
                        "stats": Json(stats),
                        "status": "COMPLETED"
                    }
                )
                
                # Insert Spatial Features (ODC, ODP) using Raw SQL
                query_odc = 'INSERT INTO "design_odc" ("id", "designVersionId", "label", "location") VALUES (gen_random_uuid(), $1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)) RETURNING "id"'
                query_odp = 'INSERT INTO "design_odp" ("id", "designVersionId", "odcId", "label", "location") VALUES (gen_random_uuid(), $1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326))'
                query_cable = 'INSERT INTO "design_cable" ("id", "designVersionId", "type", "sourceLabel", "targetLabel", "length", "path") VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, ST_GeomFromGeoJSON($6))'

                for odc in odcs:
                    odc_row = await db.query_first(query_odc, new_version.id, odc.id, odc.lon, odc.lat)
                    if odc_row and 'id' in odc_row:
                        odc_id = odc_row['id']
                        for odp in odc.odps:
                            await db.execute_raw(query_odp, new_version.id, odc_id, odp.id, odp.lon, odp.lat)
                
                # Insert Feeder Cables
                import json as json_lib
                for seg in feeder_segments:
                    # seg['coords'] is list of (lat, lon)
                    # Convert to GeoJSON LineString (lon, lat)
                    line_coords = [[c[1], c[0]] for c in seg['coords']]
                    geojson = json_lib.dumps({
                        "type": "LineString",
                        "coordinates": line_coords
                    })
                    
                    # Calculate length approx
                    from backend.utils.geometry import haversine_m
                    length = 0.0
                    for i in range(len(seg['coords']) - 1):
                        length += haversine_m(seg['coords'][i][0], seg['coords'][i][1], seg['coords'][i+1][0], seg['coords'][i+1][1])
                        
                    await db.execute_raw(
                        query_cable, 
                        new_version.id, 
                        "feeder", 
                        seg.get("from_label", ""), 
                        seg.get("to_label", ""), 
                        length, 
                        geojson
                    )

                await db.auditlog.create(
                    data={
                        "userId": user_id,
                        "action": "GENERATE",
                        "projectId": project_id,
                        "details": Json({"version": next_version})
                    }
                )
            except Exception as e:
                logger.error(f"Failed to save design version: {e}")
            finally:
                await db.disconnect()

        result_dict = {
            "url": user_file_url(output_kml_name),
            "kmz_url": user_file_url(output_kmz_name),
            "csv_url": user_file_url(output_csv_name),
            "stats": stats,
            "validation": validation_result.to_dict()
        }
        progress_manager.complete(job_id, result=result_dict)
        
    except Exception as e:
        logger.exception("Job %s failed", job_id)
        progress_manager.error(job_id, str(e))
        raise

async def regenerate_cables_task(ctx, output_path: str, include_homepass: bool, output_csv: str, cache_dir: str, job_id: str, user_id: str):
    from backend.services.generator.core_logic import regenerate_cables_only
    try:
        await asyncio.to_thread(regenerate_cables_only, output_path, include_homepass, output_csv, cache_dir, job_id)
        
        output_kml_path = output_path.replace(".kmz", ".kml")
        await asyncio.to_thread(_extract_kml_from_kmz, output_path, output_kml_path)

        output_kmz_name = Path(output_path).name
        output_kml_name = Path(output_kml_path).name
        output_csv_name = Path(output_csv).name
        await asyncio.to_thread(upload_file, user_id, output_kmz_name, Path(output_path))
        await asyncio.to_thread(upload_file, user_id, output_csv_name, Path(output_csv))
        await asyncio.to_thread(upload_file, user_id, output_kml_name, Path(output_kml_path))

        result_dict = {
            "url": user_file_url(output_kml_name),
            "kmz_url": user_file_url(output_kmz_name),
            "csv_url": user_file_url(output_csv_name)
        }
        progress_manager.complete(job_id, result=result_dict)
    except Exception as e:
        logger.exception("Job %s failed", job_id)
        progress_manager.error(job_id, str(e))
        raise
        
async def generate_custom_task(ctx, custom_path: str, output_kmz_path: str, include_homepass: bool, output_csv: str, cache_dir: str, job_id: str, user_id: str):
    from backend.services.generator.core_logic import generate_cables_from_custom_points
    try:
        await asyncio.to_thread(generate_cables_from_custom_points, custom_path, output_kmz_path, include_homepass, output_csv, cache_dir, job_id)
        
        output_kml_path = output_kmz_path.replace(".kmz", ".kml")
        await asyncio.to_thread(_extract_kml_from_kmz, output_kmz_path, output_kml_path)

        output_kmz_name = Path(output_kmz_path).name
        output_kml_name = Path(output_kml_path).name
        output_csv_name = Path(output_csv).name
        await asyncio.to_thread(upload_file, user_id, output_kmz_name, Path(output_kmz_path))
        await asyncio.to_thread(upload_file, user_id, output_csv_name, Path(output_csv))
        await asyncio.to_thread(upload_file, user_id, output_kml_name, Path(output_kml_path))

        result_dict = {
            "url": user_file_url(output_kml_name),
            "kmz_url": user_file_url(output_kmz_name),
            "csv_url": user_file_url(output_csv_name)
        }
        progress_manager.complete(job_id, result=result_dict)
    except Exception as e:
        logger.exception("Job %s failed", job_id)
        progress_manager.error(job_id, str(e))
        raise

async def startup(ctx):
    logger.info("Worker starting up...")

async def shutdown(ctx):
    logger.info("Worker shutting down...")

class WorkerSettings:
    functions = [generate_task, regenerate_cables_task, generate_custom_task]
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(os.getenv("REDIS_URL", "redis://localhost:6379/0"))
    job_timeout = 3600  # 1 hour timeout for large generation tasks
