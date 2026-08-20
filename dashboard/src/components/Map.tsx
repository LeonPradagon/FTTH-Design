/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { WebMercatorViewport } from "@deck.gl/core";
import { TileLayer } from "@deck.gl/geo-layers";
import { BitmapLayer, GeoJsonLayer } from "@deck.gl/layers";
import { kml } from "@tmcw/togeojson";
import { LayerConfig, KmlNode } from "../app/page";

import { Plus, Minus, Compass, ArrowUp, PersonStanding, X } from "lucide-react";

const getPinColorArray = (hex?: string): [number, number, number, number] => {
  if (!hex) return [156, 163, 175, 255]; // Gray fallback
  const h = hex.toLowerCase();
  if (h.includes("ef4444") || h.includes("red")) return [239, 68, 68, 255];
  if (h.includes("f97316") || h.includes("orange")) return [249, 115, 22, 255];
  if (h.includes("22c55e") || h.includes("10b981") || h.includes("green")) return [34, 197, 94, 255];
  if (h.includes("3b82f6") || h.includes("blue")) return [59, 130, 246, 255];
  if (h.includes("eab308") || h.includes("yellow")) return [234, 179, 8, 255];
  if (h.includes("white") || h.includes("#fff") || h.includes("#ffffff")) return [255, 255, 255, 255];
  
  // Basic hex to rgb
  const hexMatch = h.match(/[0-9a-f]{6}/);
  if (hexMatch) {
    const val = parseInt(hexMatch[0], 16);
    return [(val >> 16) & 255, (val >> 8) & 255, val & 255, 255];
  }
  return [156, 163, 175, 255];
};

const getHexColor = (hex?: string) => {
  if (!hex) return "#9ca3af";
  const h = hex.toLowerCase();
  if (h.includes("ef4444") || h.includes("red")) return "#ef4444";
  if (h.includes("f97316") || h.includes("orange")) return "#f97316";
  if (h.includes("22c55e") || h.includes("10b981") || h.includes("green")) return "#10b981";
  if (h.includes("3b82f6") || h.includes("blue")) return "#3b82f6";
  if (h.includes("eab308") || h.includes("yellow")) return "#eab308";
  if (h.includes("white") || h.includes("#fff") || h.includes("#ffffff")) return "#ffffff";
  return hex.startsWith('#') ? hex : `#${hex}`;
};

