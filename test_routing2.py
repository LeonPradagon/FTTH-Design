import osmnx as ox
import networkx as nx
import os

cache_path = "/Users/jessicakimberly/Downloads/ftth_design_generator/cache/regions/roads_c8d2d413bd.graphml"
G = ox.load_graphml(cache_path)

from backend.services.generator.routing import route_along_road

p1 = (-7.245, 112.745)
p2 = (-7.246, 112.746)

path = route_along_road(G, p1, p2)
if path is None:
    print("PATH IS NONE")
else:
    print(f"PATH FOUND: {len(path)} points")

