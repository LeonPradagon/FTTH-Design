"""Import an OSM PBF snapshot into the versioned local PostGIS provider.

This command is intentionally separate from generation.  It can be run by a
weekly scheduler and only promotes the new snapshot after all rows are
imported successfully.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from shapely.geometry import LineString, Point
from shapely.ops import linemerge

from server.services.generator.osm_postgis import ensure_schema, _connect


DEFAULT_SOURCE_URL = "https://download.geofabrik.de/asia/indonesia-latest.osm.pbf"
DEFAULT_COVERAGE = (94.0, -11.5, 141.5, 6.5)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _value(row, names, default=None):
    for name in names:
        if name in row:
            return row[name]
    return default


def _as_int(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_bool(value):
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _present(value) -> bool:
    if value is None:
        return False
    if isinstance(value, float) and math.isnan(value):
        return False
    return str(value).strip().lower() not in {"", "nan", "none"}


def _geometry_parts(geometry) -> Iterable:
    if geometry is None or geometry.is_empty:
        return []
    if geometry.geom_type == "MultiLineString":
        return list(geometry.geoms)
    return [geometry]


def _insert_many(connection, statement: str, rows: list[tuple], chunk_size=2000):
    if not rows:
        return
    with connection.cursor() as cursor:
        for start in range(0, len(rows), chunk_size):
            cursor.executemany(statement, rows[start:start + chunk_size])
            connection.commit()


def _import_buildings(connection, dataset_id: str, buildings) -> int:
    rows = []
    for index, row in buildings.iterrows():
        osm_id = _as_int(_value(row, ("id", "osm_id")), index)
        geometry = row.get("geometry")
        if geometry is None or geometry.is_empty:
            continue
        rows.append((dataset_id, osm_id, bytes(geometry.wkb)))
    _insert_many(
        connection,
        """
        INSERT INTO osm_data.building (dataset_id, osm_id, geom)
        VALUES (%s, %s, ST_GeomFromWKB(%s, 4326))
        ON CONFLICT (dataset_id, osm_id) DO NOTHING
        """,
        rows,
    )
    return len(rows)


def _node_rows(dataset_id: str, nodes) -> list[tuple]:
    rows = []
    for index, row in nodes.iterrows():
        node_id = _as_int(_value(row, ("id", "node_id", "osm_id")), index)
        geometry = row.get("geometry")
        if geometry is None or geometry.is_empty:
            x = _as_float(_value(row, ("x", "lon", "longitude")))
            y = _as_float(_value(row, ("y", "lat", "latitude")))
            if x is None or y is None:
                continue
            geometry = Point(x, y)
        if geometry.geom_type != "Point":
            geometry = geometry.representative_point()
        rows.append((dataset_id, node_id, bytes(geometry.wkb)))
    return rows


def _edge_rows(dataset_id: str, edges) -> list[tuple]:
    rows = []
    for index, row in edges.iterrows():
        source = _as_int(_value(row, ("u", "source", "source_node", "from")))
        target = _as_int(_value(row, ("v", "target", "target_node", "to")))
        geometry = row.get("geometry")
        if source is None or target is None or geometry is None or geometry.is_empty:
            continue
        base_id = _value(row, ("id", "way_id", "edge_id"), index)
        edge_identity = f"{base_id}:{index}"
        highway = _value(row, ("highway", "highway_type"))
        if isinstance(highway, (tuple, set)):
            highway = list(highway)
        highway_value = json.dumps(highway) if isinstance(highway, list) else highway
        length_m = _as_float(_value(row, ("length", "length_m")))
        oneway = _as_bool(_value(row, ("oneway",)))
        name = _value(row, ("name",))
        for part_index, part in enumerate(_geometry_parts(geometry)):
            if part.geom_type != "LineString" or len(part.coords) < 2:
                continue
            rows.append(
                (
                    dataset_id,
                    edge_identity,
                    source,
                    target,
                    part_index,
                    bytes(part.wkb),
                    highway_value,
                    length_m,
                    oneway,
                    name,
                )
            )
    return rows


def _poi_rows(dataset_id: str, pois) -> list[tuple]:
    rows = []
    for index, row in pois.iterrows():
        geometry = row.get("geometry")
        if geometry is None or geometry.is_empty:
            continue
        kind = None
        if _present(row.get("railway")) or row.get("building") == "train_station":
            kind = "station"
        elif _present(row.get("office")) or row.get("building") == "office":
            kind = "office"
        elif row.get("highway") in {"primary", "secondary", "trunk", "tertiary"}:
            kind = "main_road"
        if not kind:
            continue
        poi_id = str(_value(row, ("id", "osm_id"), index))
        point = geometry if geometry.geom_type == "Point" else geometry.representative_point()
        rows.append((dataset_id, poi_id, kind, _value(row, ("name",)), bytes(point.wkb)))
    return rows


def _parse_coverage(value: str):
    values = [float(item.strip()) for item in value.split(",")]
    if len(values) != 4:
        raise ValueError("coverage harus berupa min_lon,min_lat,max_lon,max_lat")
    return values


def _pbf_source_timestamp(pbf_path: Path) -> datetime:
    """Prefer the source timestamp recorded by the atomic downloader."""
    metadata_path = Path(f"{pbf_path}.meta.json")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        value = metadata.get("source_timestamp")
        if value:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        pass
    return datetime.fromtimestamp(pbf_path.stat().st_mtime, timezone.utc)


def import_pbf(
    pbf_path: Path,
    dataset_id: str,
    source_url: str,
    source_timestamp: datetime,
    coverage: tuple[float, float, float, float],
    include_pois: bool = True,
    bounding_box: tuple[float, float, float, float] | None = None,
) -> dict:
    try:
        from pyrosm import OSM
    except ImportError as exc:
        raise RuntimeError("Pyrosm belum terpasang di image importer.") from exc

    connection = _connect()
    ensure_schema(connection)
    checksum = _sha256(pbf_path)
    staging_created = False
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT status FROM osm_data.dataset WHERE dataset_id = %s",
                (dataset_id,),
            )
            existing = cursor.fetchone()
            if existing and existing[0] == "active":
                raise RuntimeError(f"Dataset OSM {dataset_id} sudah aktif; gunakan dataset-id baru.")
            if existing:
                cursor.execute("DELETE FROM osm_data.dataset WHERE dataset_id = %s", (dataset_id,))
            cursor.execute(
                """
                INSERT INTO osm_data.dataset
                    (dataset_id, source_url, source_timestamp, checksum, status, coverage)
                VALUES (%s, %s, %s, %s, 'staging', ST_MakeEnvelope(%s, %s, %s, %s, 4326))
                """,
                (dataset_id, source_url, source_timestamp, checksum, *coverage),
            )
            connection.commit()
            staging_created = True

        try:
            import_workers = max(1, int(os.getenv("OSM_IMPORT_WORKERS", "1")))
        except ValueError:
            import_workers = 1
        # A full-country extract is memory intensive. One out-of-core worker
        # is slower but avoids multiplying Pyrosm memory usage inside Docker.
        osm = OSM(
            str(pbf_path),
            bounding_box=list(bounding_box) if bounding_box else None,
            engine="out_of_core",
            workers=import_workers,
            keep_metadata=False,
        )
        buildings = osm.get_buildings()
        building_count = _import_buildings(connection, dataset_id, buildings)
        del buildings

        nodes, edges = osm.get_network("driving", nodes=True)
        node_rows = _node_rows(dataset_id, nodes)
        _insert_many(
            connection,
            """
            INSERT INTO osm_data.road_node (dataset_id, node_id, geom)
            VALUES (%s, %s, ST_GeomFromWKB(%s, 4326))
            ON CONFLICT (dataset_id, node_id) DO NOTHING
            """,
            node_rows,
        )
        edge_rows = _edge_rows(dataset_id, edges)
        _insert_many(
            connection,
            """
            INSERT INTO osm_data.road_edge
                (dataset_id, edge_id, source_node, target_node, edge_index, geom,
                 highway, length_m, oneway, name)
            VALUES (%s, %s, %s, %s, %s, ST_GeomFromWKB(%s, 4326), %s, %s, %s, %s)
            ON CONFLICT (dataset_id, edge_id, edge_index) DO NOTHING
            """,
            edge_rows,
        )
        del nodes, edges

        if building_count <= 0:
            raise RuntimeError("Import OSM PBF tidak memiliki building; dataset tidak diaktifkan.")
        if not node_rows or not edge_rows:
            raise RuntimeError("Import OSM PBF tidak memiliki road node/edge; dataset tidak diaktifkan.")

        poi_rows = []
        if include_pois:
            try:
                pois = osm.get_pois(custom_filter={"railway": True, "office": True, "building": True})
                poi_rows = _poi_rows(dataset_id, pois)
                _insert_many(
                    connection,
                    """
                    INSERT INTO osm_data.poi (dataset_id, poi_id, kind, name, geom)
                    VALUES (%s, %s, %s, %s, ST_GeomFromWKB(%s, 4326))
                    ON CONFLICT (dataset_id, poi_id) DO NOTHING
                    """,
                    poi_rows,
                )
            except Exception as exc:
                print(f"Peringatan: POI tidak berhasil diimport, lanjut tanpa POI: {exc}", file=sys.stderr)

        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE osm_data.dataset
                SET building_count = %s,
                    road_node_count = %s,
                    road_edge_count = %s,
                    poi_count = %s
                WHERE dataset_id = %s
                """,
                (building_count, len(node_rows), len(edge_rows), len(poi_rows), dataset_id),
            )
            cursor.execute(
                "UPDATE osm_data.dataset SET status = 'failed' WHERE status = 'active' AND dataset_id <> %s",
                (dataset_id,),
            )
            cursor.execute("UPDATE osm_data.dataset SET status = 'active' WHERE dataset_id = %s", (dataset_id,))
            connection.commit()
        return {
            "dataset_id": dataset_id,
            "checksum": checksum,
            "building_count": building_count,
            "road_node_count": len(node_rows),
            "road_edge_count": len(edge_rows),
            "poi_count": len(poi_rows),
        }
    except Exception:
        connection.rollback()
        if staging_created:
            with connection.cursor() as cursor:
                cursor.execute("UPDATE osm_data.dataset SET status = 'failed' WHERE dataset_id = %s", (dataset_id,))
                connection.commit()
        raise
    finally:
        connection.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pbf", type=Path, required=True)
    parser.add_argument("--dataset-id", default=datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    parser.add_argument("--source-url", default=os.getenv("OSM_PBF_URL", DEFAULT_SOURCE_URL))
    parser.add_argument("--source-timestamp", type=str)
    parser.add_argument(
        "--coverage",
        help="Cakupan dataset: min_lon,min_lat,max_lon,max_lat",
    )
    parser.add_argument(
        "--bbox",
        help="Batasi parsing PBF ke wilayah: min_lon,min_lat,max_lon,max_lat",
    )
    parser.add_argument("--without-pois", action="store_true")
    args = parser.parse_args(argv)
    if not args.pbf.exists():
        parser.error(f"PBF tidak ditemukan: {args.pbf}")
    bounding_box = tuple(_parse_coverage(args.bbox)) if args.bbox else None
    coverage_value = args.coverage or os.getenv("OSM_PBF_COVERAGE", ",".join(map(str, DEFAULT_COVERAGE)))
    coverage = tuple(_parse_coverage(coverage_value))
    timestamp = (
        datetime.fromisoformat(args.source_timestamp.replace("Z", "+00:00"))
        if args.source_timestamp
        else _pbf_source_timestamp(args.pbf)
    )
    result = import_pbf(
        args.pbf,
        args.dataset_id,
        args.source_url,
        timestamp,
        coverage,
        include_pois=not args.without_pois,
        bounding_box=bounding_box,
    )
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
