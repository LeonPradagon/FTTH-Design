"""Download an OSM PBF atomically for the offline importer."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path


DEFAULT_URL = "https://download.geofabrik.de/asia/indonesia-latest.osm.pbf"


def download(url: str, output: Path, timeout: int = 300) -> dict:
    output.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f"{output.name}.", suffix=".part", dir=output.parent
    )
    os.close(file_descriptor)
    temporary_path = Path(temporary_name)
    digest = hashlib.sha256()
    source_timestamp = None
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "FTTH-Design OSM importer"})
        with urllib.request.urlopen(request, timeout=timeout) as response, temporary_path.open("wb") as target:
            last_modified = response.headers.get("Last-Modified")
            if last_modified:
                try:
                    source_timestamp = parsedate_to_datetime(last_modified).astimezone(timezone.utc).isoformat()
                except (TypeError, ValueError, OverflowError):
                    source_timestamp = None
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                target.write(chunk)
                digest.update(chunk)
            target.flush()
            os.fsync(target.fileno())
        shutil.move(str(temporary_path), str(output))
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
    metadata = {
        "source_url": url,
        "source_timestamp": source_timestamp,
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
        "sha256": digest.hexdigest(),
        "bytes": output.stat().st_size,
    }
    metadata_path = Path(f"{output}.meta.json")
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.getenv("OSM_PBF_URL", DEFAULT_URL))
    parser.add_argument("--output", type=Path, default=Path(os.getenv("OSM_PBF_PATH", "/data/osm/indonesia-latest.osm.pbf")))
    parser.add_argument("--timeout", type=int, default=int(os.getenv("OSM_PBF_DOWNLOAD_TIMEOUT_SECONDS", "900")))
    args = parser.parse_args(argv)
    print(json.dumps(download(args.url, args.output, timeout=args.timeout), indent=2))


if __name__ == "__main__":
    main()
