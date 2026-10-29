# Geospatial

A geospatial map workspace for importing KML sources, browsing their mapped data, and adding user-drawn map features.

## Language

**Map Package**:
An uploaded or bootstrap-imported KML source as a single workspace. A Map Package owns one imported folder tree, imported features, derived nodes, and any drawn features created while it is active.
_Avoid_: Uploaded KML, map upload, workspace when referring to the persisted imported source.

**Route**:
An ordered path across the map that connects two or more Route Stops. A Route groups one or more Route Segments but is not itself a separate visible map feature.
_Avoid_: Long route when referring to the total path, connection when referring to the whole path.

**Route Stop**:
An ordered point in a Route. A Route Stop is user-selected or source-defined; in imported Connection LineStrings, each coordinate is treated as a source-defined Route Stop.
_Avoid_: Site, waypoint, control point when referring to the user-visible stop in the route sequence.

**Route Segment**:
The connection between two adjacent Route Stops in a Route, such as A to B or B to C. Route Segments are independently visible and are the unit used for distance-based filtering, even when a routed path cannot be calculated for one segment.
_Avoid_: Distance when referring to the connection itself.

**Auto Routing**:
An import choice that uses route-generated geometry for imported Route Segments instead of the source-defined line between adjacent Route Stops. When Auto Routing is not used, imported source-defined Route Stops still produce Route Segments.
_Avoid_: Re-routing when referring to the initial import choice.

## Example Dialogue

Dev: Should deleting a Map Package only remove the uploaded file?
Domain expert: No. A Map Package is the whole imported workspace, so deletion removes its imported folders, imported features, derived nodes, and drawn features.

Dev: If a Route goes A to B to C, is that one Route or two Routes?
Domain expert: It is one Route with two visible Route Segments: A to B and B to C. Distance filters apply to each Route Segment, not the Route's total distance.

Dev: Do Route Segments only apply when a user draws a route?
Domain expert: No. Route Segments apply to both user-drawn Routes and Routes imported from KML or KMZ sources. For imported Connection LineStrings, adjacent coordinates become Route Segments.

Dev: What should a Route Segment be called when the Route Stops do not have names?
Domain expert: Use the Route name plus the Route Segment's ordered number, such as Route A - Segment 1.

Dev: If Auto Routing is not used during import, do imported Route Stops stop creating Route Segments?
Domain expert: No. The same source-defined Route Stops still create Route Segments; only the Route Segment geometry stays source-defined instead of route-generated.
