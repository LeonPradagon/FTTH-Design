import asyncio
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from arq.connections import RedisSettings
from server.core.logging import logger
from server.services.generator.generation_config import GenerationConfig, ALGORITHM_VERSION, GENERATOR_VERSION
from server.services.generator.progress import progress_manager
from server.services.generator.core_logic import (
    _run_generator_logic,
    _compute_input_hash,
    generate_homepass_from_state,
)
from server.services.generator.validation import validate_design, compute_design_stats
from server.database import db, lock_project_version_sequence
from server.services.user_storage import upload_file, user_file_url, user_object_key
from server.storage.dependencies import get_object_storage
from prisma import Json


async def _update_generation_job(job_id: str, **data) -> None:
    await db.generationjob.update(where={"id": job_id}, data=data)


async def _record_job_failure(job_id: str, error: Exception) -> None:
    logger.exception("Job %s failed", job_id)
    progress_manager.error(job_id, str(error))
    try:
        await _update_generation_job(
            job_id,
            status="FAILED",
            stage="ERROR",
            progress=100,
            error=str(error),
        )
    except Exception:
        logger.exception("Failed to persist failure state for job %s", job_id)


async def _publish_generation_artifacts(
    job_id: str,
    user_id: str,
    output_kmz_path: str,
    output_csv_path: str,
) -> dict:
    output_kmz_name = Path(output_kmz_path).name
    output_csv_name = Path(output_csv_path).name
    await asyncio.to_thread(upload_file, user_id, output_kmz_name, Path(output_kmz_path))
    await asyncio.to_thread(upload_file, user_id, output_csv_name, Path(output_csv_path))
    result = {
        "url": user_file_url(output_kmz_name),
        "kmz_url": user_file_url(output_kmz_name),
        "csv_url": user_file_url(output_csv_name),
    }
    await _update_generation_job(
        job_id,
        status="COMPLETED",
        stage="COMPLETED",
        progress=100,
        result=Json(result),
    )
    progress_manager.complete(job_id, result=result)
    return result


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
    batch_id: str | None = None,
    batch_item_id: str | None = None,
):
    try:
        await _update_generation_job(
            job_id, status="RUNNING", stage="STARTING", progress=2, error=None
        )
        if batch_id:
            progress_manager.update_batch_job(batch_id, job_id, status="RUNNING")
        config = GenerationConfig(**gen_config_dict)

        pop, odcs, feeder_segments, distribution_segments, used_config, osm_ts = await asyncio.to_thread(
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

        progress_manager.update(job_id, "EXPORTING", "Memvalidasi desain FTTH...", 89)
        validation_result = await asyncio.to_thread(
            validate_design,
            pop,
            odcs,
            used_config,
            feeder_segments=feeder_segments,
            distribution_segments=distribution_segments,
        )
        stats = await asyncio.to_thread(
            compute_design_stats,
            pop,
            odcs,
            feeder_segments=feeder_segments,
            distribution_segments=distribution_segments,
        )

        input_hash = await asyncio.to_thread(_compute_input_hash, boundary_path, pop_path)

        # Publish generated files through the configured S3-compatible storage.
        progress_manager.update(job_id, "EXPORTING", "Mengunggah file ke penyimpanan...", 92)
        await asyncio.to_thread(upload_file, user_id, output_kmz_name, Path(output_kmz_path))
        await asyncio.to_thread(upload_file, user_id, output_csv_name, Path(output_csv_path))

        progress_manager.update(job_id, "EXPORTING", "Menyimpan ke database (bisa memakan waktu)...", 95)

        meta = {
            "input_hash": input_hash,
            "algorithm_version": ALGORITHM_VERSION,
            "generator_version": GENERATOR_VERSION,
            "config": used_config.model_dump(),
            "osm_timestamp": osm_ts,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "artifacts": {
                "kmz": user_object_key(user_id, output_kmz_name),
                "csv": user_object_key(user_id, output_csv_name),
            },
        }

        if project_id:
            transaction_manager = db.tx(timeout=timedelta(minutes=5))
            transaction = await transaction_manager.start()
            try:
                await lock_project_version_sequence(transaction, project_id)
                last_version = await transaction.designversion.find_first(
                    where={"projectId": project_id},
                    order={"version": "desc"}
                )
                next_version = (last_version.version + 1) if last_version else 1

                new_version = await transaction.designversion.create(
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
                query_odp = 'INSERT INTO "design_odp" ("id", "designVersionId", "odcId", "label", "location") VALUES '
                query_cable = 'INSERT INTO "design_cable" ("id", "designVersionId", "type", "sourceLabel", "targetLabel", "length", "path") VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, ST_GeomFromGeoJSON($6))'

                odc_db_ids = {}
                odp_rows = []
                for odc in odcs:
                    odc_row = await transaction.query_first(query_odc, new_version.id, odc.id, odc.lon, odc.lat)
                    if odc_row and 'id' in odc_row:
                        odc_id = odc_row['id']
                        odc_db_ids[odc.id] = odc_id
                        for odp in odc.odps:
                            odp_rows.append((odc_id, odp.id, odp.lon, odp.lat))

                if odp_rows:
                    odp_values = []
                    odp_params = []
                    for index, (odc_id, odp_id, lon, lat) in enumerate(odp_rows):
                        base = index * 5 + 1
                        odp_values.append(
                            f"(gen_random_uuid(), ${base}, ${base + 1}, ${base + 2}, "
                            f"ST_SetSRID(ST_MakePoint(${base + 3}, ${base + 4}), 4326))"
                        )
                        odp_params.extend([new_version.id, odc_id, odp_id, lon, lat])
                    await transaction.execute_raw(
                        query_odp + ", ".join(odp_values),
                        *odp_params,
                    )

                # Insert Feeder Cables
                import json as json_lib
                cable_rows = []
                for seg in feeder_segments:
                    # seg['coords'] is list of (lat, lon)
                    # Convert to GeoJSON LineString (lon, lat)
                    line_coords = [[c[1], c[0]] for c in seg['coords']]
                    geojson = json_lib.dumps({
                        "type": "LineString",
                        "coordinates": line_coords
                    })

                    # Calculate length approx
                    from server.utils.geometry import haversine_m
                    length = 0.0
                    for i in range(len(seg['coords']) - 1):
                        length += haversine_m(seg['coords'][i][0], seg['coords'][i][1], seg['coords'][i+1][0], seg['coords'][i+1][1])

                    cable_rows.append((
                        "feeder",
                        seg.get("from_label", ""),
                        seg.get("to_label", ""),
                        length,
                        geojson,
                    ))

                # Distribution paths are persisted from the generated tree,
                # including ODP -> ODP pass-through connections.
                for seg in distribution_segments.values():
                    if not seg.get("connected") or not seg.get("coords"):
                        continue
                    coords = seg["coords"]
                    line_coords = [[coord[1], coord[0]] for coord in coords]
                    geojson = json_lib.dumps({
                        "type": "LineString",
                        "coordinates": line_coords,
                    })
                    cable_rows.append((
                        "distribution",
                        seg.get("source_label", seg.get("source_id", "")),
                        seg.get("target_label", seg.get("target_id", "")),
                        seg.get("length_m") or 0.0,
                        geojson,
                    ))

                if cable_rows:
                    cable_values = []
                    cable_params = []
                    for index, (cable_type, source, target, length, geojson) in enumerate(cable_rows):
                        base = index * 6 + 1
                        cable_values.append(
                            f"(gen_random_uuid(), ${base}, ${base + 1}, ${base + 2}, "
                            f"${base + 3}, ${base + 4}, ST_GeomFromGeoJSON(${base + 5}))"
                        )
                        cable_params.extend([
                            new_version.id,
                            cable_type,
                            source,
                            target,
                            length,
                            geojson,
                        ])
                    await transaction.execute_raw(
                        query_cable.replace(
                            " VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, ST_GeomFromGeoJSON($6))",
                            " VALUES " + ", ".join(cable_values),
                        ),
                        *cable_params,
                    )

                await transaction.auditlog.create(
                    data={
                        "userId": user_id,
                        "action": "GENERATE",
                        "projectId": project_id,
                        "versionId": new_version.id,
                        "details": Json({
                            "old": ({
                                "version": last_version.version,
                                "config": last_version.config,
                            } if last_version else None),
                            "new": {
                                "version": next_version,
                                "config": used_config.model_dump(),
                                "artifacts": meta["artifacts"],
                            },
                        })
                    }
                )
            except BaseException:
                await transaction_manager.rollback()
                logger.exception("Failed to save design version for job %s", job_id)
                raise
            else:
                await transaction_manager.commit()

        result_dict = {
            # The dashboard can read doc.kml directly from the KMZ archive.
            "url": user_file_url(output_kmz_name),
            "kmz_url": user_file_url(output_kmz_name),
            "csv_url": user_file_url(output_csv_name),
            "stats": stats,
            "validation": validation_result.to_dict()
        }
        await _update_generation_job(
            job_id,
            status="COMPLETED",
            stage="COMPLETED",
            progress=100,
            result=Json(result_dict),
        )
        progress_manager.complete(job_id, result=result_dict)
        if batch_id:
            progress_manager.update_batch_job(
                batch_id,
                job_id,
                status="COMPLETED",
                result=result_dict,
            )

    except Exception as e:
        await _record_job_failure(job_id, e)
        if batch_id:
            progress_manager.update_batch_job(batch_id, job_id, status="FAILED", error=str(e))
        raise

async def regenerate_cables_task(ctx, output_path: str, include_homepass: bool, output_csv: str, cache_dir: str, job_id: str, user_id: str):
    from server.services.generator.core_logic import regenerate_cables_only
    try:
        await _update_generation_job(
            job_id, status="RUNNING", stage="STARTING", progress=2, error=None
        )
        await asyncio.to_thread(regenerate_cables_only, output_path, include_homepass, output_csv, cache_dir, job_id)

        await _publish_generation_artifacts(job_id, user_id, output_path, output_csv)
    except Exception as e:
        await _record_job_failure(job_id, e)
        raise

async def generate_custom_task(ctx, custom_path: str, output_kmz_path: str, include_homepass: bool, output_csv: str, cache_dir: str, job_id: str, user_id: str):
    from server.services.generator.core_logic import generate_cables_from_custom_points
    try:
        await _update_generation_job(
            job_id, status="RUNNING", stage="STARTING", progress=2, error=None
        )
        await asyncio.to_thread(generate_cables_from_custom_points, custom_path, output_kmz_path, include_homepass, output_csv, cache_dir, job_id)

        await _publish_generation_artifacts(job_id, user_id, output_kmz_path, output_csv)
    except Exception as e:
        await _record_job_failure(job_id, e)
        raise


async def generate_homepass_task(ctx, output_kmz_path: str, output_csv_path: str, cache_dir: str, job_id: str, user_id: str):
    """Create the optional HC/drop layer from the immutable core cache."""
    try:
        await _update_generation_job(
            job_id, status="RUNNING", stage="STARTING", progress=2, error=None
        )
        progress_manager.update(job_id, "STARTING", "Worker Homepass mulai memproses...", 2)
        await asyncio.to_thread(
            generate_homepass_from_state,
            output_kmz_path,
            output_csv_path,
            cache_dir,
            job_id,
        )
        await _publish_generation_artifacts(
            job_id,
            user_id,
            output_kmz_path,
            output_csv_path,
        )
    except Exception as e:
        await _record_job_failure(job_id, e)
        raise

async def startup(ctx):
    await asyncio.to_thread(get_object_storage().ensure_bucket)
    await db.connect()
    logger.info(
        "Worker starting up... generator_version=%s algorithm_version=%s",
        GENERATOR_VERSION,
        ALGORITHM_VERSION,
    )

async def shutdown(ctx):
    await db.disconnect()
    logger.info("Worker shutting down...")

class WorkerSettings:
    functions = [generate_task, regenerate_cables_task, generate_custom_task, generate_homepass_task]
    on_startup = startup
    on_shutdown = shutdown
    allow_abort_jobs = True
    redis_settings = RedisSettings.from_dsn(os.getenv("REDIS_URL", "redis://localhost:6379/0"))
    job_timeout = 3600  # 1 hour timeout for large generation tasks
    # Tune per worker container. Keep the default conservative because one
    # generation already creates OSM/routing threads of its own.
    max_jobs = max(1, int(os.getenv("ARQ_MAX_JOBS", "2")))
