"""Tests for KML parsing."""

import pytest
from backend.services.generator.kml_parser import read_pop_point, read_boundary
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
