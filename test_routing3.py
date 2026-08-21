import osmnx as ox
cache_path = "/Users/jessicakimberly/Downloads/ftth_design_generator/cache/regions/roads_c8d2d413bd.graphml"
G = ox.load_graphml(cache_path)
G = ox.truncate.largest_component(G, strongly=False)
G = ox.convert.to_undirected(G)
print("SUCCESS")
