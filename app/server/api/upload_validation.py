import os
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from fastapi import HTTPException, UploadFile

from server.core.errors import InvalidFileError


def validate_design_upload(upload: UploadFile, max_bytes: int | None = None) -> str:
    """Validate the size and file signature of an uploaded KML/KMZ."""
    filename = Path(upload.filename or "").name
    suffix = Path(filename).suffix.lower()
    if suffix not in {".kml", ".kmz"}:
        raise InvalidFileError(message="File harus berformat KML atau KMZ.")

    limit = max_bytes or int(
        os.getenv("MAX_UPLOAD_FILE_BYTES", os.getenv("MAX_BATCH_FILE_BYTES", str(50 * 1024 * 1024)))
    )
    stream = upload.file
    stream.seek(0, os.SEEK_END)
    size = stream.tell()
    stream.seek(0)
    if size > limit:
        raise HTTPException(
            status_code=413,
            detail=f"Ukuran file maksimal {limit // (1024 * 1024)} MB.",
        )

    try:
        if suffix == ".kmz":
            with ZipFile(stream) as archive:
                kml_files = [item for item in archive.infolist() if item.filename.lower().endswith(".kml")]
                if not kml_files or any(item.file_size > limit for item in kml_files):
                    raise InvalidFileError(message="KMZ tidak berisi KML yang valid.")
        elif b"<kml" not in stream.read(64 * 1024).lower():
            raise InvalidFileError(message="Isi file KML tidak valid.")
    except BadZipFile as exc:
        raise InvalidFileError(message="Isi file KMZ tidak valid.") from exc
    finally:
        stream.seek(0)

    return filename
