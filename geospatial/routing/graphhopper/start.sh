#!/bin/sh
set -eu

OSM_FILE="${GRAPHHOPPER_OSM_FILE:-/data/indonesia-latest.osm.pbf}"
OSM_URL="${GRAPHHOPPER_OSM_URL:-https://download.geofabrik.de/asia/indonesia-latest.osm.pbf}"
GRAPH_LOCATION="${GRAPHHOPPER_GRAPH_LOCATION:-/data/graph-cache}"

mkdir -p /data

if [ "${GRAPHHOPPER_FORCE_REBUILD:-false}" = "true" ]; then
  rm -rf "$GRAPH_LOCATION"
fi

if [ ! -s "$OSM_FILE" ]; then
  rm -f "$OSM_FILE.tmp"
  curl -fL "$OSM_URL" -o "$OSM_FILE.tmp"
  mv "$OSM_FILE.tmp" "$OSM_FILE"
fi

sh -c "java ${JAVA_OPTS:-} -Ddw.graphhopper.datareader.file='$OSM_FILE' -Ddw.graphhopper.graph.location='$GRAPH_LOCATION' -jar /opt/graphhopper/graphhopper-web.jar server /opt/graphhopper/config.yml"
status=$?

if [ "$status" -ne 0 ] && [ ! -f "$GRAPH_LOCATION/properties" ]; then
  rm -f "$OSM_FILE" "$OSM_FILE.tmp"
  rm -rf "$GRAPH_LOCATION"
fi

exit "$status"
