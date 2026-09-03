"""Download and atomically activate the next weekly OSM dataset."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from server.scripts.download_osm_pbf import DEFAULT_URL, download
from server.scripts.import_osm_pbf import DEFAULT_COVERAGE, _parse_coverage, import_pbf


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.getenv("OSM_PBF_URL", DEFAULT_URL))
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(os.getenv("OSM_PBF_PATH", "/data/osm/indonesia-latest.osm.pbf")),
    )
    parser.add_argument("--dataset-id", default=datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    parser.add_argument("--coverage", default=os.getenv("OSM_PBF_COVERAGE", ",".join(map(str, DEFAULT_COVERAGE))))
    parser.add_argument("--timeout", type=int, default=int(os.getenv("OSM_PBF_DOWNLOAD_TIMEOUT_SECONDS", "900")))
    parser.add_argument("--without-pois", action="store_true")
    args = parser.parse_args(argv)

    download_metadata = download(args.url, args.output, timeout=args.timeout)
    source_timestamp = download_metadata.get("source_timestamp") or download_metadata["downloaded_at"]
    result = import_pbf(
        args.output,
        args.dataset_id,
        args.url,
        datetime.fromisoformat(source_timestamp.replace("Z", "+00:00")),
        tuple(_parse_coverage(args.coverage)),
        include_pois=not args.without_pois,
    )
    print(json.dumps({"download": download_metadata, "import": result}, indent=2, default=str))


if __name__ == "__main__":
    main()
