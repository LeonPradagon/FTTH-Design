"""FTTH Design Generator — structured error hierarchy.

Every exception carries a machine-readable ``code`` that the global error
handler in *main.py* translates into a JSON response envelope.  This lets
callers (frontend, CLI) switch on ``error.code`` instead of parsing free-text
messages.
"""

from __future__ import annotations

from typing import Any


class FTTHError(Exception):
    """Base class for all FTTH Design Generator errors."""

    code: str = "INTERNAL_ERROR"
    http_status: int = 500

    def __init__(
        self,
        message: str = "An internal error occurred.",
        details: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.message = message
        self.details = details or {}


# ── File / Input errors (4xx) ───────────────────────────────────────


class InvalidFileError(FTTHError):
    """Uploaded file cannot be parsed or is of the wrong type."""

    code = "INVALID_FILE"
    http_status = 400


class InvalidGeometryError(FTTHError):
    """Geometry inside the uploaded file is malformed."""

    code = "INVALID_GEOMETRY"
    http_status = 400


class InvalidBoundaryError(FTTHError):
    """Boundary polygon is invalid (self-intersecting, empty, too large, …)."""

    code = "INVALID_BOUNDARY"
    http_status = 400


class NoCustomerFoundError(FTTHError):
    """No buildings / customers were found inside the specified boundary."""

    code = "NO_CUSTOMER_FOUND"
    http_status = 404


# ── Processing errors (5xx) ─────────────────────────────────────────


class ClusteringFailedError(FTTHError):
    """Clustering algorithm failed to produce a valid design."""

    code = "CLUSTERING_FAILED"
    http_status = 500


class RoutingFailedError(FTTHError):
    """Route calculation between two network nodes failed."""

    code = "ROUTING_FAILED"
    http_status = 500


class ExportFailedError(FTTHError):
    """KMZ / CSV / GeoJSON export failed."""

    code = "EXPORT_FAILED"
    http_status = 500


class OSMUnavailableError(FTTHError):
    """OpenStreetMap data could not be fetched (network / rate-limit)."""

    code = "OSM_UNAVAILABLE"
    http_status = 503


class DesignStateNotFoundError(FTTHError):
    """No cached design state exists for the requested regeneration."""

    code = "DESIGN_STATE_NOT_FOUND"
    http_status = 404


class RoadGraphUnavailableError(FTTHError):
    """Road graph is not available (cache miss + OSM fetch failure)."""

    code = "ROAD_GRAPH_UNAVAILABLE"
    http_status = 503


class PopTooFarError(FTTHError):
    """The uploaded POP/OLT location is too far from the boundary."""

    code = "POP_TOO_FAR"
    http_status = 400


# ── Convenience mapping ─────────────────────────────────────────────

ERROR_CODE_MAP: dict[str, type[FTTHError]] = {
    cls.code: cls  # type: ignore[attr-defined]
    for cls in FTTHError.__subclasses__()
}
