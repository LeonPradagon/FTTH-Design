"""Offline OpenStreetMap provider backed by the local PostGIS database.

The importer writes a versioned dataset into ``osm_data``.  Generation only
reads the active dataset, so a failed weekly import cannot produce a mixed or
partially refreshed design.
"""

from __future__ import annotations

import os
import ast
import json
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import networkx as nx
from shapely import wkb
from shapely.geometry import Point
from shapely.ops import unary_union

from server.core.errors import OSMUnavailableError
from server.core.logging import logger
from server.services.generator.routing import prepare_road_graph


SCHEMA = "osm_data"
SCHEMA_VERSION = 1


def _database_url() -> str:
    """Return a psycopg-compatible DATABASE_URL.

    Prisma appends ``schema=public`` to the URL.  It is useful for Prisma but
    is not a libpq connection option, so remove it for direct PostGIS access.
    """
    raw = os.getenv("DATABASE_URL", "")
    if not raw:
        raise OSMUnavailableError(message="DATABASE_URL belum dikonfigurasi untuk provider OSM lokal.")
    parts = urlsplit(raw)
    query = [(key, value) for key, value in parse_qsl(parts.query) if key != "schema"]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _connect():
    try:
        import psycopg
    except ImportError as exc:  # pragma: no cover - deployment dependency guard
        raise OSMUnavailableError(
            message="Dependency psycopg belum terpasang untuk provider OSM lokal."
        ) from exc
    try:
        return psycopg.connect(_database_url())
    except Exception as exc:
        raise OSMUnavailableError(
            message=f"Database OSM lokal tidak dapat dihubungi: {exc}",
        ) from exc


def ensure_schema(connection=None):
    """Create the versioned offline OSM tables and spatial indexes."""
    owns_connection = connection is None
    connection = connection or _connect()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f"""
                CREATE EXTENSION IF NOT EXISTS postgis;
                CREATE SCHEMA IF NOT EXISTS {SCHEMA};
                CREATE TABLE IF NOT EXISTS {SCHEMA}.dataset (
                    dataset_id TEXT PRIMARY KEY,
                    schema_version INTEGER NOT NULL DEFAULT {SCHEMA_VERSION},
                    source_url TEXT NOT NULL,
                    source_timestamp TIMESTAMPTZ,
                    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    checksum TEXT,
                    status TEXT NOT NULL CHECK (status IN ('staging', 'active', 'failed')),
                    coverage geometry(Polygon, 4326) NOT NULL,
                    building_count INTEGER NOT NULL DEFAULT 0,
                    road_node_count INTEGER NOT NULL DEFAULT 0,
                    road_edge_count INTEGER NOT NULL DEFAULT 0,
                    poi_count INTEGER NOT NULL DEFAULT 0
                );
                CREATE UNIQUE INDEX IF NOT EXISTS dataset_one_active
                    ON {SCHEMA}.dataset ((status)) WHERE status = 'active';

                CREATE TABLE IF NOT EXISTS {SCHEMA}.building (
                    dataset_id TEXT NOT NULL REFERENCES {SCHEMA}.dataset(dataset_id) ON DELETE CASCADE,
                    osm_id BIGINT NOT NULL,
                    geom geometry(Geometry, 4326) NOT NULL,
                    PRIMARY KEY (dataset_id, osm_id)
                );
                CREATE INDEX IF NOT EXISTS building_geom_gix
                    ON {SCHEMA}.building USING GIST (geom);
                CREATE INDEX IF NOT EXISTS building_dataset_idx
                    ON {SCHEMA}.building (dataset_id);

                CREATE TABLE IF NOT EXISTS {SCHEMA}.road_node (
                    dataset_id TEXT NOT NULL REFERENCES {SCHEMA}.dataset(dataset_id) ON DELETE CASCADE,
                    node_id BIGINT NOT NULL,
                    geom geometry(Point, 4326) NOT NULL,
                    PRIMARY KEY (dataset_id, node_id)
                );
                CREATE INDEX IF NOT EXISTS road_node_geom_gix
                    ON {SCHEMA}.road_node USING GIST (geom);
                CREATE INDEX IF NOT EXISTS road_node_dataset_idx
                    ON {SCHEMA}.road_node (dataset_id);

                CREATE TABLE IF NOT EXISTS {SCHEMA}.road_edge (
                    dataset_id TEXT NOT NULL REFERENCES {SCHEMA}.dataset(dataset_id) ON DELETE CASCADE,
                    edge_id TEXT NOT NULL,
                    source_node BIGINT NOT NULL,
                    target_node BIGINT NOT NULL,
                    edge_index INTEGER NOT NULL DEFAULT 0,
                    geom geometry(LineString, 4326) NOT NULL,
                    highway TEXT,
                    length_m DOUBLE PRECISION,
                    oneway BOOLEAN,
                    name TEXT,
                    PRIMARY KEY (dataset_id, edge_id, edge_index)
                );
                CREATE INDEX IF NOT EXISTS road_edge_geom_gix
                    ON {SCHEMA}.road_edge USING GIST (geom);
                CREATE INDEX IF NOT EXISTS road_edge_dataset_idx
                    ON {SCHEMA}.road_edge (dataset_id);
                CREATE INDEX IF NOT EXISTS road_edge_nodes_idx
                    ON {SCHEMA}.road_edge (dataset_id, source_node, target_node);

                CREATE TABLE IF NOT EXISTS {SCHEMA}.poi (
                    dataset_id TEXT NOT NULL REFERENCES {SCHEMA}.dataset(dataset_id) ON DELETE CASCADE,
                    poi_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    name TEXT,
                    geom geometry(Geometry, 4326) NOT NULL,
                    PRIMARY KEY (dataset_id, poi_id)
                );
                CREATE INDEX IF NOT EXISTS poi_geom_gix
                    ON {SCHEMA}.poi USING GIST (geom);
                CREATE INDEX IF NOT EXISTS poi_dataset_kind_idx
                    ON {SCHEMA}.poi (dataset_id, kind);
                """
            )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        if owns_connection:
            connection.close()


