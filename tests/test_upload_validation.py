from io import BytesIO

import pytest
from fastapi import HTTPException, UploadFile

from server.api.upload_validation import validate_design_upload
from server.core.errors import InvalidFileError


def test_upload_validation_rejects_wrong_type_and_oversize(monkeypatch):
    with pytest.raises(InvalidFileError):
        validate_design_upload(UploadFile(BytesIO(b"plain text"), filename="notes.txt"))

    monkeypatch.setenv("MAX_UPLOAD_FILE_BYTES", "4")
    with pytest.raises(HTTPException) as error:
        validate_design_upload(UploadFile(BytesIO(b"<kml></kml>"), filename="design.kml"))
    assert error.value.status_code == 413
