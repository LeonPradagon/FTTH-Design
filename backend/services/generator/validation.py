"""Post-generation validation engine for FTTH network designs.

Runs a battery of checks against the generated design (ODC → ODP → customer
hierarchy) and returns a structured ``ValidationResult`` indicating whether
the design passes, has warnings, or contains blocking errors.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.services.generator.generation_config import GenerationConfig
from backend.services.generator.models import ODC
from backend.utils.geometry import haversine_m


# ── Result types ────────────────────────────────────────────────────


@dataclass
class ValidationIssue:
    """A single validation finding."""

    severity: str  # "ERROR" | "WARNING" | "INFO"
    code: str  # e.g. "ODP_OVER_CAPACITY"
    message: str
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
            "details": self.details,
        }


@dataclass
class ValidationResult:
    """Aggregated result of all validation checks."""

    status: str = "PASS"  # "PASS" | "WARNING" | "ERROR"
    issues: list[ValidationIssue] = field(default_factory=list)

    @property
    def summary(self) -> dict[str, int]:
        counts = {"errors": 0, "warnings": 0, "info": 0}
        for issue in self.issues:
            if issue.severity == "ERROR":
                counts["errors"] += 1
            elif issue.severity == "WARNING":
                counts["warnings"] += 1
            else:
                counts["info"] += 1
        return counts

    def _refresh_status(self) -> None:
        if any(i.severity == "ERROR" for i in self.issues):
            self.status = "ERROR"
        elif any(i.severity == "WARNING" for i in self.issues):
            self.status = "WARNING"
        else:
            self.status = "PASS"

    def add(self, issue: ValidationIssue) -> None:
        self.issues.append(issue)
        self._refresh_status()

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "issues": [i.to_dict() for i in self.issues],
            "summary": self.summary,
        }


# ── Individual validation rules ─────────────────────────────────────


def _validate_hierarchy(odcs: list[ODC], result: ValidationResult) -> None:
    """Check that every ODC has ODPs and every ODP has houses."""
    for odc in odcs:
        if not odc.odps:
            result.add(
                ValidationIssue(
                    severity="ERROR",
                    code="ODC_EMPTY",
                    message=f"ODC {odc.id} has no ODP assigned.",
                    details={"odc_id": odc.id},
                )
            )
        for odp in odc.odps:
            if not odp.houses:
                result.add(
                    ValidationIssue(
                        severity="WARNING",
                        code="ODP_EMPTY",
                        message=f"ODP {odp.id} (under ODC {odc.id}) has no houses assigned.",
                        details={"odp_id": odp.id, "odc_id": odc.id},
                    )
                )


def _validate_capacity(
    odcs: list[ODC], config: GenerationConfig, result: ValidationResult
) -> None:
    """Check ODP and ODC capacity limits."""
    for odc in odcs:
        if len(odc.odps) > config.odc_capacity:
            result.add(
                ValidationIssue(
                    severity="WARNING",
                    code="ODC_OVER_CAPACITY",
                    message=f"ODC {odc.id} serves {len(odc.odps)} ODPs (limit: {config.odc_capacity}).",
                    details={
                        "odc_id": odc.id,
                        "count": len(odc.odps),
                        "limit": config.odc_capacity,
                    },
                )
            )
        for odp in odc.odps:
            if len(odp.houses) > config.odp_capacity:
                result.add(
                    ValidationIssue(
                        severity="WARNING",
                        code="ODP_OVER_CAPACITY",
                        message=f"ODP {odp.id} serves {len(odp.houses)} houses (limit: {config.odp_capacity}).",
                        details={
                            "odp_id": odp.id,
                            "odc_id": odc.id,
                            "count": len(odp.houses),
                            "limit": config.odp_capacity,
                        },
                    )
                )


def _validate_radius(
    odcs: list[ODC], config: GenerationConfig, result: ValidationResult
) -> None:
    """Check that no device exceeds its configured radius."""
    for odc in odcs:
        for odp in odc.odps:
            # ODP → house radius
            for i, (h_lat, h_lon) in enumerate(odp.houses):
                dist = haversine_m(odp.lat, odp.lon, h_lat, h_lon)
                if dist > config.max_odp_radius_m:
                    result.add(
                        ValidationIssue(
                            severity="WARNING",
                            code="ODP_RADIUS_EXCEEDED",
                            message=(
                                f"ODP {odp.id}: house #{i+1} is {dist:.0f}m away "
                                f"(limit: {config.max_odp_radius_m:.0f}m)."
                            ),
                            details={
                                "odp_id": odp.id,
                                "house_index": i,
                                "distance_m": round(dist, 1),
                                "limit_m": config.max_odp_radius_m,
                            },
                        )
                    )

            # ODC → ODP radius
            odp_dist = haversine_m(odc.lat, odc.lon, odp.lat, odp.lon)
            if odp_dist > config.max_odc_radius_m:
                result.add(
                    ValidationIssue(
                        severity="WARNING",
                        code="ODC_RADIUS_EXCEEDED",
                        message=(
                            f"ODC {odc.id} → ODP {odp.id} distance is {odp_dist:.0f}m "
                            f"(limit: {config.max_odc_radius_m:.0f}m)."
                        ),
                        details={
                            "odc_id": odc.id,
                            "odp_id": odp.id,
                            "distance_m": round(odp_dist, 1),
                            "limit_m": config.max_odc_radius_m,
                        },
                    )
                )


def _validate_duplicate_assignments(
    odcs: list[ODC], result: ValidationResult
) -> None:
    """Ensure no house coordinate appears in more than one ODP."""
    seen: dict[tuple[float, float], str] = {}
    for odc in odcs:
        for odp in odc.odps:
            for h_lat, h_lon in odp.houses:
                key = (round(h_lat, 8), round(h_lon, 8))
                if key in seen:
                    result.add(
                        ValidationIssue(
                            severity="ERROR",
                            code="DUPLICATE_ASSIGNMENT",
                            message=(
                                f"House at ({h_lat:.6f}, {h_lon:.6f}) is assigned to "
                                f"both {seen[key]} and {odp.id}."
                            ),
                            details={
                                "lat": h_lat,
                                "lon": h_lon,
                                "odp_1": seen[key],
                                "odp_2": odp.id,
                            },
                        )
                    )
                else:
                    seen[key] = odp.id


def _validate_connectivity(
    pop: dict, odcs: list[ODC], feeder_segments: list | None, result: ValidationResult
) -> None:
    """Basic connectivity: every ODC should be reachable from the POP."""
    if feeder_segments is None:
        return
    # Feeder segments connect POP → ODC chain.  If the list is shorter than
    # the ODC count, some ODCs may be disconnected.
    connected_odc_count = len(feeder_segments)
    if connected_odc_count < len(odcs):
        result.add(
            ValidationIssue(
                severity="ERROR",
                code="DISCONNECTED_ODC",
                message=(
                    f"Only {connected_odc_count} of {len(odcs)} ODCs are connected "
                    f"by feeder segments."
                ),
                details={
                    "connected": connected_odc_count,
                    "total": len(odcs),
                },
            )
        )


# ── Public API ──────────────────────────────────────────────────────


def validate_design(
    pop: dict,
    odcs: list[ODC],
    config: GenerationConfig,
    feeder_segments: list | None = None,
) -> ValidationResult:
    """Run all validation checks and return the aggregated result."""
    result = ValidationResult()

    _validate_hierarchy(odcs, result)
    _validate_capacity(odcs, config, result)
    _validate_radius(odcs, config, result)
    _validate_duplicate_assignments(odcs, result)
    _validate_connectivity(pop, odcs, feeder_segments, result)

    return result


def compute_design_stats(
    pop: dict,
    odcs: list[ODC],
    feeder_segments: list | None = None,
) -> dict[str, Any]:
    """Compute summary statistics for the generated design."""
    total_odp = sum(len(odc.odps) for odc in odcs)
    total_houses = sum(len(odp.houses) for odc in odcs for odp in odc.odps)

    # Feeder length (sum of segment distances)
    total_feeder_m = 0.0
    if feeder_segments:
        for seg in feeder_segments:
            if isinstance(seg, (list, tuple)) and len(seg) >= 2:
                coords = seg
                for i in range(len(coords) - 1):
                    if isinstance(coords[i], (list, tuple)) and isinstance(
                        coords[i + 1], (list, tuple)
                    ):
                        total_feeder_m += haversine_m(
                            coords[i][0],
                            coords[i][1],
                            coords[i + 1][0],
                            coords[i + 1][1],
                        )

    odc_stats = []
    for odc in odcs:
        odc_stats.append({
            "odc_id": odc.id,
            "odp_count": len(odc.odps),
            "house_count": sum(len(odp.houses) for odp in odc.odps)
        })

    return {
        "odc_count": len(odcs),
        "odp_count": total_odp,
        "customer_count": total_houses,
        "feeder_length_km": round(total_feeder_m / 1000, 2),
        "odc_stats": odc_stats,
    }
