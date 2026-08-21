  const deckLayers = useMemo(() => {
    return layers
      .filter((layer) => layer.visible && geoDataMap[`${layer.id}-${layer.url}`])
      .map((layer) => {
        const geoJson = geoDataMap[`${layer.id}-${layer.url}`];
        if (!geoJson || !Array.isArray(geoJson.features)) return null;

        // Pre-compute tree info for O(1) lookups to avoid UI freeze on large datasets
        const treeInfoMap = new Map<string, {
            visible: boolean | null;
            inPopFolder: boolean;
            inOdcFolder: boolean;
            inClosureFolder: boolean;
            inOdpFolder: boolean;
        }>();

        if (kmlTrees && kmlTrees[layer.id]) {
            const traverseTree = (nodes: KmlNode[], parentInfo: any) => {
                for (const node of nodes) {
                    const nodeNameUpper = node.name.toUpperCase();
                    
                    const currentInfo = {
                        visible: parentInfo.visible === false ? false : node.visible,
                        inPopFolder: parentInfo.inPopFolder || nodeNameUpper.includes("POP") || nodeNameUpper.includes("OLT") || nodeNameUpper.includes("SENTRAL"),
                        inOdcFolder: parentInfo.inOdcFolder || nodeNameUpper.includes("ODC"),
                        inClosureFolder: parentInfo.inClosureFolder || nodeNameUpper.includes("CLOSURE") || nodeNameUpper.includes("JOIN CLOSURE"),
                        inOdpFolder: parentInfo.inOdpFolder || nodeNameUpper.includes("ODP")
                    };
                    
                    if (node.type === 'placemark') {
                        treeInfoMap.set(node.id, currentInfo);
                    }
                    
                    if (node.children) {
                        traverseTree(node.children, currentInfo);
                    }
                }
            };
            
            traverseTree(kmlTrees[layer.id], {
                visible: null,
                inPopFolder: false,
                inOdcFolder: false,
                inClosureFolder: false,
                inOdpFolder: false
            });
        }

        const layerNameUpper = layer.name.toUpperCase();

        // Helper to determine feature type consistently and optimally
        const getFeatureInfo = (f: any) => {
            const name = String(f.properties?.name || "");
            const desc = String(f.properties?.description || "");
            const nameUpper = name.toUpperCase();
            
            const geomType = f.geometry?.type;
            const isPoint = geomType === "Point" || geomType === "MultiPoint";
            const isLine = geomType === "LineString" || geomType === "MultiLineString";

            let inPopFolder = false;
            let inOdcFolder = false;
            let inClosureFolder = false;
            let inOdpFolder = false;
            let treeVisible: boolean | null = null;
            
            if (f.properties?.treeId) {
                const info = treeInfoMap.get(f.properties.treeId);
                if (info) {
                    treeVisible = info.visible;
                    inPopFolder = info.inPopFolder;
                    inOdcFolder = info.inOdcFolder;
                    inClosureFolder = info.inClosureFolder;
                    inOdpFolder = info.inOdpFolder;
                }
            }

            const isPop = isPoint && (inPopFolder || layer.id === 'pop' || layerNameUpper.includes("POP") || layerNameUpper.includes("OLT") || desc.includes("SERVER OLT") || nameUpper.includes("POP") || nameUpper.includes("OLT"));
            const isOdc = isPoint && (inOdcFolder || layerNameUpper.includes("ODC") || nameUpper.startsWith("ODC") || desc.includes("Jumlah ODP:"));
            const isClosure = isPoint && (inClosureFolder || layerNameUpper.includes("CLOSURE") || nameUpper.includes("JOIN CLOSURE") || nameUpper.includes("CLOSURE"));
            const isOdp = isPoint && (inOdpFolder || layerNameUpper.includes("ODP") || (/^\d{1,2}\/\d{1,2}$/.test(name)) || desc.includes("Induk: ODC") || nameUpper.includes("ODP"));
            const isHouse = isPoint && (layerNameUpper.includes("HOUSE") || layerNameUpper.includes("RUMAH") || (/^\d{1,2}\/\d{1,2}-\d{1,2}$/.test(name)) || desc.includes("Induk ODP:") || (!isPop && !isOdc && !isClosure && !isOdp));
            
            const isFeeder = isLine && (nameUpper.includes("FEEDER") || desc.includes("FEEDER") || f.properties?.stroke === "#ff0000");
            const isDrop = isLine && (nameUpper.includes("TO HC"));
            const isDistribution = isLine && !isFeeder && !isDrop;

            return { isPop, isOdc, isClosure, isOdp, isHouse, isFeeder, isDrop, isDistribution, treeVisible };
        };

        const filteredFeatures = geoJson.features.filter((f: any) => {
           if (!f || !f.geometry || !f.geometry.type) return false;
           
           const info = getFeatureInfo(f);

           if (filters && layer.id !== "boundary") {
             if (info.isPop && !filters.showPop) return false;
             if ((info.isOdc || info.isClosure) && !filters.showOdc) return false;
             if (info.isOdp && !filters.showOdp) return false;
             
             if (info.isFeeder && !filters.showFeeder) return false;
             if (info.isDistribution && !filters.showDistribution) return false;

             if (info.isHouse || info.isDrop) {
                const explicitlyTurnedOnInTree = info.treeVisible === true;
                if (!filters.showHouse && !explicitlyTurnedOnInTree) return false;
             } else {
                if (info.treeVisible === false) return false;
             }
           } else {
             if (info.treeVisible === false) return false;
           }

           return true;
        });

        const data = {
           type: "FeatureCollection",
           features: filteredFeatures
        };

        return new GeoJsonLayer({
          id: `geojson-${layer.id}-${layer.url}-${layer.customColor || layer.color}`,
          data: data as any,
          pickable: true,
          stroked: true,
          filled: true,
          extruded: false,
          lineWidthMinPixels: 2,
          lineWidthUnits: 'pixels',
          pointRadiusUnits: 'pixels',
          getFillColor: (f: any) => {
            const info = getFeatureInfo(f);
            if (info.isPop) return getPinColorArray(featureColors?.pop || '#ef4444');
            if (info.isOdc || info.isClosure) return getPinColorArray(featureColors?.odc || '#3b82f6');
            if (info.isOdp) return getPinColorArray(featureColors?.odp || '#10b981');
            if (info.isHouse) return getPinColorArray(featureColors?.house || '#6b7280');
            
            let baseColor: [number, number, number, number] = [156, 163, 175, 255];
            if (layer.customColor) {
               baseColor = getPinColorArray(layer.customColor);
            } else if (f.properties?.fill) {
               baseColor = getPinColorArray(f.properties.fill);
            } else if (layer.color) {
               baseColor = getPinColorArray(layer.color);
            }

            if (f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon") {
               baseColor[3] = 15; // Sangat transparan agar jalan terlihat
            }
            return baseColor;
          },
          getLineColor: (f: any) => {
            if (f.geometry?.type === "Point") {
                return [255, 255, 255, 255]; // White border for points
            }
            const info = getFeatureInfo(f);
            const isFtthLayer = layer.id.includes("design");
            
            if (isFtthLayer && (f.geometry?.type === "LineString" || f.geometry?.type === "MultiLineString")) {
              if (info.isFeeder) return getPinColorArray(featureColors?.feeder || '#ef4444');
              return getPinColorArray(featureColors?.distribution || '#3b82f6');
            }

            let color: [number, number, number, number] = [156, 163, 175, 255];
            if (layer.customColor) {
              color = getPinColorArray(layer.customColor);
            } else if (f.properties?.stroke) {
              color = getPinColorArray(f.properties.stroke);
            } else if (layer.color) {
              color = getPinColorArray(layer.color);
            }
            return color;
          },
          getLineWidth: (f: any) => {
            if (f.geometry?.type === "Point") return 1; 
            return 3;
          },
          pointType: 'icon',
          getIcon: (f: any) => {
            const info = getFeatureInfo(f);

            if (info.isPop) {
              return { url: getPinDataUri(featureColors?.pop || '#ef4444'), width: 96, height: 136, anchorY: 136 };
            }
            if (info.isOdc || info.isClosure) {
              return { url: getPinDataUri(featureColors?.odc || '#3b82f6'), width: 96, height: 136, anchorY: 136 };
            }
            if (info.isOdp) {
              return { url: getPoleDataUri(featureColors?.odp || '#10b981', '#ffffff'), width: 96, height: 96, anchorY: 48 };
            }
            if (info.isHouse) {
              return { url: getHouseDataUri(featureColors?.house || '#6b7280', '#f9fafb'), width: 96, height: 96, anchorY: 48 };
            }

            const colorHex = f.properties?.fill ? getHexColor(f.properties.fill) : getHexColor(layer.color);
            return { url: getPinDataUri(colorHex), width: 96, height: 136, anchorY: 136 };
          },
          getIconSize: (f: any) => {
            const info = getFeatureInfo(f);
            return info.isHouse ? 20 : (info.isPop ? 40 : 32);
          },
          autoHighlight: true,
          highlightColor: [255, 255, 0, 150],
          onClick: (info) => {
            if (info.object) {
              setSelectedFeature(info.object);
            } else {
              setSelectedFeature(null);
            }
          },
          onHover: (info) => setHoverInfo(info),
          updateTriggers: {
            getFillColor: [layer.customColor, layer.color, featureColors],
            getLineColor: [layer.customColor, layer.color, featureColors],
            getIcon: [layer.customColor, layer.color, featureColors],
            getIconSize: [layer.customColor, layer.color, featureColors]
          }
        });
      })
      .filter(Boolean);
  }, [layers, geoDataMap, filters, kmlTrees, featureColors]);