def get_active_dataset(connection=None) -> dict[str, Any] | None:
    owns_connection = connection is None
    connection = connection or _connect()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT dataset_id, source_url, source_timestamp, imported_at,
                       checksum, building_count, road_node_count, road_edge_count,
                       poi_count, ST_AsBinary(coverage) AS coverage_wkb
                FROM {SCHEMA}.dataset
                WHERE status = 'active'
                LIMIT 1
                """
            )
            row = cursor.fetchone()
            if row is None:
                return None
            columns = [description.name for description in cursor.description]
            result = dict(zip(columns, row))
            if result.get("coverage_wkb"):
                result["coverage"] = wkb.loads(bytes(result.pop("coverage_wkb")))
            return result
    except Exception as exc:
        if isinstance(exc, OSMUnavailableError):
            raise
        raise OSMUnavailableError(message=f"Metadata dataset OSM lokal tidak dapat dibaca: {exc}") from exc
    finally:
        if owns_connection:
            connection.close()


def active_dataset_for_boundary(boundary) -> dict[str, Any]:
    """Return the active dataset when its declared coverage contains boundary."""
    dataset = get_active_dataset()
    if not dataset:
        raise OSMUnavailableError(
            message="Belum ada dataset OSM lokal yang aktif. Import OSM PBF terlebih dahulu."
        )
    coverage = dataset.get("coverage")
    if coverage is not None and not coverage.covers(boundary):
        raise OSMUnavailableError(
            message=(
                f"Boundary berada di luar cakupan dataset OSM lokal {dataset['dataset_id']}. "
                "Jalankan update/import PBF dengan cakupan yang sesuai."
            ),
            details={"dataset_id": dataset["dataset_id"]},
        )
    return dataset


def source_metadata(boundary) -> dict[str, Any]:
    dataset = active_dataset_for_boundary(boundary)
    return {
        "source": "osm_postgis",
        "dataset_id": dataset["dataset_id"],
        "timestamp": _iso_timestamp(dataset.get("source_timestamp")),
        "reason": "boundary memakai dataset OSM lokal",
    }


def _iso_timestamp(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    return str(value)


def _load_geometries(rows):
    geometries = []
    for row in rows:
        value = row[0] if isinstance(row, (tuple, list)) else row
        if value is not None:
            geometries.append(wkb.loads(bytes(value)))
    return geometries


def fetch_houses_in_boundary(boundary, force_refresh=False):
    """Read building footprints from the active local OSM dataset."""
    del force_refresh
    dataset = active_dataset_for_boundary(boundary)
    connection = _connect()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT ST_AsBinary(geom)
                FROM {SCHEMA}.building
                WHERE dataset_id = %s
                  AND geom && ST_GeomFromText(%s, 4326)
                  AND ST_Intersects(geom, ST_GeomFromText(%s, 4326))
                """,
                (dataset["dataset_id"], boundary.wkt, boundary.wkt),
            )
            geometries = _load_geometries(cursor.fetchall())
    except Exception as exc:
        raise OSMUnavailableError(message=f"Bangunan OSM lokal tidak dapat dibaca: {exc}") from exc
    finally:
        connection.close()

    houses = []
    seen = set()
    for geometry in geometries:
        if geometry.is_empty or not geometry.intersects(boundary):
            continue
        candidate = geometry.centroid
        if not boundary.covers(candidate):
            clipped = geometry.intersection(boundary)
            if clipped.is_empty:
                continue
            candidate = clipped.representative_point()
        key = (round(candidate.y, 7), round(candidate.x, 7))
        if boundary.covers(candidate) and key not in seen:
            seen.add(key)
            houses.append(key)
    return houses


