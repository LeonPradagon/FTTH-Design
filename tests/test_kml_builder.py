import tempfile
import unittest
import zipfile
from pathlib import Path

from backend.services.generator.kml_builder import export_kmz
from backend.services.generator.models import ODC, ODP, Splitter


class KmlBuilderTests(unittest.TestCase):
    def test_exports_homepasses_from_every_odp(self):
        odp_splitter = Splitter(ratio="1:10", location="ODP")
        odc = ODC(
            id="ODC-001",
            lat=-6.0,
            lon=106.0,
            splitter=Splitter(ratio="1:4", location="ODC"),
            odps=[
                ODP(
                    id="ODP-001",
                    lat=-6.0,
                    lon=106.0,
                    houses=[(-6.0001, 106.0001)],
                    splitter=odp_splitter,
                ),
                ODP(
                    id="ODP-002",
                    lat=-6.001,
                    lon=106.001,
                    houses=[(-6.0011, 106.0011)],
                    splitter=odp_splitter,
                ),
            ],
        )
        pop = {"name": "POP", "lat": -6.0, "lon": 106.0}
        feeder = [
            {
                "from_label": "POP",
                "to_label": "ODC-001",
                "coords": [(-6.0, 106.0), (-6.0, 106.0)],
            }
        ]

        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "design.kmz"
            export_kmz(
                pop,
                [odc],
                feeder,
                str(output_path),
                include_homepass=True,
            )
            with zipfile.ZipFile(output_path) as archive:
                kml_name = next(
                    name for name in archive.namelist() if name.endswith(".kml")
                )
                content = archive.read(kml_name).decode("utf-8")

        self.assertIn("01/01-01", content)
        self.assertIn("01/02-01", content)


if __name__ == "__main__":
    unittest.main()
