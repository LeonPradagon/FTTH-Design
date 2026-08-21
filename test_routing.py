import asyncio
from backend.services.generator.osm_local import fetch_road_graph
from shapely.geometry import Point, Polygon
boundary = Polygon([(112.74, -7.24), (112.75, -7.24), (112.75, -7.25), (112.74, -7.25)])
pop = {"lat": -7.245, "lon": 112.745}
G = fetch_road_graph(boundary, pop)

from backend.services.generator.routing import route_along_road
# try a route
p1 = (-7.243, 112.743)
p2 = (-7.248, 112.748)
path = route_along_road(G, p1, p2)
print("PATH:", path)
