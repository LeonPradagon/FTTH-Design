from shapely.geometry import Polygon
from backend.api.routes.generation import _run_generator_logic
boundary_path = "cache/test_boundary.kml"
pop_path = "cache/test_pop.kml"
# Create dummy files
with open(boundary_path, "w") as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?><kml><Document><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>112.74,-7.24 112.75,-7.24 112.75,-7.25 112.74,-7.25 112.74,-7.24</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>')
with open(pop_path, "w") as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?><kml><Document><Placemark><Point><coordinates>112.745,-7.245</coordinates></Point></Placemark></Document></kml>')

_run_generator_logic(boundary_path, pop_path, "test_out.kmz", has_custom_pop=True)
print("SUCCESS")
