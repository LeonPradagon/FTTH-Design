"""Tests for the error hierarchy and response envelope helpers."""

import pytest
from fastapi.responses import JSONResponse

from backend.core.errors import (
    FTTHError,
    InvalidFileError,
    InvalidGeometryError,
    InvalidBoundaryError,
    NoCustomerFoundError,
    ClusteringFailedError,
    RoutingFailedError,
    ExportFailedError,
    OSMUnavailableError,
    DesignStateNotFoundError,
    RoadGraphUnavailableError,
    PopTooFarError,
    ERROR_CODE_MAP,
)
from backend.core.response import success_response, error_response


class TestFTTHErrorHierarchy:
    def test_base_error(self):
        err = FTTHError("test")
        assert err.code == "INTERNAL_ERROR"
        assert err.http_status == 500
        assert err.message == "test"
        assert err.details == {}

    def test_invalid_file_error(self):
        err = InvalidFileError("bad file", details={"filename": "test.xyz"})
        assert err.code == "INVALID_FILE"
        assert err.http_status == 400
        assert err.details == {"filename": "test.xyz"}

    def test_no_customer_found_error(self):
        err = NoCustomerFoundError("no houses")
        assert err.code == "NO_CUSTOMER_FOUND"
        assert err.http_status == 404

    def test_osm_unavailable_error(self):
        err = OSMUnavailableError("timeout")
        assert err.code == "OSM_UNAVAILABLE"
        assert err.http_status == 503

    def test_pop_too_far_error(self):
        err = PopTooFarError("too far", details={"distance_m": 5000})
        assert err.code == "POP_TOO_FAR"
        assert err.http_status == 400

    def test_all_subclasses_inherit_ftth_error(self):
        subclasses = [
            InvalidFileError,
            InvalidGeometryError,
            InvalidBoundaryError,
            NoCustomerFoundError,
            ClusteringFailedError,
            RoutingFailedError,
            ExportFailedError,
            OSMUnavailableError,
            DesignStateNotFoundError,
            RoadGraphUnavailableError,
            PopTooFarError,
        ]
        for cls in subclasses:
            assert issubclass(cls, FTTHError)

    def test_error_code_map(self):
        assert "INVALID_FILE" in ERROR_CODE_MAP
        assert ERROR_CODE_MAP["INVALID_FILE"] is InvalidFileError
        assert "ROUTING_FAILED" in ERROR_CODE_MAP
        assert ERROR_CODE_MAP["ROUTING_FAILED"] is RoutingFailedError

    def test_all_codes_unique(self):
        codes = [cls.code for cls in FTTHError.__subclasses__()]
        assert len(codes) == len(set(codes)), f"Duplicate codes: {codes}"


class TestSuccessResponse:
    def test_minimal(self):
        r = success_response()
        assert r == {"success": True, "data": None}

    def test_with_data(self):
        r = success_response(data={"id": 1})
        assert r["success"] is True
        assert r["data"] == {"id": 1}

    def test_with_meta(self):
        r = success_response(data="ok", meta={"version": "1.0"})
        assert r["meta"] == {"version": "1.0"}

    def test_no_meta_by_default(self):
        r = success_response(data="ok")
        assert "meta" not in r


class TestErrorResponse:
    def test_basic(self):
        r = error_response("TEST_CODE", "test message")
        assert isinstance(r, JSONResponse)
        assert r.status_code == 500
        assert r.body is not None

    def test_custom_status(self):
        r = error_response("NOT_FOUND", "not found", http_status=404)
        assert r.status_code == 404

    def test_with_details(self):
        r = error_response("ERR", "msg", details={"key": "val"}, http_status=400)
        assert r.status_code == 400