def _parse_highway(value):
    if isinstance(value, (list, tuple, set)):
        return list(value)
    if not isinstance(value, str):
        return value
    try:
        parsed = json.loads(value)
        if isinstance(parsed, list):
            return parsed
    except (TypeError, ValueError):
        pass
    try:
        parsed = ast.literal_eval(value)
        if isinstance(parsed, (list, tuple, set)):
            return list(parsed)
    except (SyntaxError, ValueError):
        pass
    return value


def fetch_road_graph(boundary, pop=None, buffer_deg=0.002, force_refresh=False, include_pop=True):
    """Build a NetworkX graph from only the local OSM road window."""
    del force_refresh
    dataset = active_dataset_for_boundary(boundary)
    geometries = [boundary]
    if include_pop and pop is not None:
        geometries.append(Point(pop["lon"], pop["lat"]))
    query_geometry = unary_union(geometries).convex_hull
    connection = _connect()
    graph = nx.MultiDiGraph()
    graph.graph["ftth_data_source"] = "osm_postgis"
    graph.graph["ftth_dataset_id"] = dataset["dataset_id"]
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT e.edge_id, e.source_node, e.target_node, e.edge_index,
                       ST_AsBinary(e.geom) AS geom_wkb, e.highway, e.length_m,
                       e.oneway, e.name,
                       ST_X(n1.geom) AS source_x, ST_Y(n1.geom) AS source_y,
                       ST_X(n2.geom) AS target_x, ST_Y(n2.geom) AS target_y
                FROM {SCHEMA}.road_edge e
                JOIN {SCHEMA}.road_node n1
                  ON n1.dataset_id = e.dataset_id AND n1.node_id = e.source_node
                JOIN {SCHEMA}.road_node n2
                  ON n2.dataset_id = e.dataset_id AND n2.node_id = e.target_node
                WHERE e.dataset_id = %s
                  AND e.geom && ST_Expand(ST_GeomFromText(%s, 4326), %s)
                  AND ST_Intersects(e.geom, ST_Expand(ST_GeomFromText(%s, 4326), %s))
                """,
                (
                    dataset["dataset_id"],
                    query_geometry.wkt,
                    buffer_deg,
                    query_geometry.wkt,
                    buffer_deg,
                ),
            )
            rows = cursor.fetchall()
    except Exception as exc:
        raise OSMUnavailableError(message=f"Jaringan jalan OSM lokal tidak dapat dibaca: {exc}") from exc
    finally:
        connection.close()

    for row in rows:
        (
            edge_id,
            source_node,
            target_node,
            edge_index,
            geom_wkb,
            highway,
            length_m,
            oneway,
            name,
            source_x,
            source_y,
            target_x,
            target_y,
        ) = row
        if not geom_wkb:
            continue
        geometry = wkb.loads(bytes(geom_wkb))
        if geometry.is_empty:
            continue
        if geometry.geom_type == "MultiLineString":
            geometry = max(geometry.geoms, key=lambda item: item.length)
        graph.add_node(source_node, x=float(source_x), y=float(source_y))
        graph.add_node(target_node, x=float(target_x), y=float(target_y))
        graph.add_edge(
            source_node,
            target_node,
            key=edge_index,
            geometry=geometry,
            highway=_parse_highway(highway),
            length=float(length_m or 0.0),
            oneway=bool(oneway) if oneway is not None else False,
            name=name,
        )

    if graph.number_of_edges() == 0:
        raise OSMUnavailableError(
            message=(
                f"Tidak ada jaringan jalan kendaraan pada boundary dari dataset OSM lokal "
                f"{dataset['dataset_id']}."
            ),
            details={"dataset_id": dataset["dataset_id"]},
        )
    return prepare_road_graph(graph)


def find_strategic_pop(boundary, buffer_deg=0.01):
    """Find a POP candidate from locally imported OSM POIs or road nodes."""
    dataset = active_dataset_for_boundary(boundary)
    search_area = boundary.buffer(buffer_deg)
    connection = _connect()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT kind, name, ST_AsBinary(geom)
                FROM {SCHEMA}.poi
                WHERE dataset_id = %s
                  AND kind IN ('station', 'office', 'main_road', 'road')
                  AND geom && ST_GeomFromText(%s, 4326)
                  AND ST_Intersects(geom, ST_GeomFromText(%s, 4326))
                ORDER BY CASE kind
                    WHEN 'station' THEN 1
                    WHEN 'office' THEN 2
                    WHEN 'main_road' THEN 3
                    ELSE 4 END,
                    poi_id
                LIMIT 1
                """,
                (dataset["dataset_id"], search_area.wkt, search_area.wkt),
            )
            row = cursor.fetchone()
            if row:
                kind, name, geom_wkb = row
                point = wkb.loads(bytes(geom_wkb)).representative_point()
                return {
                    "name": name or f"POP OSM lokal ({kind})",
                    "lon": point.x,
                    "lat": point.y,
                }

            cursor.execute(
                f"""
                SELECT ST_X(geom), ST_Y(geom)
                FROM {SCHEMA}.road_node
                WHERE dataset_id = %s
                  AND geom && ST_GeomFromText(%s, 4326)
                  AND ST_Intersects(geom, ST_GeomFromText(%s, 4326))
                ORDER BY geom <-> ST_Centroid(ST_GeomFromText(%s, 4326))
                LIMIT 1
                """,
                (dataset["dataset_id"], search_area.wkt, search_area.wkt, search_area.wkt),
            )
            row = cursor.fetchone()
            if row:
                lon, lat = row
                return {"name": "POP OSM lokal (node jalan)", "lon": lon, "lat": lat}
    except Exception as exc:
        logger.info("Pencarian POP OSM lokal gagal: %s", exc)
    finally:
        connection.close()

    return {
        "name": "Auto POP (Titik Tengah)",
        "lon": boundary.centroid.x,
        "lat": boundary.centroid.y,
    }
