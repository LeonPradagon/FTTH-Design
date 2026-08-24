"""Standardised API response envelope.

Every endpoint wraps its result through ``success_response`` or
``error_response`` so that the frontend always receives a predictable shape::

    {
        "success": true,
        "data": { ... },
        "meta": { ... }          // optional
    }

    {
        "success": false,
        "error": {
            "code": "ROUTING_FAILED",
            "message": "Unable to calculate route",
            "details": { ... }   // optional
        }
    }
"""

from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse


def success_response(
    data: Any = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a successful JSON envelope (returned as-is by FastAPI)."""
    payload: dict[str, Any] = {"success": True, "data": data}
    if meta is not None:
        payload["meta"] = meta
    return payload


def error_response(
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
    http_status: int = 500,
) -> JSONResponse:
    """Build a JSON error response with the correct HTTP status code."""
    content: dict[str, Any] = {
        "success": False,
        "error": {
            "code": code,
            "message": message,
        },
    }
    if details:
        content["error"]["details"] = details
    return JSONResponse(status_code=http_status, content=content)
