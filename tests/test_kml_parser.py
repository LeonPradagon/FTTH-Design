"""Tests for KML parsing."""

import pytest
from server.services.generator.kml_parser import read_pop_point, read_boundary, read_custom_mapped_kml
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