const getPinDataUri = (color: string) => {
  const svg = `<svg width="96" height="136" viewBox="0 0 24 34" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C5.373 0 0 5.373 0 12C0 21 12 34 12 34C12 34 24 21 24 12C24 5.373 18.627 0 12 0Z" fill="${color}" stroke="white" stroke-width="2" /><circle cx="12" cy="12" r="4" fill="white" /></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const getPoleDataUri = (color: string, bg: string) => {
  const svg = `<svg width="96" height="96" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="11" fill="${bg}" stroke="${color}" stroke-width="2"/><g transform="translate(5, 5) scale(0.583)"><line x1="12" y1="2" x2="12" y2="22" stroke="${color}" stroke-width="2" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="6" stroke="${color}" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="10" x2="16" y2="10" stroke="${color}" stroke-width="2" stroke-linecap="round"/></g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const getHouseDataUri = (color: string, bg: string) => {
  const svg = `<svg width="96" height="96" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="11" fill="${bg}" stroke="${color}" stroke-width="2"/><g transform="translate(5, 5) scale(0.583)"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="9 22 9 12 15 12 15 22" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const parseKmlTree = (parentEl: Element, doc: Document): KmlNode[] => {
  const nodes: KmlNode[] = [];
  
  for (let i = 0; i < parentEl.children.length; i++) {
    const child = parentEl.children[i];
    const tagName = child.tagName.replace(/.*:/, '');

    if (tagName === 'Folder' || tagName === 'Document' || tagName === 'kml') {
      let name = 'Unnamed Folder';
      if (tagName === 'Document') name = 'Document';
      if (tagName === 'kml') name = 'KML';
      const nameEl = Array.from(child.children).find(c => c.tagName.replace(/.*:/, '') === 'name');
      if (nameEl && nameEl.textContent) name = nameEl.textContent;
      
      const id = child.getAttribute('id') || `folder-${Math.random().toString(36).substr(2, 9)}`;
      
      const childrenNodes = parseKmlTree(child, doc);
      
      // Don't add kml or Document if they have no direct placemarks and only 1 folder, but keeping it is fine.
      // We'll just push them all. The UI can handle nested structure.
      // But if a Folder has no children, maybe skip? Let's just include.
      if (tagName === 'kml' && childrenNodes.length === 1 && childrenNodes[0].type === 'folder') {
        // Flatten kml wrapper if it just contains a Document
        nodes.push(...childrenNodes);
      } else {
        nodes.push({
          id,
          name,
          type: 'folder',
          visible: true,
          children: childrenNodes
        });
      }
    } else if (tagName === 'Placemark') {
      const nameEl = Array.from(child.children).find(c => c.tagName.replace(/.*:/, '') === 'name');
      const name = nameEl ? nameEl.textContent || 'Unnamed Placemark' : 'Unnamed Placemark';
      const id = child.getAttribute('id') || `placemark-${Math.random().toString(36).substr(2, 9)}`;
      
      let geomType: 'Point' | 'LineString' | 'Polygon' | undefined = undefined;
      if (child.getElementsByTagName('Point').length > 0 || child.getElementsByTagName('MultiPoint').length > 0) geomType = 'Point';
      else if (child.getElementsByTagName('LineString').length > 0 || child.getElementsByTagName('MultiLineString').length > 0) geomType = 'LineString';
      else if (child.getElementsByTagName('Polygon').length > 0 || child.getElementsByTagName('MultiPolygon').length > 0) geomType = 'Polygon';

      // Inject treeId for GeoJSON linkage
      let extendedData = Array.from(child.children).find(c => c.tagName.replace(/.*:/, '') === 'ExtendedData');
      if (!extendedData) {
        extendedData = doc.createElement('ExtendedData');
        child.appendChild(extendedData);
      }
      
      const dataEl = doc.createElement('Data');
      dataEl.setAttribute('name', 'treeId');
      const valueEl = doc.createElement('value');
      valueEl.textContent = id;
      dataEl.appendChild(valueEl);
      extendedData.appendChild(dataEl);

      nodes.push({
        id,
        name,
        type: 'placemark',
        geomType,
        visible: true
      });
    }
  }
  return nodes;
};

const findNodeVisible = (nodes: KmlNode[] | undefined, targetId: string): boolean | null => {
  if (!nodes) return null;
  for (const node of nodes) {
    if (node.id === targetId) return node.visible;
    if (node.children) {
      const res = findNodeVisible(node.children, targetId);
      if (res !== null) return res;
    }
  }
  return null;
};

interface MapProps {
  layers: LayerConfig[];
  onShowMessage?: (msg: string, type: 'success' | 'error' | 'info') => void;
  filters?: {
    showPop: boolean;
    showOdc: boolean;
    showOdp: boolean;
    showHouse: boolean;
    showFeeder: boolean;
    showDistribution: boolean;
  };
  kmlTrees?: Record<string, KmlNode[]>;
  onTreeLoaded?: (layerId: string, tree: KmlNode[]) => void;
  isSidebarCollapsed?: boolean;
  featureColors?: Record<string, string>;
}

export default function MapComponent({ layers, onShowMessage, filters, kmlTrees, onTreeLoaded, isSidebarCollapsed, featureColors }: MapProps) {
  const [geoDataMap, setGeoDataMap] = useState<Record<string, any>>({});
  const [hoverInfo, setHoverInfo] = useState<any>(null);
  const [streetViewCoords, setStreetViewCoords] = useState<[number, number] | null>(null);
  const [selectedFeature, setSelectedFeature] = useState<any>(null);
  const coordsRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Controlled viewState for map navigation controls
  const [viewState, setViewState] = useState({
    longitude: 118.0149,
    latitude: -2.5489,
    zoom: 4,
    pitch: 0,
    bearing: 0,
    transitionDuration: 0,
  });

  const handleZoomIn = () => setViewState(v => ({ ...v, zoom: v.zoom + 1, transitionDuration: 300 }));
  const handleZoomOut = () => setViewState(v => ({ ...v, zoom: v.zoom - 1, transitionDuration: 300 }));
  const handleResetBearing = () => setViewState(v => ({ ...v, bearing: 0, transitionDuration: 300 }));
  const handleTogglePitch = () => setViewState(v => ({ ...v, pitch: v.pitch === 0 ? 45 : 0, transitionDuration: 300 }));
  const handlePegmanClick = () => {
    if (onShowMessage) {
      onShowMessage("Tahan (click & hold) ikon ini, seret ke arah peta, lalu lepaskan untuk membuka Street View.", "info");
    } else {
      alert("Tahan (click & hold) ikon ini, seret ke arah peta, lalu lepaskan untuk membuka Street View.");
    }
  };

  // Default altitude based on initial zoom 4
  const currentZoomRef = useRef(4);

  useEffect(() => {
    layers.forEach(async (layer) => {
      if (layer.visible && !geoDataMap[`${layer.id}-${layer.url}`]) {
        try {
          const res = await fetch(layer.url);
          const kmlText = await res.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(kmlText, "text/xml");
          
          const tree = parseKmlTree(doc.documentElement, doc);
          if (onTreeLoaded) {
            onTreeLoaded(layer.id, tree);
          }

          const geoJson = kml(doc);
          setGeoDataMap(prev => ({ ...prev, [`${layer.id}-${layer.url}`]: geoJson }));

          // Auto-fit bounds
          if (containerRef.current && geoJson.type === 'FeatureCollection' && geoJson.features.length > 0) {
            let minLng = 180, minLat = 90, maxLng = -180, maxLat = -90;
            let hasCoords = false;
            const processCoords = (coords: any[]) => {
              if (typeof coords[0] === 'number') {
                minLng = Math.min(minLng, coords[0]); maxLng = Math.max(maxLng, coords[0]);
                minLat = Math.min(minLat, coords[1]); maxLat = Math.max(maxLat, coords[1]);
                hasCoords = true;
              } else if (Array.isArray(coords)) {
                coords.forEach(processCoords);
              }
            };
            geoJson.features.forEach((f: any) => {
              if (f.geometry?.coordinates) processCoords(f.geometry.coordinates);
            });

            if (hasCoords) {
              const { width, height } = containerRef.current.getBoundingClientRect();
              if (width > 0 && height > 0) {
                const viewport = new WebMercatorViewport({ width, height });
                // Add some safety checks to prevent crash on identical min/max
                if (maxLng - minLng > 0.0001 && maxLat - minLat > 0.0001) {
                  const fitted = viewport.fitBounds(
                    [[minLng, minLat], [maxLng, maxLat]],
                    { padding: 40 }
                  );
                  setViewState(v => ({
                    ...v,
                    longitude: fitted.longitude,
                    latitude: fitted.latitude,
                    zoom: fitted.zoom,
                    transitionDuration: 1000
                  }));
                } else {
                  setViewState(v => ({
                    ...v,
                    longitude: minLng,
                    latitude: minLat,
                    zoom: 16,
                    transitionDuration: 1000
                  }));
                }
              }
            }
          }
        } catch (err) {
          console.error(`Error loading KML ${layer.name}:`, err);
        }
      }
    });
  }, [layers, geoDataMap, onTreeLoaded]);

  const deckLayers = useMemo(() => {
    return layers
      .filter((layer) => layer.visible && geoDataMap[`${layer.id}-${layer.url}`])
      .map((layer) => {
        const geoJson = geoDataMap[`${layer.id}-${layer.url}`];
        if (!geoJson || !Array.isArray(geoJson.features)) return null;
        
        const filteredFeatures = geoJson.features.filter((f: any) => {
           if (!f || !f.geometry || !f.geometry.type) return false;
           const name = String(f.properties?.name || "");
           const desc = String(f.properties?.description || "");
           const nameUpper = name.toUpperCase();
           
            const geomType = f.geometry?.type;
            const isLine = geomType === "LineString" || geomType === "MultiLineString";
            const isPoint = geomType === "Point" || geomType === "MultiPoint";

            const isPop = isPoint && (layer.id === 'pop' || desc.includes("SERVER OLT") || nameUpper.includes("POP") || nameUpper.includes("OLT"));
            const isOdc = isPoint && (nameUpper.startsWith("ODC") || desc.includes("Jumlah ODP:"));
            const isClosure = isPoint && (nameUpper.includes("JOIN CLOSURE") || nameUpper.includes("CLOSURE"));
            const isOdp = isPoint && ((/^\d{1,2}\/\d{1,2}$/.test(name)) || desc.includes("Induk: ODC") || nameUpper.includes("ODP"));
            const isHouse = isPoint && ((/^\d{1,2}\/\d{1,2}-\d{1,2}$/.test(name)) || desc.includes("Induk ODP:") || (!isPop && !isOdc && !isClosure && !isOdp));
            
            const isFeeder = isLine && (nameUpper.includes("FEEDER") || desc.includes("FEEDER") || f.properties?.stroke === "#ff0000");
            const isDistribution = isLine && !isFeeder;

           if (filters && layer.id !== "boundary") {
             if (isPop && !filters.showPop) return false;
             if ((isOdc || isClosure) && !filters.showOdc) return false;
             if (isOdp && !filters.showOdp) return false;
             if (isHouse && !filters.showHouse) return false;
             
             if (isFeeder && !filters.showFeeder) return false;
             if (isDistribution && !filters.showDistribution) return false;
           }

           if (kmlTrees && kmlTrees[layer.id]) {
             const treeId = f.properties?.treeId;
             if (treeId) {
               const isVisible = findNodeVisible(kmlTrees[layer.id], treeId);
               if (isVisible === false) return false;
             }
           }

           return true;
        });

        const data = {
           type: "FeatureCollection",
           features: filteredFeatures
        };

        return new GeoJsonLayer({
          id: `geojson-${layer.id}-${layer.url}`,
          data: data as any,
          pickable: true,
          stroked: true,
          filled: true,
          lineWidthUnits: 'pixels',
          pointRadiusUnits: 'pixels',
          getFillColor: (f: any) => {
            const name = String(f.properties?.name || "");
            const desc = String(f.properties?.description || "");
            const nameUpper = name.toUpperCase();

            const geomType = f.geometry?.type;
            const isPoint = geomType === "Point" || geomType === "MultiPoint";

            const isPop = isPoint && (layer.id === 'pop' || desc.includes("SERVER OLT") || nameUpper.includes("POP") || nameUpper.includes("OLT"));
            const isOdc = isPoint && (nameUpper.startsWith("ODC") || desc.includes("Jumlah ODP:"));
            const isClosure = isPoint && (nameUpper.includes("JOIN CLOSURE"));
            const isOdp = isPoint && ((/^\d{2}\/\d{2}$/.test(name)) || desc.includes("Induk: ODC"));
            const isHouse = isPoint && ((/^\d{2}\/\d{2}-\d{2}$/.test(name)) || desc.includes("Induk ODP:"));

            if (isPop) return getPinColorArray(featureColors?.pop || '#ef4444');
            if (isOdc || isClosure) return getPinColorArray(featureColors?.odc || '#3b82f6');
            if (isOdp) return getPinColorArray(featureColors?.odp || '#10b981');
            if (isHouse) return getPinColorArray(featureColors?.house || '#6b7280');
            let baseColor: [number, number, number, number] = getPinColorArray(layer.color);
            if (f.properties?.fill) {
               baseColor = getPinColorArray(f.properties.fill);
            }
            if (layer.id === "boundary" || f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon") {
               baseColor[3] = 15; // Sangat transparan agar jalan terlihat
            }
            return baseColor;
          },
          getLineColor: (f: any) => {
            if (f.geometry?.type === "Point") {
                return [255, 255, 255, 255]; // White border for points
            }
            const name = String(f.properties?.name || "");
            const desc = String(f.properties?.description || "");
            const nameUpper = name.toUpperCase();
            
            const isFeeder = nameUpper.includes("FEEDER") || desc.includes("FEEDER") || f.properties?.stroke === "#ff0000";
            const isFtthLayer = layer.id.includes("design") || layer.name.toUpperCase().includes("FTTH");
            const isDistribution = isFtthLayer && !isFeeder;

            if (isFeeder) return getPinColorArray(featureColors?.feeder || '#ef4444');
            if (isDistribution) return getPinColorArray(featureColors?.distribution || '#3b82f6');

            return getPinColorArray(f.properties?.stroke || layer.color);
          },
          getLineWidth: (f: any) => {
            if (f.geometry?.type === "Point") return 1; 
            return 3;
          },
          pointType: 'icon',
          getIcon: (f: any) => {
            const name = String(f.properties?.name || "");
            const desc = String(f.properties?.description || "");
            const nameUpper = name.toUpperCase();

            const geomType = f.geometry?.type;
            const isPoint = geomType === "Point" || geomType === "MultiPoint";

            const isPop = isPoint && (layer.id === 'pop' || desc.includes("SERVER OLT") || nameUpper.includes("POP") || nameUpper.includes("OLT"));
            const isOdc = isPoint && (nameUpper.startsWith("ODC") || desc.includes("Jumlah ODP:"));
            const isClosure = isPoint && (nameUpper.includes("JOIN CLOSURE") || nameUpper.includes("CLOSURE"));
            const isOdp = isPoint && ((/^\d{1,2}\/\d{1,2}$/.test(name)) || desc.includes("Induk: ODC") || nameUpper.includes("ODP"));
            const isHouse = isPoint && ((/^\d{1,2}\/\d{1,2}-\d{1,2}$/.test(name)) || desc.includes("Induk ODP:") || (!isPop && !isOdc && !isClosure && !isOdp));

            if (isPop) {
              return { url: getPinDataUri(featureColors?.pop || '#ef4444'), width: 96, height: 136, anchorY: 136 };
            }
            if (isOdc || isClosure) {
              return { url: getPinDataUri(featureColors?.odc || '#3b82f6'), width: 96, height: 136, anchorY: 136 };
            }
            if (isOdp) {
              return { url: getPoleDataUri(featureColors?.odp || '#10b981', '#ffffff'), width: 96, height: 96, anchorY: 48 };
            }
            if (isHouse) {
              return { url: getHouseDataUri(featureColors?.house || '#6b7280', '#f9fafb'), width: 96, height: 96, anchorY: 48 };
            }

            const colorHex = f.properties?.fill ? getHexColor(f.properties.fill) : getHexColor(layer.color);
            return { url: getPinDataUri(colorHex), width: 96, height: 136, anchorY: 136 };
          },
          getIconSize: (f: any) => {
            const name = String(f.properties?.name || "");
            const desc = String(f.properties?.description || "");
            const nameUpper = name.toUpperCase();
            
            const geomType = f.geometry?.type;
            const isPoint = geomType === "Point" || geomType === "MultiPoint";

            const isPop = isPoint && (layer.id === 'pop' || desc.includes("SERVER OLT") || nameUpper.includes("POP") || nameUpper.includes("OLT"));
            const isOdc = isPoint && (nameUpper.startsWith("ODC") || desc.includes("Jumlah ODP:"));
            const isClosure = isPoint && (nameUpper.includes("JOIN CLOSURE") || nameUpper.includes("CLOSURE"));
            const isOdp = isPoint && ((/^\d{1,2}\/\d{1,2}$/.test(name)) || desc.includes("Induk: ODC") || nameUpper.includes("ODP"));
            const isHouse = isPoint && ((/^\d{1,2}\/\d{1,2}-\d{1,2}$/.test(name)) || desc.includes("Induk ODP:") || (!isPop && !isOdc && !isClosure && !isOdp));
            
            return isHouse ? 20 : (isPop ? 40 : 32);
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
        });
      })
      .filter(Boolean);
  }, [layers, geoDataMap, filters, kmlTrees, featureColors]);

  const baseTileLayer = new TileLayer({
    id: 'osm-tile-layer',
    data: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: props => {
      const bbox = props.tile.bbox as any;

      return new BitmapLayer(props, {
        data: undefined,
        image: props.data,
        bounds: [bbox.west, bbox.south, bbox.east, bbox.north]
      });
    }
  });

  return (
    <div 
      ref={containerRef}
      style={{ position: "relative", width: "100%", height: "100%" }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const data = e.dataTransfer.getData('text/plain');
        if (data === 'pegman' && containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          
          const viewport = new WebMercatorViewport({
            width: rect.width,
            height: rect.height,
            ...viewState
          });
          const [lng, lat] = viewport.unproject([x, y]);
          setStreetViewCoords([lng, lat]);
        }
      }}
    >
      <DeckGL
        viewState={viewState}
        controller={true}
        layers={[baseTileLayer, ...deckLayers]}
        onClick={(info) => {
          if (!info.object) {
            setSelectedFeature(null);
          }
        }}
        onViewStateChange={({ viewState: newViewState }) => {
          setViewState(newViewState as any);
          currentZoomRef.current = (newViewState as any).zoom;
          if (coordsRef.current) {
            // Update eye alt live without re-rendering MapComponent
            // Rumus aproksimasi eye altitude untuk Web Mercator
            const altMeters = 35200000 / Math.pow(2, viewState.zoom);
            const altText = altMeters > 1000 ? (altMeters / 1000).toFixed(2) + " km" : Math.round(altMeters) + " m";
            
            const currentText = coordsRef.current.innerText;
            const parts = currentText.split('eye alt:');
            if (parts.length > 1) {
              const rest = parts[1].split('lat:');
              coordsRef.current.innerText = `${parts[0]}eye alt: ${altText}   lat:${rest[1] || ' 0   lon: 0'}`;
            }
          }
        }}
        onHover={(info) => {
          if (info.coordinate && coordsRef.current) {
            const lat = info.coordinate[1].toFixed(6);
            const lon = info.coordinate[0].toFixed(6);
            
            const altMeters = 35200000 / Math.pow(2, currentZoomRef.current);
            const altText = altMeters > 1000 ? (altMeters / 1000).toFixed(2) + " km" : Math.round(altMeters) + " m";

            coordsRef.current.innerText = `elev: 0 m   eye alt: ${altText}   lat: ${lat}   lon: ${lon}`;
          }
        }}
        getCursor={({ isDragging, isHovering }) => 
          isDragging ? 'grabbing' : (isHovering ? 'pointer' : 'grab')
        }
      />

      {hoverInfo && hoverInfo.object && (
        <div style={{
          position: 'absolute',
          zIndex: 1,
          pointerEvents: 'none',
          left: hoverInfo.x,
          top: hoverInfo.y,
          backgroundColor: '#111827',
          color: '#ffffff',
          padding: '8px',
          borderRadius: '4px',
          fontSize: '12px',
          transform: 'translate(-50%, -100%)',
          marginTop: '-10px',
          boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
          minWidth: '150px'
        }}>
          <b style={{ display: 'block', marginBottom: '4px', fontSize: '14px' }}>
            {hoverInfo.object.properties?.name}
          </b>
          {hoverInfo.object.properties?.description && (
            <div 
              style={{ whiteSpace: 'pre-wrap', lineHeight: '1.4' }} 
              dangerouslySetInnerHTML={{ __html: hoverInfo.object.properties.description }} 
            />
          )}
          {hoverInfo.object.geometry?.type === 'Point' && (
            <div style={{ marginTop: '8px', fontStyle: 'italic', color: '#60a5fa' }}>
              (Klik untuk buka Detail)
            </div>
          )}
        </div>
      )}

      {/* Street View Popup */}
      {streetViewCoords && (
        <div style={{
          position: 'absolute',
          top: '24px',
          right: '90px',
          bottom: '24px',
          width: '460px',
          backgroundColor: 'white',
          borderRadius: '16px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          zIndex: 2000,
          border: '1px solid #e5e7eb'
        }}>
          <div style={{ padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#ffffff', zIndex: 21, borderBottom: '1px solid #f3f4f6' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#111827' }}>Street View</h3>
              <p style={{ margin: '2px 0 0 0', fontSize: '11px', color: '#6b7280', fontFamily: 'monospace' }}>
                {streetViewCoords[1].toFixed(5)}, {streetViewCoords[0].toFixed(5)}
              </p>
            </div>
            <button 
              onClick={() => setStreetViewCoords(null)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#374151', padding: '4px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.2s' }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#e5e7eb'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            >
              <X size={16} />
            </button>
          </div>
          <div style={{ flex: 1, backgroundColor: '#e5e7eb', position: 'relative' }}>
            <iframe 
              src={`https://maps.google.com/maps?q=&layer=c&cbll=${streetViewCoords[1]},${streetViewCoords[0]}&cbp=11,0,0,0,0&output=svembed`}
              width="100%" 
              height="100%" 
              frameBorder="0" 
              style={{ border: 0, position: 'absolute', top: 0, left: 0 }} 
              allowFullScreen 
            />
          </div>
        </div>
      )}

      {selectedFeature && (
        <div style={{
          position: 'absolute',
          bottom: '30px',
          left: isSidebarCollapsed ? '88px' : '300px',
          zIndex: 100,
          backgroundColor: 'white',
          padding: '16px',
          borderRadius: '12px',
          transition: 'left 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
          maxWidth: '300px',
          maxHeight: '400px',
          overflow: 'auto',
          border: '1px solid #e5e7eb'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#111827' }}>
              {selectedFeature.properties?.name || 'Detail Objek'}
            </h3>
            <button onClick={() => setSelectedFeature(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px' }}>
              <X size={14} color="#6b7280" />
            </button>
          </div>
          <div style={{ fontSize: '12px', color: '#374151', fontFamily: 'monospace', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {Object.entries(selectedFeature.properties || {}).filter(([key]) => key !== 'styleUrl' && key !== 'styleHash').map(([key, val]) => (
              <div key={key} style={{ display: 'flex', borderBottom: '1px solid #f3f4f6', paddingBottom: '4px' }}>
                <span style={{ fontWeight: 600, width: '40%', opacity: 0.8 }}>{key}:</span>
                <span style={{ width: '60%', wordBreak: 'break-word' }}>{String(val)}</span>
              </div>
            ))}
            {selectedFeature.geometry && selectedFeature.geometry.type === 'Point' && (
              <div style={{ display: 'flex', borderBottom: '1px solid #f3f4f6', paddingBottom: '4px' }}>
                <span style={{ fontWeight: 600, width: '40%', opacity: 0.8 }}>koordinat:</span>
                <span style={{ width: '60%', wordBreak: 'break-word' }}>{selectedFeature.geometry.coordinates[1].toFixed(5)}, {selectedFeature.geometry.coordinates[0].toFixed(5)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Map Navigation Controls */}
      <div 
        style={{
          position: 'absolute',
          top: '20px',
          right: '20px',
          backgroundColor: 'white',
          borderRadius: '24px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          zIndex: 10
        }}
      >
        <button 
          onClick={handleZoomIn}
          style={{ width: '40px', height: '40px', background: 'transparent', border: 'none', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#374151' }}
          title="Zoom In"
        >
          <Plus size={20} />
        </button>
        <button 
          onClick={handleZoomOut}
          style={{ width: '40px', height: '40px', background: 'transparent', border: 'none', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#374151' }}
          title="Zoom Out"
        >
          <Minus size={20} />
        </button>
        <button 
          onClick={handleResetBearing}
          style={{ width: '40px', height: '40px', background: 'transparent', border: 'none', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#374151' }}
          title="Reset Utara (Bearing)"
        >
          <Compass size={20} />
        </button>
        <button 
          onClick={handleTogglePitch}
          style={{ width: '40px', height: '40px', background: 'transparent', border: 'none', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#374151' }}
          title="Ubah Sudut Kemiringan (Pitch)"
        >
          <ArrowUp size={20} />
        </button>
        <button 
          draggable={true}
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', 'pegman');
            e.dataTransfer.effectAllowed = 'copy';
            
            // Set drag image (optional, gives a better feel)
            const dragIcon = document.createElement('div');
            dragIcon.innerHTML = '📍';
            dragIcon.style.fontSize = '24px';
            document.body.appendChild(dragIcon);
            e.dataTransfer.setDragImage(dragIcon, 12, 24);
            setTimeout(() => document.body.removeChild(dragIcon), 0);
          }}
          onClick={handlePegmanClick}
          style={{ width: '40px', height: '40px', background: 'transparent', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'grab', color: '#f97316', transition: 'background 0.2s' }}
          title="Tarik (Drag) ke atas peta untuk Street View"
        >
          <PersonStanding size={20} />
        </button>
      </div>

      <div 
        ref={coordsRef}
        style={{
          position: 'absolute',
          bottom: '0px',
          left: '0px',
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          color: '#e5e7eb',
          padding: '4px 12px',
          fontSize: '12px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          zIndex: 10,
          whiteSpace: 'nowrap',
          borderTopRightRadius: '8px'
        }}
      >
        elev: 0 m   eye alt: 2200.00 km   lat: -2.548900   lon: 118.014900
      </div>
    </div>
  );
}
