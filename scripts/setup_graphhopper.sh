#!/bin/bash
set -e

echo "========================================"
echo " GraphHopper Setup Script"
echo "========================================"
echo "GraphHopper can automatically download and build the OSM graph."
echo "We will now start GraphHopper in the background via docker-compose."
echo "Note: It may take 10-20 minutes to process the Indonesia map for the first time."

mkdir -p "$(pwd)/graphhopper-data"

docker-compose up -d graphhopper

echo ""
echo "GraphHopper is starting. Showing live logs (Press Ctrl+C to exit logs, the server will keep running):"
echo "========================================"
docker-compose logs -f graphhopper
