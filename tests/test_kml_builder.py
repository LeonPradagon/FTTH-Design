import pytest
import os
import zipfile
from shapely.geometry import Point
from backend.services.generator.models import ODC, ODP, Splitter
from backend.services.generator.kml_builder import export_kmz

@pytest.fixture
def sample_data():
    pop = {"name": "POP_1", "lat": -6.2, "lon": 106.8}
    odps = [
        ODP(id="ODP-1", lat=-6.201, lon=106.801, houses=[(-6.2011, 106.8011)], splitter=Splitter("1:8", "ODP")),
    ]
    odcs = [
        ODC(id="ODC-1", lat=-6.202, lon=106.802, odps=odps, closure_id="CL-001", splitter=Splitter("1:4", "ODC"))
    ]
    feeder_segments = [
        {"coords": [(-6.2, 106.8), (-6.202, 106.802)], "from_label": "POP_1", "to_label": "ODC 01"}
    ]
    return pop, odcs, feeder_segments

def test_export_kmz(tmp_path, sample_data):
    pop, odcs, feeder_segments = sample_data
    out_path = tmp_path / "design.kmz"
    
    export_kmz(pop, odcs, feeder_segments, str(out_path), include_homepass=True, road_graph=None, road_feeder=False)
    
    assert os.path.exists(out_path)
    with zipfile.ZipFile(str(out_path), "r") as z:
        namelist = z.namelist()
        assert "doc.kml" in namelist
        
        # Check folders inside KMZ
        doc = z.read("doc.kml").decode("utf-8")
        assert "POP_1" in doc
        assert "ODC 01" in doc
        assert "01/01" in doc
