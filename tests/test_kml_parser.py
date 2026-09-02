"""Tests for KML parsing."""

import pytest
from server.services.generator.kml_parser import (
    read_pop_point,
    read_boundary,
    read_boundary_geometry,
    count_boundary_polygons,
    merge_boundary_files,
    read_custom_mapped_kml,
    split_boundary_file,
    write_points_file,
)
import tempfile
import os

def test_read_pop_point():
    # Create a temporary dummy KML
    kml_content = """<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document>
        <Placemark>
          <name>POP-TEST</name>
          <Point>
            <coordinates>106.148,-6.115,0</coordinates>
          </Point>
        </Placemark>
      </Document>
    </kml>
    """
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".kml") as f:
        f.write(kml_content)
        temp_path = f.name

    try:
        pop = read_pop_point(temp_path)
        assert pop is not None
        assert pop["name"] == "POP-TEST"
        assert pop["lon"] == 106.148
        assert pop["lat"] == -6.115
    finally:
        os.unlink(temp_path)

def test_read_boundary():
    kml_content = """<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document>
        <Placemark>
          <name>Boundary-Test</name>
          <Polygon>
            <outerBoundaryIs>
              <LinearRing>
                <coordinates>
                  106.0,-6.0,0
                  106.1,-6.0,0
                  106.1,-6.1,0
                  106.0,-6.1,0
                  106.0,-6.0,0
                </coordinates>
              </LinearRing>
            </outerBoundaryIs>
          </Polygon>
        </Placemark>
      </Document>
    </kml>
    """
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".kml") as f:
        f.write(kml_content)
        temp_path = f.name

    try:
        boundary = read_boundary(temp_path)
        assert boundary is not None
        assert boundary.geom_type == 'Polygon'
    finally:
        os.unlink(temp_path)


def test_read_custom_mapped_kml_keeps_compound_odp_names_as_odp():
    kml_content = """<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document>
        <Folder><name>OLT</name>
          <Placemark><name>OLT001</name><Point><coordinates>106.8,-6.2,0</coordinates></Point></Placemark>
        </Folder>
        <Folder><name>ODC</name>
          <Placemark><name>ODC004</name><Point><coordinates>106.801,-6.201,0</coordinates></Point></Placemark>
        </Folder>
        <Folder><name>ODP</name>
          <Placemark><name>ODC004.ODP003</name><Point><coordinates>106.802,-6.202,0</coordinates></Point></Placemark>
        </Folder>
      </Document>
    </kml>
    """
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".kml") as f:
        f.write(kml_content)
        temp_path = f.name

    try:
        points = read_custom_mapped_kml(temp_path)
        assert [point["name"] for point in points["odc"]] == ["ODC004"]
        assert [point["name"] for point in points["odp"]] == ["ODC004.ODP003"]
        assert points["odp"][0]["mapping_group"] == "004"
    finally:
        os.unlink(temp_path)


def test_combined_boundaries_split_and_rbs_is_detected_as_pop(tmp_path):
    kml_content = """<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document>
        <Placemark><name>boundary_a</name><Polygon><outerBoundaryIs><LinearRing>
          <coordinates>106.0,-6.0 106.01,-6.0 106.01,-6.01 106.0,-6.01 106.0,-6.0</coordinates>
        </LinearRing></outerBoundaryIs></Polygon></Placemark>
        <Placemark><name>boundary_b</name><Polygon><outerBoundaryIs><LinearRing>
          <coordinates>106.02,-6.0 106.03,-6.0 106.03,-6.01 106.02,-6.01 106.02,-6.0</coordinates>
        </LinearRing></outerBoundaryIs></Polygon></Placemark>
        <Placemark><name>house_001</name><Point><coordinates>106.005,-6.005,0</coordinates></Point></Placemark>
        <Placemark><name>RBS</name><Point><coordinates>106.015,-6.005,0</coordinates></Point></Placemark>
      </Document>
    </kml>
    """
    source = tmp_path / "boundary.kml"
    source.write_text(kml_content)

    assert read_pop_point(source)["name"] == "RBS"
    parts = split_boundary_file(source, tmp_path / "parts")
    assert [name for name, _ in parts] == ["boundary_a", "boundary_b"]
    assert all(read_boundary(path).geom_type == "Polygon" for _, path in parts)

    pop_path = tmp_path / "pop.kml"
    write_points_file(source, pop_path, pop_only=True)
    assert read_pop_point(pop_path)["name"] == "RBS"


def test_multi_geometry_boundaries_split_into_independent_jobs(tmp_path):
    kml_content = """<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document>
        <Placemark><name>boundary_group</name><MultiGeometry>
          <Polygon><outerBoundaryIs><LinearRing>
            <coordinates>106.0,-6.0 106.01,-6.0 106.01,-6.01 106.0,-6.01 106.0,-6.0</coordinates>
          </LinearRing></outerBoundaryIs></Polygon>
          <Polygon><outerBoundaryIs><LinearRing>
            <coordinates>106.02,-6.0 106.03,-6.0 106.03,-6.01 106.02,-6.01 106.02,-6.0</coordinates>
          </LinearRing></outerBoundaryIs></Polygon>
          <Polygon><outerBoundaryIs><LinearRing>
            <coordinates>106.04,-6.0 106.05,-6.0 106.05,-6.01 106.04,-6.01 106.04,-6.0</coordinates>
          </LinearRing></outerBoundaryIs></Polygon>
        </MultiGeometry></Placemark>
        <Placemark><name>RBS</name><Point><coordinates>106.015,-6.005,0</coordinates></Point></Placemark>
      </Document>
    </kml>"""
    source = tmp_path / "boundary_multi_geometry.kml"
    source.write_text(kml_content)

    parts = split_boundary_file(source, tmp_path / "parts")
    assert len(parts) == 3
    assert count_boundary_polygons(source) == 3
    assert [name for name, _ in parts] == [
        "boundary_group_1",
        "boundary_group_2",
        "boundary_group_3",
    ]
    assert all(read_boundary(path).geom_type == "Polygon" for _, path in parts)


def test_read_boundary_geometry_preserves_all_disconnected_polygons(tmp_path):
    source = tmp_path / "boundary_multi.kml"
    source.write_text("""<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
      <Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>
        106.0,-6.0 106.01,-6.0 106.01,-6.01 106.0,-6.01 106.0,-6.0
      </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
      <Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>
        106.02,-6.0 106.03,-6.0 106.03,-6.01 106.02,-6.01 106.02,-6.0
      </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
    </Document></kml>""")

    geometry = read_boundary_geometry(source)
    assert geometry.geom_type == "MultiPolygon"
    assert len(geometry.geoms) == 2

    merged = merge_boundary_files([source], tmp_path / "merged.kml")
    assert read_boundary_geometry(merged).geom_type == "MultiPolygon"
