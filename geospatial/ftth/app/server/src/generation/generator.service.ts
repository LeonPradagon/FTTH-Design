import { Injectable, BadRequestException, Inject } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { XMLParser } from 'fast-xml-parser';
import JSZip = require('jszip');
import { DB } from '../db/database.module';
import { apiError } from '../api-error';

type Coord = [number, number];
type Boundary = { outer: Coord[]; holes: Coord[][] };

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}
type Placemark = { name: string; point?: Coord; polygon?: Boundary; context?: string; description?: string; folderContext?: string };
type Node = { id: string; at: Coord; edges: { to: string; weight: number; lengthM: number; highway: string | string[]; coords: Coord[]; oneway: boolean }[] };
type Point = { label: string; at: Coord; members?: string[] };
type Cable = { type: 'feeder' | 'distribution' | 'homepass'; source: string; target: string; coords: Coord[]; length: number };
const asCoord = (point: any): Coord => Array.isArray(point) ? [Number(point[0]), Number(point[1])] : [Number(point.lon), Number(point.lat)];
const DEFAULT_FEATURE_COLORS = { pop: '#eab308', odc: '#ff0000', odp: '#0000ff', house: '#6b7280', feeder: '#ff0000', distribution: '#aa00ff' };
const LEGACY_FEATURE_COLORS = [
  { pop: '#ef4444', odc: '#3b82f6', odp: '#10b981', house: '#6b7280', feeder: '#ef4444', distribution: '#3b82f6' },
  { pop: '#eab308', odc: '#ef4444', odp: '#3b82f6', house: '#6b7280', feeder: '#ef4444', distribution: '#8b5cf6' },
];

export function normalizeFeatureColors(input: unknown) {
  const colors = { ...DEFAULT_FEATURE_COLORS };
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of Object.keys(colors) as (keyof typeof colors)[]) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (/^#[0-9a-f]{6}$/i.test(trimmed)) colors[key] = trimmed.toLowerCase();
      else if (/^#[0-9a-f]{3}$/i.test(trimmed)) colors[key] = `#${[...trimmed.slice(1)].map((char) => char + char).join('').toLowerCase()}`;
    }
  }
  if (LEGACY_FEATURE_COLORS.some((palette) => Object.entries(palette).every(([key, value]) => colors[key as keyof typeof colors] === value))) {
    return { ...DEFAULT_FEATURE_COLORS };
  }
  return colors;
}

export function normalizeCachedState(state: any) {
  if (Array.isArray(state?.pop)) return state;
  if (!Number.isInteger(state?.version) || state.version < 1 || state.version > 4 || !state.pop || !Array.isArray(state.odcs)) {
    throw new BadRequestException('Cache Network Core tidak didukung atau rusak.');
  }
  const coordinate = (latLon: number[]) => [Number(latLon[1]), Number(latLon[0])] as Coord;
  const odcs: Point[] = [], odps: Point[] = [], customers: Point[] = [], cables: Cable[] = [];
  const odpParents = new Map<string, string>();
  const rawOdpParents = new Map<string, any>();
  for (const oldOdc of state.odcs) {
    const odcLabel = String(oldOdc.id);
    const odpLabels: string[] = [];
    for (const oldOdp of oldOdc.odps ?? []) {
      const odpLabel = String(oldOdp.id), houses: string[] = [];
      odpLabels.push(odpLabel);
      odpParents.set(odpLabel, odcLabel);
      rawOdpParents.set(odpLabel, oldOdc);
      for (const [index, house] of (oldOdp.houses ?? []).entries()) {
        const label = `${odpLabel}-${String(index + 1).padStart(2, '0')}`;
        customers.push({ label, at: coordinate(house) });
        houses.push(label);
      }
      odps.push({ label: odpLabel, at: [Number(oldOdp.lon), Number(oldOdp.lat)], members: houses });
    }
    odcs.push({ label: odcLabel, at: [Number(oldOdc.lon), Number(oldOdc.lat)], members: odpLabels });
  }
  const feederSegments = state.feeder_segments ?? [];
  for (const segment of feederSegments) {
    const coords = (segment.coords ?? []).map(coordinate);
    cables.push({ type: 'feeder', source: String(segment.from_label), target: String(segment.to_label), coords, length: pathLength(coords) });
  }
  const distributionSegments = Object.entries(state.distribution_segments ?? {}) as [string, any][];
  for (const [targetId, segment] of distributionSegments) {
    const coords = (Array.isArray(segment) ? segment : segment.coords ?? []).map(coordinate);
    const target = String(segment.target_id ?? segment.target_label ?? targetId);
    cables.push({ type: 'distribution', source: String(segment.source_id ?? segment.source_label ?? odpParents.get(target) ?? ''), target, coords, length: Number(segment.length_m ?? pathLength(coords)) });
  }
  const geometry = state.boundary?.type === 'Feature' ? state.boundary.geometry : state.boundary;
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  const boundaries: Boundary[] = polygons.map((rings: number[][][]) => ({ outer: rings[0] ?? [], holes: rings.slice(1) }));
  const networkComplete = feederSegments.length === odcs.length
    && distributionSegments.length === odps.length
    && odps.every((odp) => {
      const entry = distributionSegments.find(([id, value]) => String(value?.target_id ?? id) === odp.label);
      if (!entry) return false;
      const [key, segment] = entry;
      const rawCoords = Array.isArray(segment) ? segment : segment?.coords;
      if (!Array.isArray(rawCoords) || rawCoords.length < 2 || (!Array.isArray(segment) && segment.connected === false)) return false;
      const coords = rawCoords.map(coordinate);
      if (coords.some((point) => !point.every(Number.isFinite))) return false;
      const target = String(segment.target_id ?? key);
      const ownerId = odpParents.get(odp.label)!;
      const source = Array.isArray(segment) ? ownerId : segment.source_id;
      const assigned = new Set(odcs.find((odc) => odc.label === ownerId)?.members ?? []);
      if (target !== odp.label || (source !== ownerId && !assigned.has(String(source)))) return false;
      const sourcePoint = source === ownerId
        ? odcs.find((odc) => odc.label === ownerId)?.at
        : odps.find((candidate) => candidate.label === String(source))?.at;
      if (!sourcePoint || distance(coords[0], sourcePoint) > 2 || distance(coords.at(-1)!, odp.at) > 2) return false;
      const length = Number(segment.length_m ?? pathLength(coords));
      if (!Number.isFinite(length) || length > Number(state.max_distribution_length_m ?? 500)) return false;
      const seen = new Set<string>();
      let current = odp.label;
      while (current !== ownerId) {
        if (seen.has(current)) return false;
        seen.add(current);
        const parentEntry = distributionSegments.find(([id, value]) => String(value?.target_id ?? id) === current);
        if (!parentEntry) return false;
        const parent = Array.isArray(parentEntry[1]) ? rawOdpParents.get(current)?.id : parentEntry[1].source_id;
        if (!parent || (parent !== ownerId && !assigned.has(String(parent)))) return false;
        current = String(parent);
      }
      return true;
    });
  return {
    pop: [Number(state.pop.lon), Number(state.pop.lat)] as Coord,
    pop_label: String(state.pop.name ?? 'POP'), odcs, odps, customers, cables, boundaries, roads: [],
    legacyCache: true,
    networkComplete,
  };
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false });
const xmlItems = (value: any) => value === undefined ? [] : Array.isArray(value) ? value : [value];
export function parseNativeOsmXml(source: string) {
  const osm = parser.parse(source)?.osm;
  if (!osm) throw new Error('Native OSM mengembalikan XML yang tidak valid.');
  const nodes = new Map<string, Coord>();
  const taggedNodes: any[] = [];
  for (const node of xmlItems(osm.node)) {
    const id = String(node['@_id'] ?? ''), lon = Number(node['@_lon']), lat = Number(node['@_lat']);
    if (!id || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    nodes.set(id, [lon, lat]);
    const tags = Object.fromEntries(xmlItems(node.tag).map((tag: any) => [String(tag['@_k']), String(tag['@_v'] ?? '')]));
    if (Object.keys(tags).length) taggedNodes.push({ type: 'node', id, lon, lat, tags });
  }
  const ways = xmlItems(osm.way).flatMap((way: any) => {
    const tags = Object.fromEntries(xmlItems(way.tag).map((tag: any) => [String(tag['@_k']), String(tag['@_v'] ?? '')]));
    const geometry = xmlItems(way.nd).map((nd: any) => nodes.get(String(nd['@_ref']))).filter(Boolean);
    return Object.keys(tags).length && geometry.length >= 2 ? [{ type: 'way', id: String(way['@_id']), tags, geometry }] : [];
  });
  return [...taggedNodes, ...ways];
}
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const distance = (a: Coord, b: Coord) => {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(x));
};

function collectPlacemarks(root: any): Placemark[] {
  const result: Placemark[] = [];
  const walk = (value: any, context = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'Folder') for (const folder of (Array.isArray(child) ? child : [child]) as any[]) walk(folder, [context, folder.name].filter(Boolean).join(' '));
      else if (key === 'Placemark') for (const item of (Array.isArray(child) ? child : [child]) as any[]) {
        const coords = (v: any): Coord[] => String(v ?? '').trim().split(/\s+/).map((part) => part.split(',').slice(0, 2).map(Number) as Coord).filter((p) => p.length === 2 && p.every(Number.isFinite));
        const multiGeometries = xmlItems(item.MultiGeometry);
        const point = coords(item.Point?.coordinates ?? multiGeometries.flatMap((geometry) => xmlItems(geometry.Point))[0]?.coordinates)[0];
        const polygons = [item.Polygon, ...multiGeometries.flatMap((geometry) => xmlItems(geometry.Polygon))]
          .filter(Boolean)
          .map((polygon) => ({
            outer: coords(polygon?.outerBoundaryIs?.LinearRing?.coordinates),
            holes: (Array.isArray(polygon?.innerBoundaryIs) ? polygon.innerBoundaryIs : polygon?.innerBoundaryIs ? [polygon.innerBoundaryIs] : [])
              .map((inner: any) => coords(inner?.LinearRing?.coordinates)).filter((ring: Coord[]) => ring.length >= 3),
          }))
          .filter((polygon) => polygon.outer.length >= 3);
        const name = String(item.name ?? '');
        const description = String(item.description ?? ''), placemarkContext = [context, description].filter(Boolean).join(' ');
        if (point) result.push({ name, point, context: placemarkContext, description, folderContext: context });
        for (const polygon of polygons) result.push({ name, polygon, context: placemarkContext, description, folderContext: context });
        if (!point && !polygons.length) result.push({ name, context: placemarkContext, description, folderContext: context });
      }
      else walk(child, context);
    }
  };
  walk(root);
  return result;
}

export async function readKml(bytes: Buffer, filename: string): Promise<Placemark[]> {
  let body = bytes;
  if (filename.toLowerCase().endsWith('.kmz')) {
    let zip: JSZip;
    try { zip = await JSZip.loadAsync(bytes); }
    catch { throw new BadRequestException('Isi file KMZ tidak valid.'); }
    const kml = Object.values(zip.files).find((file) => !file.dir && file.name.toLowerCase().endsWith('.kml'));
    if (!kml) throw new BadRequestException('KMZ tidak berisi KML yang valid.');
    body = await kml.async('nodebuffer');
  }
  try { return collectPlacemarks(parser.parse(body.toString('utf8'))); }
  catch { throw new BadRequestException('Isi file KML tidak valid.'); }
}

export function customMappingGroup(text: string, kind: 'odc' | 'odp') {
  const normalized = String(text ?? '').trim().toUpperCase();
  const odcGroup = normalized.match(/(?<![A-Z0-9])ODC\s*[-_ ]?\s*(\d+)\b/)?.[1];
  if (odcGroup || kind === 'odc') return odcGroup;
  return normalized.match(/(?<![A-Z0-9])ODP\s*[-_ ]?\s*(\d+)\s*\/\s*\d+\b/)?.[1];
}

export function outputOdpLabel(label: string, odcIndex: number, odpIndex: number) {
  return /^ODC\d+\.ODP\d+$/i.test(label)
    ? label
    : `ODC${String(odcIndex).padStart(3, '0')}.ODP${String(odpIndex).padStart(3, '0')}`;
}

export function classifyCustomPoints(marks: Placemark[]) {
  const roleFromText = (text: string) => /(^|[^A-Z0-9])(OLT|POP)(?=$|[^A-Z0-9])/i.test(text) ? 'pop'
    : /(^|[^A-Z0-9])ODC(?:\s*[-_ ]?\s*\d+)?/i.test(text) ? 'odc'
      : /(^|[^A-Z0-9])ODP(?:\s*[-_ ]?\s*\d+)?/i.test(text) ? 'odp'
        : /(^|[^A-Z0-9])(HC|RUMAH|HOME\s*PASS)(?=$|[^A-Z0-9])/i.test(text) ? 'hc' : undefined;
  const labeled = marks.filter((mark) => mark.point).map((mark, index) => {
    const label = mark.name || 'Unknown', description = mark.description ?? '', folder = mark.folderContext ?? '';
    const role = /(^|[^A-Z0-9])ODP/i.test(label) || /^\s*\d+\s*\/\s*\d+\s*$/.test(label) ? 'odp'
      : /(^|[^A-Z0-9])ODC/i.test(label) ? 'odc'
        : roleFromText(`${label} ${description}`) ?? roleFromText(folder);
    return { label: mark.name || `${role ?? 'POINT'}-${index + 1}`, at: mark.point!, context: `${label} ${description} ${folder}`, role, mark };
  });
  let pop = labeled.find((item) => item.role === 'pop');
  if (!pop) {
    const marker = /(?<![A-Z0-9])(?:POP|OLT|SENTRAL|RBS)(?:\s*[-_ ]?\s*\d+)?(?![A-Z0-9])/i;
    const fallback = marks.find((mark) => mark.point && marker.test(mark.folderContext ?? ''))
      ?? marks.find((mark) => mark.point && marker.test(`${mark.name} ${mark.description ?? ''}`));
    if (fallback?.point) pop = { label: fallback.name || 'POP', at: fallback.point, context: `${fallback.name} ${fallback.description ?? ''} ${fallback.folderContext ?? ''}`, role: 'pop', mark: fallback };
  }
  return {
    pop: pop && { label: pop.label, at: pop.at },
    odcs: labeled.filter((item) => item.role === 'odc').map(({ label, at, context }) => ({ label, at, context, members: [] as string[] })),
    odps: labeled.filter((item) => item.role === 'odp').map(({ label, at, context }) => ({ label, at, context, members: [] as string[] })),
    customers: labeled.filter((item) => item.role === 'hc').map(({ label, at, context }) => ({ label, at, context })),
  };
}

function containsRing(ring: Coord[], point: Coord) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function onRingBoundary(ring: Coord[], point: Coord) {
  for (let index = 0; index < ring.length; index++) {
    const [x1, y1] = ring[index], [x2, y2] = ring[(index + 1) % ring.length];
    const cross = (point[0] - x1) * (y2 - y1) - (point[1] - y1) * (x2 - x1);
    if (Math.abs(cross) > 1e-12) continue;
    if (point[0] >= Math.min(x1, x2) - 1e-12 && point[0] <= Math.max(x1, x2) + 1e-12 &&
        point[1] >= Math.min(y1, y2) - 1e-12 && point[1] <= Math.max(y1, y2) + 1e-12) return true;
  }
  return false;
}

function clipSegmentOutsideHoles(start: Coord, end: Coord, holes: Coord[][]): [Coord, Coord][] {
  if (!holes.length) return [[start, end]];
  const dx = end[0] - start[0], dy = end[1] - start[1], cuts = [0, 1];
  for (const hole of holes) for (let i = 0; i < hole.length; i++) {
    const a = hole[i], b = hole[(i + 1) % hole.length], sx = b[0] - a[0], sy = b[1] - a[1];
    const denominator = dx * sy - dy * sx;
    if (Math.abs(denominator) < 1e-12) continue;
    const t = ((a[0] - start[0]) * sy - (a[1] - start[1]) * sx) / denominator;
    const u = ((a[0] - start[0]) * dy - (a[1] - start[1]) * dx) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) cuts.push(t);
  }
  const ordered = [...new Set(cuts.map((cut) => cut.toFixed(12)))].map(Number).sort((a, b) => a - b);
  const at = (t: number): Coord => [start[0] + dx * t, start[1] + dy * t];
  const segments: [Coord, Coord][] = [];
  for (let i = 1; i < ordered.length; i++) {
    const left = ordered[i - 1], right = ordered[i], midpoint = at((left + right) / 2);
    if (right - left > 1e-12 && !holes.some((hole) => containsRing(hole, midpoint))) segments.push([at(left), at(right)]);
  }
  return segments;
}

function contains(boundary: Boundary, point: Coord) {
  const inOuter = containsRing(boundary.outer, point) || onRingBoundary(boundary.outer, point);
  const inHole = boundary.holes.some((hole) => containsRing(hole, point) && !onRingBoundary(hole, point));
  return inOuter && !inHole;
}

function intersectsTile(boundary: Boundary, minLon: number, minLat: number, maxLon: number, maxLat: number) {
  const ring = boundary.outer;
  const inside = (p: Coord) => p[0] >= minLon && p[0] <= maxLon && p[1] >= minLat && p[1] <= maxLat;
  const corners: Coord[] = [[minLon, minLat], [minLon, maxLat], [maxLon, minLat], [maxLon, maxLat]];
  const orient = (a: Coord, b: Coord, c: Coord) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const crosses = (a: Coord, b: Coord, c: Coord, d: Coord) => orient(a, b, c) * orient(a, b, d) <= 0 && orient(c, d, a) * orient(c, d, b) <= 0;
  const edges: [Coord, Coord][] = [[[minLon, minLat], [maxLon, minLat]], [[maxLon, minLat], [maxLon, maxLat]], [[maxLon, maxLat], [minLon, maxLat]], [[minLon, maxLat], [minLon, minLat]]];
  const overlapsRing = (candidate: Coord[]) => candidate.some(inside) || corners.some((point) => containsRing(candidate, point)) || candidate.some((point, index) => edges.some(([a, b]) => crosses(point, candidate[(index + 1) % candidate.length], a, b)));
  if (!overlapsRing(ring)) return false;
  const center: Coord = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  if (boundary.holes.some((hole) => corners.every((point) => containsRing(hole, point)) && containsRing(hole, center))) return false;
  return true;
}

function nearestOnRing(point: Coord, ring: Coord[]): Coord {
  let nearest = ring[0], best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const candidate: Coord = [a[0] + t * dx, a[1] + t * dy], d = distance(point, candidate);
    if (d < best) { best = d; nearest = candidate; }
  }
  return nearest;
}

function nearestOnLine(point: Coord, line: Coord[]): Coord {
  // Match OSMnx on the unprojected EPSG:4326 graph, then Shapely's lon/lat projection.
  let nearest = line[0], best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i], [bx, by] = line[i + 1];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
    const candidate: Coord = [ax + t * (bx - ax), ay + t * (by - ay)], d = (point[0] - candidate[0]) ** 2 + (point[1] - candidate[1]) ** 2;
    if (d < best) { best = d; nearest = candidate; }
  }
  return nearest;
}

function nearestOnBoundary(point: Coord, boundary: Boundary): Coord {
  return [boundary.outer, ...boundary.holes].map((ring) => nearestOnRing(point, ring))
    .reduce((nearest, candidate) => distance(point, candidate) < distance(point, nearest) ? candidate : nearest);
}

function connectorRibbon(start: Coord, end: Coord, width: number): Coord[] {
  const dx = end[0] - start[0], dy = end[1] - start[1], length = Math.hypot(dx, dy) || 1;
  const offset: Coord = [-dy / length * width, dx / length * width];
  return [[start[0] + offset[0], start[1] + offset[1]], [end[0] + offset[0], end[1] + offset[1]], [end[0] - offset[0], end[1] - offset[1]], [start[0] - offset[0], start[1] - offset[1]], [start[0] + offset[0], start[1] + offset[1]]];
}

function centroid(ring: Coord[]): Coord {
  const points = ring.slice(0, -1);
  return [points.reduce((sum, p) => sum + p[0], 0) / Math.max(points.length, 1), points.reduce((sum, p) => sum + p[1], 0) / Math.max(points.length, 1)];
}

function polygonCentroid(ring: Coord[]): Coord {
  const [originLon, originLat] = ring[0] ?? [0, 0];
  let areaTwice = 0, lon = 0, lat = 0;
  for (let i = 0; i < ring.length; i++) {
    const x = ring[i][0] - originLon, y = ring[i][1] - originLat;
    const nextX = ring[(i + 1) % ring.length][0] - originLon, nextY = ring[(i + 1) % ring.length][1] - originLat;
    const cross = x * nextY - nextX * y;
    areaTwice += cross;
    lon += (x + nextX) * cross;
    lat += (y + nextY) * cross;
  }
  return Math.abs(areaTwice) < 1e-15 ? centroid(ring) : [originLon + lon / (3 * areaTwice), originLat + lat / (3 * areaTwice)];
}

export function boundaryCentroid(boundaries: Boundary[]): Coord {
  let weight = 0, lon = 0, lat = 0;
  for (const boundary of boundaries) {
    const outerWeight = Math.abs(polygonCentroidArea(boundary.outer));
    const outerCenter = polygonCentroid(boundary.outer);
    weight += outerWeight; lon += outerCenter[0] * outerWeight; lat += outerCenter[1] * outerWeight;
    for (const hole of boundary.holes) {
      const holeWeight = Math.abs(polygonCentroidArea(hole)), holeCenter = polygonCentroid(hole);
      weight -= holeWeight; lon -= holeCenter[0] * holeWeight; lat -= holeCenter[1] * holeWeight;
    }
  }
  return weight > 0 ? [lon / weight, lat / weight] : centroid(boundaries[0].outer);
}

function polygonCentroidArea(ring: Coord[]) {
  const [originLon, originLat] = ring[0] ?? [0, 0];
  let areaTwice = 0;
  for (let i = 0; i < ring.length; i++) {
    const x = ring[i][0] - originLon, y = ring[i][1] - originLat;
    const nextX = ring[(i + 1) % ring.length][0] - originLon, nextY = ring[(i + 1) % ring.length][1] - originLat;
    areaTwice += x * nextY - nextX * y;
  }
  return areaTwice / 2;
}

function polygonComponentsCentroid(polygons: { outer: Coord[]; holes?: Coord[][] }[]): Coord | undefined {
  let area = 0, lon = 0, lat = 0;
  for (const polygon of polygons) for (const [ring, sign] of [[polygon.outer, 1], ...(polygon.holes ?? []).map((hole) => [hole, -1])] as [Coord[], number][]) {
    const weight = Math.abs(polygonCentroidArea(ring)) * sign, center = polygonCentroid(ring);
    area += weight; lon += center[0] * weight; lat += center[1] * weight;
  }
  return area > 0 ? [lon / area, lat / area] : undefined;
}

function clippedPolygonPoint(ring: Coord[], boundary: Boundary): Coord | undefined {
  const candidate = polygonCentroid(ring);
  if (contains(boundary, candidate)) return candidate;
  const boundaryRings = [boundary.outer, ...boundary.holes], ys = [...ring, ...boundaryRings.flat()].map((point) => point[1]);
  const intersections: Coord[] = [];
  for (let i = 0; i < ring.length; i++) for (const other of boundaryRings) for (let j = 0; j < other.length; j++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], c = other[j], d = other[(j + 1) % other.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], ex = d[0] - c[0], ey = d[1] - c[1], denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < 1e-15) continue;
    const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / denominator;
    const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const point: Coord = [a[0] + t * dx, a[1] + t * dy];
      intersections.push(point);
      ys.push(point[1]);
    }
  }
  const levels = [...new Set(ys)].sort((a, b) => a - b);
  let best: { point: Coord; width: number } | undefined;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] < 1e-14) continue;
    const y = (levels[i] + levels[i - 1]) / 2, xs: number[] = [];
    for (const polygonRing of [ring, ...boundaryRings]) for (let j = 0; j < polygonRing.length; j++) {
      const a = polygonRing[j], b = polygonRing[(j + 1) % polygonRing.length];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    xs.sort((a, b) => a - b);
    for (let j = 1; j < xs.length; j++) {
      const width = xs[j] - xs[j - 1], point: Coord = [(xs[j] + xs[j - 1]) / 2, y];
      if (width > 0 && width > (best?.width ?? 0) && containsRing(ring, point) && contains(boundary, point)) best = { point, width };
    }
  }
  return best?.point ?? intersections.find((point) => containsRing(ring, point))
    ?? ring.find((point) => contains(boundary, point));
}

export function strategicPop(elements: any[], center: Coord): { name: string; at: Coord } | undefined {
  const lineCentroid = (points: Coord[]) => {
    let length = 0, lon = 0, lat = 0;
    for (let i = 1; i < points.length; i++) {
      const segmentLength = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      length += segmentLength;
      lon += (points[i][0] + points[i - 1][0]) * segmentLength / 2;
      lat += (points[i][1] + points[i - 1][1]) * segmentLength / 2;
    }
    return length ? [lon / length, lat / length] as Coord : centroid(points);
  };
  const candidate = (element: any): Coord | undefined => {
    if (element.type === 'node' && Number.isFinite(Number(element.lon)) && Number.isFinite(Number(element.lat))) return [Number(element.lon), Number(element.lat)];
    if (Array.isArray(element.polygons) && element.polygons.length) {
      const center = polygonComponentsCentroid(element.polygons);
      if (center) return center;
    }
    const points = (element.geometry ?? []).map(asCoord).filter((point: Coord) => point.every(Number.isFinite));
    if (!points.length) return undefined;
    if (element.tags?.highway) return points[0];
    const closed = points.length >= 4 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1];
    return closed ? polygonCentroid(points) : lineCentroid(points);
  };
  const priorities = [
    { fallback: 'Stasiun Kereta', matches: (tags: any) => tags.railway === 'station' || tags.building === 'train_station' },
    { fallback: 'Kantor POP', matches: (tags: any) => Boolean(tags.office) || tags.building === 'office' },
    { fallback: 'Jalan Utama', matches: (tags: any) => ['primary', 'secondary', 'trunk', 'tertiary'].includes(tags.highway) },
    { fallback: 'Jalan Perumahan', matches: (tags: any) => Boolean(tags.highway) },
  ];
  for (const priority of priorities) {
    const found = elements.filter((item) => priority.matches(item.tags ?? '')).flatMap((item) => {
      const at = candidate(item);
      return at ? [{ name: String(item.tags?.name ?? '').trim() || priority.fallback, at }] : [];
    });
    if (found.length) return found[0];
  }
  return { name: 'Auto POP (Titik Tengah)', at: center };
}

export function parseOverpassElements(elements: any[]) {
  const same = (a: Coord, b: Coord) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  const joinRings = (segments: Coord[][]) => {
    const pending = segments.filter((ring) => ring.length >= 2).map((ring) => [...ring]), rings: Coord[][] = [];
    while (pending.length) {
      const ring = pending.shift()!;
      for (let attempts = 0; attempts < segments.length && !same(ring[0], ring.at(-1)!); attempts++) {
        const tail = ring.at(-1)!;
        const index = pending.findIndex((part) => same(part[0], tail) || same(part.at(-1)!, tail));
        if (index < 0) break;
        const part = pending.splice(index, 1)[0];
        const ordered = same(part[0], tail) ? part : part.reverse();
        ring.push(...ordered.slice(1));
      }
      if (ring.length >= 4 && same(ring[0], ring.at(-1)!)) rings.push(ring);
    }
    return rings;
  };
  const relations = elements.flatMap((element) => {
    if (element.type !== 'relation' || !(element.tags?.building || element.tags?.office || element.tags?.railway === 'station')) return [];
    const members = element.members ?? [];
    const ringFor = (role: string) => joinRings(members.filter((member: any) => member.type === 'way' && (role === 'inner' ? member.role === 'inner' : member.role !== 'inner'))
      .map((member: any) => (member.geometry ?? []).map(asCoord).filter((point: Coord) => point.every(Number.isFinite))));
    const outers = ringFor('outer'), inners = ringFor('inner');
    if (!outers.length) return [];
    const polygons = outers.map((outer) => ({ outer, holes: inners.filter((hole) => containsRing(outer, hole[0])) }));
    return [{ ...element, polygons, geometry: outers[0] }];
  });
  return [...elements.filter((element) => element.type !== 'relation'), ...relations];
}

const ROAD_FACTORS: Record<string, number> = { motorway: 0.9, motorway_link: 0.95, trunk: 0.85, trunk_link: 0.9, primary: 0.9, primary_link: 0.95, secondary: 1, secondary_link: 1.05, tertiary: 1.15, tertiary_link: 1.2, residential: 1.75, unclassified: 2, living_street: 2.25, road: 2.5, service: 3 };
function highwayValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).toLowerCase());
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (text.startsWith('[') && text.endsWith(']')) {
    try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) return parsed.map((item) => String(item).toLowerCase()); }
    catch { return text.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '').toLowerCase()).filter(Boolean); }
  }
  return text ? [text.toLowerCase()] : [];
}
function highwayFactor(value: unknown): number | undefined {
  const factors = highwayValues(value).map((highway) => ROAD_FACTORS[highway]).filter((factor) => factor !== undefined);
  return factors.length ? Math.min(...factors) : undefined;
}
const OVERPASS_ENDPOINTS = [...new Set([
  process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
])];
export function parseBooleanInput(value: unknown, key: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === 'string' && /^(true|1|on|yes|y|t|false|0|off|no|n|f)$/i.test(value)) return /^(true|1|on|yes|y|t)$/i.test(value);
  throw new BadRequestException(`${key} harus bernilai boolean.`);
}

export function localFallbackEnabled(value = process.env.OSM_LOCAL_FALLBACK_ON_ONLINE_FAILURE) {
  return value === undefined || ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function localOsmPopName(kind: string, name: unknown) {
  return typeof name === 'string' && name ? name : `POP OSM lokal (${kind})`;
}

export function osmRequestTimeoutSeconds(value = process.env.OSM_REQUEST_TIMEOUT_SECONDS) {
  if (value === undefined || !/^\s*[+-]?\d(?:_?\d)*\s*$/.test(value)) return 15;
  return Math.max(1, Number(value.replaceAll('_', '').trim()));
}

export function localRoadWindow(wkt: string, pop?: Coord) {
  const geometry = pop
    ? sql`ST_Collect(ST_GeomFromText(${wkt},4326), ST_SetSRID(ST_MakePoint(${pop[0]},${pop[1]}),4326))`
    : sql`ST_GeomFromText(${wkt},4326)`;
  return sql`ST_Expand(ST_ConvexHull(${geometry}),0.002)`;
}

export function localPopSearchArea(wkt: string) {
  return sql`ST_Buffer(ST_GeomFromText(${wkt},4326),0.01,'quad_segs=16')`;
}

function generationConfig(options: any) {
  const defaults: Record<string, number> = { odp_capacity: 10, odc_capacity: 4, min_odp_cluster_size: 1, min_odc_cluster_size: 1, max_odp_radius_m: 150, max_odc_radius_m: 500, max_feeder_length_m: 2000, max_distribution_length_m: 500, snapping_distance_m: 100 };
  const bounds: Record<string, [number, number, boolean]> = { odp_capacity: [1, 64, true], odc_capacity: [1, 32, true], min_odp_cluster_size: [1, 64, true], min_odc_cluster_size: [1, 32, true], max_odp_radius_m: [10, 500, false], max_odc_radius_m: [50, 5000, false], max_feeder_length_m: [100, 20000, false], max_distribution_length_m: [50, 5000, false], snapping_distance_m: [5, 1500, false] };
  const config = { ...options };
  for (const [key, [min, max, integer]] of Object.entries(bounds)) {
    const raw = config[key] === undefined ? defaults[key] : config[key];
    if (raw === null || (typeof raw !== 'number' && typeof raw !== 'string' && !(integer && typeof raw === 'boolean')) || (typeof raw === 'string' && !raw.trim())) throw new BadRequestException(`${key} harus berupa angka.`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new BadRequestException(`${key} harus ${integer ? 'bilangan bulat ' : ''}antara ${min} dan ${max}.`);
    config[key] = value;
  }
  if (config.min_odp_cluster_size > config.odp_capacity || config.min_odc_cluster_size > config.odc_capacity) throw new BadRequestException('Ukuran minimum cluster tidak boleh melebihi kapasitas perangkat.');
  if (!['shortest', 'priority_road'].includes(config.routing_strategy ?? 'shortest')) throw new BadRequestException('routing_strategy harus shortest atau priority_road.');
  config.routing_strategy ??= 'shortest';
  for (const [key, fallback] of [['include_homepass', true], ['force_refresh_osm', false]] as const) {
    config[key] = parseBooleanInput(config[key] === undefined ? fallback : config[key], key);
  }
  return config;
}

export function designStats(odcs: Point[], odps: Point[], customers: Point[], cables: Cable[]) {
  const odcStats = odcs.map((odc) => {
    const assigned = odps.filter((odp) => odc.members?.includes(odp.label));
    return { odc_id: odc.label, odp_count: assigned.length, house_count: assigned.reduce((sum, odp) => sum + customers.filter((house) => odp.members?.includes(house.label)).length, 0) };
  });
  const total = (type: Cable['type']) => cables.filter((cable) => cable.type === type).reduce((sum, cable) => sum + cable.length, 0);
  return { odc_count: odcs.length, odp_count: odps.length, customer_count: customers.length, feeder_length_km: Number(csvFloat(total('feeder') / 1000, 2)), distribution_length_km: Number(csvFloat(total('distribution') / 1000, 2)), odc_stats: odcStats };
}

function validateDesign(odcs: Point[], odps: Point[], customers: Point[], cables: Cable[], options: any) {
  const issues: { severity: string; code: string; message: string; details: Record<string, unknown> }[] = [];
  const add = (severity: string, code: string, message: string, details: Record<string, unknown>) => issues.push({ severity, code, message, details });
  for (const odc of odcs) {
    const assigned = odps.filter((odp) => odc.members?.includes(odp.label));
    if (!assigned.length) add('ERROR', 'ODC_EMPTY', `ODC ${odc.label} has no ODP assigned.`, { odc_id: odc.label });
    if (assigned.length > options.odc_capacity) add('WARNING', 'ODC_OVER_CAPACITY', `ODC ${odc.label} serves ${assigned.length} ODPs (limit: ${options.odc_capacity}).`, { odc_id: odc.label, count: assigned.length, limit: options.odc_capacity });
    for (const odp of assigned) {
      const houses = customers.filter((house) => odp.members?.includes(house.label));
      if (!houses.length) add('WARNING', 'ODP_EMPTY', `ODP ${odp.label} (under ODC ${odc.label}) has no houses assigned.`, { odp_id: odp.label, odc_id: odc.label });
      if (houses.length > options.odp_capacity) add('WARNING', 'ODP_OVER_CAPACITY', `ODP ${odp.label} serves ${houses.length} houses (limit: ${options.odp_capacity}).`, { odp_id: odp.label, odc_id: odc.label, count: houses.length, limit: options.odp_capacity });
      houses.forEach((house, index) => {
        const meters = distance(odp.at, house.at);
        if (meters > options.max_odp_radius_m) add('WARNING', 'ODP_RADIUS_EXCEEDED', `ODP ${odp.label}: house #${index + 1} is ${meters.toFixed(0)}m away (limit: ${options.max_odp_radius_m.toFixed(0)}m).`, { odp_id: odp.label, house_index: index, distance_m: Math.round(meters * 10) / 10, limit_m: options.max_odp_radius_m });
      });
      const meters = distance(odc.at, odp.at);
      if (meters > options.max_odc_radius_m) add('WARNING', 'ODC_RADIUS_EXCEEDED', `ODC ${odc.label} → ODP ${odp.label} distance is ${meters.toFixed(0)}m (limit: ${options.max_odc_radius_m.toFixed(0)}m).`, { odc_id: odc.label, odp_id: odp.label, distance_m: Math.round(meters * 10) / 10, limit_m: options.max_odc_radius_m });
    }
  }
  const owners = new Map<string, string>();
  for (const odp of odps) for (const house of customers.filter((item) => odp.members?.includes(item.label))) {
    const key = `${house.at[1].toFixed(8)},${house.at[0].toFixed(8)}`, previous = owners.get(key);
    if (previous) add('ERROR', 'DUPLICATE_ASSIGNMENT', `House at (${house.at[1].toFixed(6)}, ${house.at[0].toFixed(6)}) is assigned to both ${previous} and ${odp.label}.`, { lat: house.at[1], lon: house.at[0], odp_1: previous, odp_2: odp.label });
    else owners.set(key, odp.label);
  }
  const feeders = cables.filter((cable) => cable.type === 'feeder');
  if (feeders.length < odcs.length) add('ERROR', 'DISCONNECTED_ODC', `Only ${feeders.length} of ${odcs.length} ODCs are connected by feeder segments.`, { connected: feeders.length, total: odcs.length });
  for (const cable of feeders) if (cable.length > options.max_feeder_length_m) add('ERROR', 'FEEDER_LENGTH_EXCEEDED', `Feeder ${cable.source || '?'} -> ${cable.target || '?'} is ${cable.length.toFixed(0)}m (limit: ${options.max_feeder_length_m.toFixed(0)}m).`, { from_label: cable.source, to_label: cable.target, length_m: Math.round(cable.length * 10) / 10, limit_m: options.max_feeder_length_m });
  const parents = new Map(cables.filter((cable) => cable.type === 'distribution').map((cable) => [cable.target, cable.source]));
  for (const odc of odcs) {
    const assigned = odps.filter((odp) => odc.members?.includes(odp.label)), ids = new Set(assigned.map((odp) => odp.label));
    for (const odp of assigned) {
      const parent = parents.get(odp.label), cable = cables.find((item) => item.type === 'distribution' && item.target === odp.label);
      if (!cable || !parent) { add('ERROR', 'DISCONNECTED_DISTRIBUTION', `ODP ${odp.label} tidak memiliki jalur distribusi yang terhubung.`, { odp_id: odp.label, odc_id: odc.label }); continue; }
      if (parent !== odc.label && !ids.has(parent)) add('ERROR', 'INVALID_DISTRIBUTION_PARENT', `Upstream ODP ${parent} untuk ${odp.label} berada di luar ODC ${odc.label}.`, { odp_id: odp.label, odc_id: odc.label, source_id: parent });
      if (cable.length > options.max_distribution_length_m) add('ERROR', 'DISTRIBUTION_LENGTH_EXCEEDED', `Jalur distribusi ke ${odp.label} sepanjang ${cable.length.toFixed(0)}m melewati batas ${options.max_distribution_length_m.toFixed(0)}m.`, { odp_id: odp.label, length_m: Math.round(cable.length * 10) / 10, limit_m: options.max_distribution_length_m });
      const seen = new Set<string>(); let current: string | undefined = odp.label, cycle = false;
      while (current && ids.has(current)) { if (seen.has(current)) { add('ERROR', 'DISTRIBUTION_CYCLE', `Ditemukan siklus pada tree distribusi ODC ${odc.label}.`, { odc_id: odc.label, odp_id: odp.label }); cycle = true; break; } seen.add(current); current = parents.get(current); }
      if (!cycle && current !== odc.label) add('ERROR', 'DISCONNECTED_DISTRIBUTION', `ODP ${odp.label} tidak memiliki jalur ke ODC ${odc.label}.`, { odp_id: odp.label, odc_id: odc.label });
    }
  }
  const errors = issues.filter((issue) => issue.severity === 'ERROR').length, warnings = issues.filter((issue) => issue.severity === 'WARNING').length;
  return { status: errors ? 'ERROR' : warnings ? 'WARNING' : 'PASS', issues, summary: { errors, warnings, info: 0 } };
}

export function addEdge(graph: Map<string, Node>, a: Coord, b: Coord, highway: unknown = 'residential', strategy = 'shortest', oneway: string | boolean = false, lengthM = distance(a, b), nodeIds?: [string, string]) {
  const key = ([lon, lat]: Coord) => `${lon.toFixed(7)},${lat.toFixed(7)}`;
  if (oneway === '-1') { [a, b] = [b, a]; if (nodeIds) [nodeIds[0], nodeIds[1]] = [nodeIds[1], nodeIds[0]]; }
  const directed = oneway === true || oneway === '-1' || ['yes', 'true', '1'].includes(String(oneway).toLowerCase());
  const from = nodeIds?.[0] ?? key(a), to = nodeIds?.[1] ?? key(b);
  if (!graph.has(from)) graph.set(from, { id: from, at: a, edges: [] });
  if (!graph.has(to)) graph.set(to, { id: to, at: b, edges: [] });
  const values = highwayValues(highway), highwayValue = values.length > 1 ? values : values[0] ?? String(highway);
  const weight = Math.max(lengthM, 0.01) * (strategy === 'priority_road' ? highwayFactor(highway) ?? 1.5 : 1);
  graph.get(from)!.edges.push({ to, weight, lengthM, highway: highwayValue, coords: [a, b], oneway: directed });
  if (!directed) graph.get(to)!.edges.push({ to: from, weight, lengthM, highway: highwayValue, coords: [b, a], oneway: false });
}

function serializedRoads(graph: Map<string, Node>) {
  return [...graph.values()].flatMap((node) => node.edges
    .filter((edge) => edge.oneway || node.id < edge.to)
    .map((edge) => ({ from_id: node.id, to_id: edge.to, coords: edge.coords, highway: edge.highway, oneway: edge.oneway, length_m: edge.lengthM })));
}

function closestNode(graph: Map<string, Node>, point: Coord) {
  let closest: Node | undefined, best = Infinity;
  for (const node of graph.values()) { const d = distance(point, node.at); if (d < best) { closest = node; best = d; } }
  return closest;
}

export function nearestRoadSegment(graph: Map<string, Node>, point: Coord) {
  let nearest: { from: Node; to: Node; point: Coord; fraction: number } | undefined, best = Infinity;
  for (const node of graph.values()) for (const edge of node.edges) {
    const to = graph.get(edge.to);
    if (!to) continue;
    const candidate = nearestOnLine(point, edge.coords), d = (point[0] - candidate[0]) ** 2 + (point[1] - candidate[1]) ** 2;
    if (d <= best) {
      const [a, b] = edge.coords, dx = b[0] - a[0], dy = b[1] - a[1];
      const fraction = Math.max(0, Math.min(1, ((candidate[0] - a[0]) * dx + (candidate[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      nearest = { from: node, to, point: candidate, fraction };
      best = d;
    }
  }
  return nearest;
}

function nearestRoadPoint(graph: Map<string, Node>, point: Coord): Coord | undefined {
  return nearestRoadSegment(graph, point)?.point;
}

export function walkAlongRoad(graph: Map<string, Node>, origin: Coord, distanceM: number, direction: number, branchChoice: number): Coord | undefined {
  let nearest: { from: Node; to: Node; point: Coord; fraction: number; lengthM: number } | undefined, best = Infinity;
  for (const from of graph.values()) for (const edge of from.edges) {
    const to = graph.get(edge.to);
    if (!to) continue;
    const point = nearestOnLine(origin, edge.coords), offset = distance(origin, point);
    if (offset < best) {
      const [a, b] = edge.coords, dx = b[0] - a[0], dy = b[1] - a[1];
      const fraction = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      nearest = { from, to, point, fraction, lengthM: edge.lengthM };
      best = offset;
    }
  }
  if (!nearest) return undefined;

  let remaining = distanceM;
  let at = nearest.point;
  let from = direction > 0 ? nearest.from : nearest.to;
  let to = direction > 0 ? nearest.to : nearest.from;
  const ratio = (point: Coord, a: Coord, b: Coord) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    return Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  };
  const fraction = nearest.fraction ?? ratio(nearest.point, nearest.from.at, nearest.to.at);
  let segment = (nearest.lengthM || distance(nearest.from.at, nearest.to.at)) * (direction > 0 ? 1 - fraction : fraction);
  for (let hop = 0; hop < 25; hop++) {
    if (remaining <= segment) {
      const progress = segment ? remaining / segment : 0;
      return [at[0] + (to.at[0] - at[0]) * progress, at[1] + (to.at[1] - at[1]) * progress];
    }
    remaining -= segment;
    at = to.at;
    const candidates: { from: Node; to: Node; lengthM: number }[] = to.edges
      .filter((edge) => edge.to !== from.id)
      .map((edge) => ({ from: to, to: graph.get(edge.to)!, lengthM: edge.lengthM }))
      .filter((edge) => edge.to && distance(edge.from.at, edge.to.at) > 0);
    for (const incoming of graph.values()) for (const edge of incoming.edges) {
      if (edge.to === to.id && incoming.id !== from.id) {
        const reverse = to.edges.find((candidate) => candidate.to === incoming.id);
        candidates.push({ from: to, to: incoming, lengthM: reverse?.lengthM ?? edge.lengthM });
      }
    }
    if (!candidates.length) return at;
    const chosen = candidates[branchChoice % candidates.length];
    // reference implementation cannot walk an incoming edge unless its reverse record exists.
    if (!chosen.from.edges.some((edge) => edge.to === chosen.to.id)) return undefined;
    from = chosen.from;
    to = chosen.to;
    segment = chosen.lengthM || distance(from.at, to.at);
  }
}

export function enforceOdcSpacing(graph: Map<string, Node>, odcs: Point[], minimumM = 40) {
  const walkCache = new Map<string, Coord | null>();
  const walk = (origin: Coord, direction: number, branch: number) => {
    const key = `${origin[0].toFixed(7)},${origin[1].toFixed(7)}:${direction}:${branch}:${minimumM}`;
    if (!walkCache.has(key)) walkCache.set(key, walkAlongRoad(graph, origin, minimumM, direction, branch) ?? null);
    return walkCache.get(key) ?? undefined;
  };
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    for (let i = 0; i < odcs.length; i++) for (let j = i + 1; j < odcs.length; j++) {
      if (distance(odcs[i].at, odcs[j].at) >= minimumM) continue;
      let candidate: Coord | undefined;
      for (const direction of [1, -1]) {
        for (let branch = 0; branch < 4; branch++) {
          const point = walk(odcs[i].at, direction, branch);
          if (point && odcs.every((odc, index) => index === j || distance(point, odc.at) >= minimumM)) {
            candidate = point;
            break;
          }
        }
        if (candidate) break;
      }
      if (candidate) { odcs[j].at = candidate; moved = true; }
    }
    if (!moved) break;
  }
}

function enforceStraightLineOdcSpacing(odcs: Point[], minimumM: number) {
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    for (let i = 0; i < odcs.length; i++) for (let j = i + 1; j < odcs.length; j++) {
      const [lon1, lat1] = odcs[i].at, [lon2, lat2] = odcs[j].at, separation = distance(odcs[i].at, odcs[j].at);
      if (separation >= minimumM) continue;
      const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180, deltaLon = (lon2 - lon1) * Math.PI / 180;
      const bearing = separation < 1e-6 ? (137.5 * j) % 360 : Math.atan2(Math.sin(deltaLon) * Math.cos(phi2), Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLon)) * 180 / Math.PI;
      const angular = minimumM / 6371000, theta = bearing * Math.PI / 180;
      const latitude = Math.asin(Math.sin(phi1) * Math.cos(angular) + Math.cos(phi1) * Math.sin(angular) * Math.cos(theta));
      const longitude = lon1 * Math.PI / 180 + Math.atan2(Math.sin(theta) * Math.sin(angular) * Math.cos(phi1), Math.cos(angular) - Math.sin(phi1) * Math.sin(latitude));
      odcs[j].at = [longitude * 180 / Math.PI, latitude * 180 / Math.PI];
      moved = true;
    }
    if (!moved) break;
  }
}

export function roundHalfEven(value: number) {
  const lower = Math.floor(value), fraction = value - lower;
  return fraction === 0.5 ? (lower % 2 === 0 ? lower : lower + 1) : Math.round(value);
}

export function rebalanceOdpsByRoadConnectivity(graph: Map<string, Node>, odcs: Point[], odps: Point[], maxLengthM: number, capacity: number, routeCache: Map<string, Coord[]>) {
  const odpByLabel = new Map(odps.map((odp) => [odp.label, odp]));
  const orderedLabels = odcs.flatMap((odc) => odc.members ?? []);
  const orderedOdps = orderedLabels.map((label) => odpByLabel.get(label)).filter((odp): odp is Point => Boolean(odp));
  const orderedSet = new Set(orderedOdps.map((odp) => odp.label));
  orderedOdps.push(...odps.filter((odp) => !orderedSet.has(odp.label)));
  const routedLength = (odc: Point, odp: Point) => {
    try { return pathLength(route(graph, odc.at, odp.at, routeCache)); }
    catch { return undefined; }
  };
  const assignment = assignOdpsGloballyByRoad(graph, odcs, orderedOdps, maxLengthM, capacity, routeCache, routedLength);
  if (assignment) {
    odcs.forEach((odc) => { odc.members = []; });
    assignment.forEach((odcIndex, odpIndex) => { odcs[odcIndex].members!.push(orderedOdps[odpIndex].label); });
  } else {
    for (const odp of orderedOdps) {
      const current = odcs.find((odc) => odc.members?.includes(odp.label));
      if (!current) continue;
      const currentLength = routedLength(current, odp);
      if (currentLength !== undefined && currentLength <= maxLengthM) continue;
      const nearby = odcs.filter((odc) => odc !== current).sort((a, b) => distance(a.at, odp.at) - distance(b.at, odp.at));
      for (const candidate of nearby) {
        const candidateLength = routedLength(candidate, odp);
        if (candidateLength === undefined || candidateLength > maxLengthM) continue;
        if ((candidate.members?.length ?? 0) < capacity) {
          current.members = current.members?.filter((label) => label !== odp.label) ?? [];
          candidate.members = [...(candidate.members ?? []), odp.label];
          break;
        }
        for (const swapLabel of candidate.members ?? []) {
          const swapOdp = odps.find((item) => item.label === swapLabel);
          if (!swapOdp) continue;
          const replacementLength = routedLength(current, swapOdp);
          const oldSwapLength = routedLength(candidate, swapOdp);
          if (replacementLength === undefined || replacementLength > maxLengthM || oldSwapLength === undefined) continue;
          if (candidateLength + replacementLength >= (currentLength ?? Infinity) + oldSwapLength) continue;
          current.members = [...(current.members?.filter((label) => label !== odp.label) ?? []), swapLabel];
          candidate.members = [...(candidate.members?.filter((label) => label !== swapLabel) ?? []), odp.label];
          break;
        }
        if (candidate.members?.includes(odp.label)) break;
      }
    }
  }
  let recoveryIndex = 1;
  for (const odp of orderedOdps) {
    const current = odcs.find((odc) => odc.members?.includes(odp.label));
    const length = current && routedLength(current, odp);
    if (length !== undefined && length <= maxLengthM) continue;
    let location = odp.at;
    let moved = false;
    for (const offset of [40, 20, 10]) {
      for (const direction of [1, -1]) {
        const candidate = walkAlongRoad(graph, odp.at, offset, direction, 0);
        if (candidate && distance(candidate, odp.at) > 1) { location = candidate; moved = true; break; }
      }
      if (moved) break;
    }
    if (!moved) {
      const nearest = nearestRoadSegment(graph, odp.at);
      const endpoint = nearest && [nearest.from.at, nearest.to.at].find((point) => distance(point, odp.at) > 1);
      if (endpoint) location = endpoint;
    }
    if (current) current.members = current.members?.filter((label) => label !== odp.label) ?? [];
    while (odcs.some((odc) => odc.label === `ODC-RECOVERY-${String(recoveryIndex).padStart(3, '0')}`)) recoveryIndex++;
    odcs.push({ label: `ODC-RECOVERY-${String(recoveryIndex++).padStart(3, '0')}`, at: location, members: [odp.label] });
  }
}

function networkSimplex(nodeCount: number, demands: number[], sources: number[], targets: number[], capacities: number[], weights: number[]) {
  const edgeCount = sources.length;
  const fauxInfinity = 3 * Math.max(capacities.reduce((sum, value) => sum + value, 0), weights.reduce((sum, value) => sum + Math.abs(value), 0), demands.reduce((sum, value) => sum + Math.abs(value), 0)) || 1;
  for (let node = 0; node < nodeCount; node++) {
    if (demands[node] > 0) { sources.push(nodeCount); targets.push(node); }
    else { sources.push(node); targets.push(nodeCount); }
    capacities.push(fauxInfinity);
    weights.push(fauxInfinity);
  }
  const flow = [...Array(edgeCount).fill(0), ...demands.map(Math.abs)];
  const potential = demands.map((demand) => demand <= 0 ? fauxInfinity : -fauxInfinity);
  const parent: (number | null)[] = [...Array(nodeCount).fill(nodeCount), null];
  const parentEdge: (number | null)[] = Array.from({ length: nodeCount }, (_, index) => edgeCount + index);
  const parentEdgeAt = (node: number) => parentEdge[node === nodeCount ? nodeCount - 1 : node];
  const setParentEdge = (node: number, edge: number | null) => { parentEdge[node === nodeCount ? nodeCount - 1 : node] = edge; };
  const subtreeSize = [...Array(nodeCount).fill(1), nodeCount + 1];
  const nextNode = [...Array.from({ length: nodeCount - 1 }, (_, index) => index + 1), nodeCount, 0];
  const previousNode = [nodeCount, ...Array.from({ length: nodeCount }, (_, index) => index)];
  const lastDescendant = [...Array.from({ length: nodeCount }, (_, index) => index), nodeCount - 1];

  const reducedCost = (edge: number) => {
    const cost = weights[edge] - potential[sources[edge]] + potential[targets[edge]];
    return flow[edge] === 0 ? cost : -cost;
  };
  const residualCapacity = (edge: number, from: number) => sources[edge] === from ? capacities[edge] - flow[edge] : flow[edge];
  const findApex = (leftStart: number, rightStart: number) => {
    let left = leftStart, right = rightStart, leftSize = subtreeSize[left], rightSize = subtreeSize[right];
    for (let steps = 0; steps <= nodeCount; steps++) {
      while (leftSize < rightSize) { left = parent[left]!; if (left === null) throw new Error('Network simplex tree is disconnected.'); leftSize = subtreeSize[left]; }
      while (leftSize > rightSize) { right = parent[right]!; if (right === null) throw new Error('Network simplex tree is disconnected.'); rightSize = subtreeSize[right]; }
      if (leftSize !== rightSize) continue;
      if (left !== right) {
        left = parent[left]!; right = parent[right]!;
        if (left === null || right === null) throw new Error('Network simplex tree is disconnected.');
        leftSize = subtreeSize[left]; rightSize = subtreeSize[right];
      } else return left;
    }
    throw new Error('Network simplex spanning tree contains a parent cycle.');
  };
  const tracePath = (start: number, ancestor: number) => {
    const nodes = [start], edges: number[] = [];
    while (start !== ancestor && edges.length <= nodeCount) { edges.push(parentEdgeAt(start)!); start = parent[start]!; nodes.push(start); }
    if (start !== ancestor) throw new Error('Network simplex path does not reach its ancestor.');
    return { nodes, edges };
  };
  const findCycle = (edge: number, from: number, to: number) => {
    const apex = findApex(from, to), left = tracePath(from, apex);
    left.nodes.reverse(); left.edges.reverse();
    if (left.edges.length !== 1 || left.edges[0] !== edge) left.edges.push(edge);
    const right = tracePath(to, apex);
    right.nodes.pop();
    return { nodes: [...left.nodes, ...right.nodes], edges: [...left.edges, ...right.edges] };
  };
  const traceSubtree = (root: number) => {
    const nodes = [root], last = lastDescendant[root];
    while (root !== last && nodes.length <= nodeCount + 1) { root = nextNode[root]; nodes.push(root); }
    if (root !== last) throw new Error('Network simplex depth-first thread contains a cycle.');
    return nodes;
  };
  const removeEdge = (above: number, below: number) => {
    const size = subtreeSize[below], before = previousNode[below], last = lastDescendant[below], after = nextNode[last];
    parent[below] = null; setParentEdge(below, null);
    nextNode[before] = after; previousNode[after] = before;
    nextNode[last] = below; previousNode[below] = last;
    for (let steps = 0; above !== null && steps <= nodeCount; steps++) {
      subtreeSize[above] -= size;
      if (lastDescendant[above] === last) lastDescendant[above] = before;
      above = parent[above]!;
    }
    if (above !== null) throw new Error('Network simplex parent cycle while removing an edge.');
  };
  const makeRoot = (node: number) => {
    const ancestors: number[] = [];
    while (node !== null && ancestors.length <= nodeCount) { ancestors.push(node); node = parent[node]!; }
    if (node !== null) throw new Error('Network simplex parent cycle while rerooting tree.');
    ancestors.reverse();
    for (let index = 0; index < ancestors.length - 1; index++) {
      const p = ancestors[index], q = ancestors[index + 1], sizeP = subtreeSize[p], lastP = lastDescendant[p], prevQ = previousNode[q], lastQ = lastDescendant[q], nextLastQ = nextNode[lastQ];
      parent[p] = q; parent[q] = null;
      setParentEdge(p, parentEdgeAt(q) ?? null); setParentEdge(q, null);
      subtreeSize[p] = sizeP - subtreeSize[q]; subtreeSize[q] = sizeP;
      nextNode[prevQ] = nextLastQ; previousNode[nextLastQ] = prevQ;
      nextNode[lastQ] = q; previousNode[q] = lastQ;
      let newLastP = lastP;
      if (lastP === lastQ) { lastDescendant[p] = prevQ; newLastP = prevQ; }
      previousNode[p] = lastQ; nextNode[lastQ] = p;
      nextNode[newLastP] = q; previousNode[q] = newLastP;
      lastDescendant[q] = newLastP;
    }
  };
  const addTreeEdge = (edge: number, from: number, to: number) => {
    const lastFrom = lastDescendant[from], afterFrom = nextNode[lastFrom], sizeTo = subtreeSize[to], lastTo = lastDescendant[to];
    parent[to] = from; setParentEdge(to, edge);
    nextNode[lastFrom] = to; previousNode[to] = lastFrom;
    previousNode[afterFrom] = lastTo; nextNode[lastTo] = afterFrom;
    for (let steps = 0; from !== null && steps <= nodeCount; steps++) {
      subtreeSize[from] += sizeTo;
      if (lastDescendant[from] === lastFrom) lastDescendant[from] = lastTo;
      from = parent[from]!;
    }
    if (from !== null) throw new Error('Network simplex parent cycle while adding edge.');
  };
  const updatePotentials = (edge: number, from: number, subtree: number) => {
    const delta = subtree === targets[edge]
      ? potential[from] - weights[edge] - potential[subtree]
      : potential[from] + weights[edge] - potential[subtree];
    for (const node of traceSubtree(subtree)) potential[node] += delta;
  };

  if (edgeCount) {
    const blockSize = Math.ceil(Math.sqrt(edgeCount)), blockCount = Math.ceil(edgeCount / blockSize);
    let emptyBlocks = 0, first = 0;
    while (emptyBlocks < blockCount) {
      let block: number[];
      const end = first + blockSize;
      if (end <= edgeCount) block = Array.from({ length: blockSize }, (_, i) => first + i);
      else block = [...Array.from({ length: edgeCount - first }, (_, i) => first + i), ...Array.from({ length: end - edgeCount }, (_, i) => i)];
      first = end % edgeCount;
      let entering = block[0], enteringCost = reducedCost(entering);
      for (const edge of block.slice(1)) { const cost = reducedCost(edge); if (cost < enteringCost) { entering = edge; enteringCost = cost; } }
      if (enteringCost >= 0) { emptyBlocks++; continue; }
      const from = flow[entering] === 0 ? sources[entering] : targets[entering];
      const to = flow[entering] === 0 ? targets[entering] : sources[entering];
      const cycle = findCycle(entering, from, to);
      let leaving = cycle.edges.at(-1)!, leavingFrom = cycle.nodes.at(-1)!;
      for (let index = cycle.edges.length - 2; index >= 0; index--) {
        const edge = cycle.edges[index], node = cycle.nodes[index], capacity = residualCapacity(edge, node);
        if (capacity < residualCapacity(leaving, leavingFrom)) { leaving = edge; leavingFrom = node; }
      }
      const amount = residualCapacity(leaving, leavingFrom);
      for (let index = 0; index < cycle.edges.length; index++) {
        const edge = cycle.edges[index], node = cycle.nodes[index];
        flow[edge] += sources[edge] === node ? amount : -amount;
      }
      emptyBlocks = 0;
      if (entering !== leaving) {
        let treeFrom = leavingFrom, treeTo = targets[leaving] === leavingFrom ? sources[leaving] : targets[leaving];
        if (parent[treeTo] !== treeFrom) [treeFrom, treeTo] = [treeTo, treeFrom];
        let newFrom = from, newTo = to;
        if (cycle.edges.indexOf(entering) > cycle.edges.indexOf(leaving)) [newFrom, newTo] = [newTo, newFrom];
        removeEdge(treeFrom, treeTo);
        makeRoot(newTo);
        addTreeEdge(entering, newFrom, newTo);
        updatePotentials(entering, newFrom, newTo);
      }
    }
  }
  const remainingFakeFlow = flow.slice(edgeCount);
  return remainingFakeFlow.every((value) => value === 0) ? flow.slice(0, edgeCount) : undefined;
}

function assignOdpsGloballyByRoad(
  graph: Map<string, Node>, odcs: Point[], odps: Point[], maxLengthM: number, capacity: number,
  routeCache: Map<string, Coord[]>, routedLength: (odc: Point, odp: Point) => number | undefined,
): number[] | undefined {
  if (!odcs.length || !odps.length) return [];
  const routeLengths = new Map<string, number>();
  const key = (odpIndex: number, odcIndex: number) => `${odpIndex}:${odcIndex}`;
  const addOption = (odpIndex: number, odcIndex: number) => {
    const id = key(odpIndex, odcIndex);
    if (!routeLengths.has(id)) {
      const length = routedLength(odcs[odcIndex], odps[odpIndex]);
      if (length !== undefined) routeLengths.set(id, length);
    }
  };
  const initialCount = Math.min(odcs.length, Math.max(12, capacity * 4));
  for (let odpIndex = 0; odpIndex < odps.length; odpIndex++) {
    const currentIndex = odcs.findIndex((odc) => odc.members?.includes(odps[odpIndex].label));
    const nearest = odcs.map((odc, odcIndex) => ({ odcIndex, distance: distance(odc.at, odps[odpIndex].at) }))
      .sort((a, b) => a.distance - b.distance || a.odcIndex - b.odcIndex)
      .slice(0, initialCount).map(({ odcIndex }) => odcIndex);
    if (currentIndex >= 0 && !nearest.includes(currentIndex)) nearest.push(currentIndex);
    nearest.forEach((odcIndex) => addOption(odpIndex, odcIndex));
  }

  const solve = () => {
    const source = 0, sink = 1, odpStart = 2, odcStart = odpStart + odps.length, nodeCount = odcStart + odcs.length;
    const demands = Array(nodeCount).fill(0);
    demands[source] = -odps.length;
    demands[sink] = odps.length;
    const sources: number[] = [], targets: number[] = [], capacities: number[] = [], weights: number[] = [];
    const assignmentEdges: { odpIndex: number; odcIndex: number; edgeIndex: number }[] = [];
    const addEdge = (from: number, to: number, edgeCapacity: number, cost: number) => {
      sources.push(from); targets.push(to); capacities.push(edgeCapacity); weights.push(cost);
    };
    // NetworkX visits nodes in insertion order, then each node's outgoing edges.
    odps.forEach((_, index) => addEdge(source, odpStart + index, 1, 0));
    for (let odpIndex = 0; odpIndex < odps.length; odpIndex++) for (const [id, length] of routeLengths) {
      const [edgeOdp, odcIndex] = id.split(':').map(Number);
      if (edgeOdp !== odpIndex) continue;
      const routePenalty = length > maxLengthM ? maxLengthM * 1000 : 0;
      assignmentEdges.push({ odpIndex, odcIndex, edgeIndex: sources.length });
      addEdge(odpStart + odpIndex, odcStart + odcIndex, 1, roundHalfEven((length + routePenalty) * 100));
    }
    odcs.forEach((_, index) => addEdge(odcStart + index, sink, capacity, 0));
    const flows = networkSimplex(nodeCount, demands, sources, targets, capacities, weights);
    if (!flows) return undefined;
    const assignment = Array(odps.length).fill(-1);
    for (const edge of assignmentEdges) if (flows[edge.edgeIndex] > 0) assignment[edge.odpIndex] = edge.odcIndex;
    return assignment.every((index) => index >= 0) ? assignment : undefined;
  };

  let assignment = solve();
  if (!assignment) {
    for (let odpIndex = 0; odpIndex < odps.length; odpIndex++) for (let odcIndex = 0; odcIndex < odcs.length; odcIndex++) addOption(odpIndex, odcIndex);
    assignment = solve();
  }
  if (!assignment) return undefined;
  const outliers = assignment.flatMap((odcIndex, odpIndex) => {
    const length = routeLengths.get(key(odpIndex, odcIndex));
    return length === undefined || length > maxLengthM ? [odpIndex] : [];
  });
  if (outliers.length) {
    for (const odpIndex of outliers) for (let odcIndex = 0; odcIndex < odcs.length; odcIndex++) addOption(odpIndex, odcIndex);
    assignment = solve();
  }
  return assignment;
}

function stableDistanceOrder(points: Coord[], indexes: number[], origin: Coord) {
  const key = (point: Coord) => Math.floor(Math.hypot(point[0] - origin[0], point[1] - origin[1]) * 1e12 + 0.5);
  return indexes.map((index, position) => ({ position, distance: key(points[index]) }))
    .sort((a, b) => a.distance - b.distance || a.position - b.position)
    .map(({ position }) => position);
}

export function capacitatedClusters(points: Coord[], capacity: number, minSize = 1): number[][] {
  if (!points.length) return [];
  if (points.length < minSize) throw new BadRequestException(`Tidak cukup titik untuk membentuk cluster berisi minimal ${minSize} titik.`);
  if (points.length <= capacity) return [points.map((_, index) => index)];
  const count = Math.ceil(points.length / capacity), base = Math.floor(points.length / count), extra = points.length % count;
  if (base < minSize) throw new BadRequestException(`Titik tidak dapat dibagi ke cluster berukuran ${minSize} sampai ${capacity}.`);
  const sizes = minSize > 1 ? Array.from({ length: count }, (_, i) => base + Number(i < extra)) : Array(count).fill(capacity);
  let remaining = points.map((_, index) => index), previous: Coord | undefined;
  const clusters: number[][] = [];
  // Match random.Random(42).randint(0, n - 1) so the first cluster starts at
  // the same house index as the reference implementation generator.
  const seededRandomIndex = (length: number) => {
    const size = 624, state = new Uint32Array(size);
    state[0] = 19650218;
    for (let i = 1; i < size; i++) state[i] = (Math.imul(1812433253, state[i - 1] ^ (state[i - 1] >>> 30)) + i) >>> 0;
    let i = 1, j = 0;
    for (let k = size; k > 0; k--) {
      state[i] = ((state[i] ^ Math.imul(state[i - 1] ^ (state[i - 1] >>> 30), 1664525)) + 42 + j) >>> 0;
      i++; j++;
      if (i >= size) { state[0] = state[size - 1]; i = 1; }
      if (j >= 1) j = 0;
    }
    for (let k = size - 1; k > 0; k--) {
      state[i] = ((state[i] ^ Math.imul(state[i - 1] ^ (state[i - 1] >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= size) { state[0] = state[size - 1]; i = 1; }
    }
    state[0] = 0x80000000;
    let index = size;
    const next = () => {
      if (index >= size) {
        for (let k = 0; k < size; k++) {
          const y = (state[k] & 0x80000000) | (state[(k + 1) % size] & 0x7fffffff);
          state[k] = (state[(k + 397) % size] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0)) >>> 0;
        }
        index = 0;
      }
      let y = state[index++];
      y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= y >>> 18;
      return y >>> 0;
    };
    const bits = Math.floor(Math.log2(length)) + 1;
    let value: number;
    do { value = next() >>> (32 - bits); } while (value >= length);
    return value;
  };
  while (remaining.length) {
    let seedPosition: number;
    if (!previous) {
      seedPosition = seededRandomIndex(remaining.length);
    } else {
      seedPosition = remaining.reduce((best, index, i) => {
        const current = points[index], chosen = points[remaining[best]];
        const key = (point: Coord) => Math.floor(Math.hypot(point[0] - previous![0], point[1] - previous![1]) * 1e12 + 0.5);
        return key(current) < key(chosen) ? i : best;
      }, 0);
    }
    const seed = points[remaining[seedPosition]];
    const targetSize = sizes[clusters.length] ?? remaining.length;
    const chosen = stableDistanceOrder(points, remaining, seed).slice(0, targetSize).map((position) => remaining[position]);
    clusters.push(chosen);
    previous = [chosen.reduce((sum, i) => sum + points[i][0], 0) / chosen.length, chosen.reduce((sum, i) => sum + points[i][1], 0) / chosen.length];
    const selected = new Set(chosen);
    remaining = remaining.filter((index) => !selected.has(index));
  }
  return clusters;
}

function snapGeneratedPoint(graph: Map<string, Node>, point: Coord, maxDistance: number): Coord {
  const nearest = nearestRoadPoint(graph, point);
  if (!nearest) throw apiError('OSM_UNAVAILABLE', 'Jaringan jalan kendaraan OSM tidak tersedia untuk menempatkan perangkat.', 503);
  const snapDistance = distance(point, nearest);
  if (snapDistance > Math.max(maxDistance, 1500)) throw new BadRequestException(`Titik perangkat berjarak ${snapDistance.toFixed(0)}m dari jalan; batas otomatis 1500m.`);
  return nearest;
}

type QueueItem = { id: string; cost: number; priority?: number; order?: number };
const queuePriority = (item: QueueItem) => item.priority ?? item.cost;
let nextQueueOrder = 0;
const comesBefore = (left: QueueItem, right: QueueItem) => queuePriority(left) < queuePriority(right)
  || (queuePriority(left) === queuePriority(right) && (left.order ?? 0) < (right.order ?? 0));
function pushMin(queue: QueueItem[], item: QueueItem) {
  item.order = nextQueueOrder++;
  queue.push(item);
  for (let index = queue.length - 1; index > 0;) {
    const parent = Math.floor((index - 1) / 2);
    if (!comesBefore(queue[index], queue[parent])) break;
    [queue[parent], queue[index]] = [queue[index], queue[parent]];
    index = parent;
  }
}
function popMin(queue: QueueItem[]): QueueItem | undefined {
  if (!queue.length) return;
  const first = queue[0], last = queue.pop()!;
  if (queue.length) {
    queue[0] = last;
    for (let index = 0;;) {
      const left = index * 2 + 1, right = left + 1;
      let smallest = index;
      if (left < queue.length && comesBefore(queue[left], queue[smallest])) smallest = left;
      if (right < queue.length && comesBefore(queue[right], queue[smallest])) smallest = right;
      if (smallest === index) break;
      [queue[index], queue[smallest]] = [queue[smallest], queue[index]];
      index = smallest;
    }
  }
  return first;
}

function routeOnGraph(graph: Map<string, Node>, start: Coord, end: Coord, cache?: Map<string, Coord[]>): Coord[] {
  const cacheKey = `${start[0].toFixed(7)},${start[1].toFixed(7)}>${end[0].toFixed(7)},${end[1].toFixed(7)}`;
  const cached = cache?.get(cacheKey);
  if (cached) return cached.map((point) => [...point] as Coord);
  const source = nearestRoadSegment(graph, start), target = nearestRoadSegment(graph, end);
  if (!source || !target) throw new Error('Jaringan jalan kendaraan OSM tidak tersedia untuk routing.');
  const sameSegment = (source.from.id === target.from.id && source.to.id === target.to.id)
    || (source.from.id === target.to.id && source.to.id === target.from.id);
  if (sameSegment) {
    const path = [start, source.point, target.point, end];
    cache?.set(cacheKey, path);
    return path;
  }
  const starts: { id: string; cost: number }[] = [], finishes: { id: string; cost: number }[] = [];
  // A fiber cable can enter or leave a road segment from either endpoint;
  // vehicle one-way restrictions only govern the graph path between endpoints.
  starts.push({ id: source.from.id, cost: distance(source.point, source.from.at) });
  starts.push({ id: source.to.id, cost: distance(source.point, source.to.at) });
  finishes.push({ id: target.from.id, cost: distance(target.point, target.from.at) });
  finishes.push({ id: target.to.id, cost: distance(target.point, target.to.at) });
  if (!starts.length || !finishes.length) throw new Error('Tidak ditemukan jalur jalan yang menghubungkan titik desain.');
  let best: { cost: number; startId: string; endId: string; pieces: Coord[][] } | undefined;
  for (const sourceOption of starts) for (const targetOption of finishes) {
    const dist = new Map<string, number>([[sourceOption.id, 0]]), prev = new Map<string, { id: string; coords: Coord[] }>();
    const queue: QueueItem[] = [{ id: sourceOption.id, cost: 0, priority: 0.85 * distance(graph.get(sourceOption.id)!.at, graph.get(targetOption.id)!.at) }];
    while (queue.length) {
      const item = popMin(queue)!, cost = dist.get(item.id);
      if (cost === undefined || item.cost !== cost) continue;
      if (item.id === targetOption.id) break;
      for (const edge of graph.get(item.id)!.edges) {
        const next = cost + edge.weight;
        if (next < (dist.get(edge.to) ?? Infinity)) {
          dist.set(edge.to, next); prev.set(edge.to, { id: item.id, coords: edge.coords });
          const heuristic = 0.85 * distance(graph.get(edge.to)!.at, graph.get(targetOption.id)!.at);
          pushMin(queue, { id: edge.to, cost: next, priority: next + heuristic });
        }
      }
    }
    const networkCost = dist.get(targetOption.id);
    if (networkCost === undefined) continue;
    const total = sourceOption.cost + networkCost + targetOption.cost;
    if (best && total >= best.cost) continue;
    const pieces: Coord[][] = [];
    let current = targetOption.id;
    while (current !== sourceOption.id) {
      const step = prev.get(current);
      if (!step) break;
      pieces.push(step.coords); current = step.id;
    }
    if (current === sourceOption.id) best = { cost: total, startId: sourceOption.id, endId: targetOption.id, pieces: pieces.reverse() };
  }
  if (!best) throw new Error('Tidak ditemukan jalur jalan yang menghubungkan titik desain.');
  const path: Coord[] = [start, source.point, graph.get(best.startId)!.at, ...best.pieces.flatMap((part, index) => index ? part.slice(1) : part), graph.get(best.endId)!.at, target.point, end];
  const compact = path.filter((point, index) => !index || distance(point, path[index - 1]) > 0.01);
  cache?.set(cacheKey, compact);
  return compact;
}

export function route(graph: Map<string, Node>, start: Coord, end: Coord, cache?: Map<string, Coord[]>): Coord[] {
  try { return routeOnGraph(graph, start, end, cache); }
  catch (error) {
    const undirected = new Map([...graph].map(([id, node]) => [id, { ...node, edges: [...node.edges] }]));
    for (const node of graph.values()) for (const edge of node.edges) if (edge.oneway) {
      undirected.get(edge.to)?.edges.push({ ...edge, to: node.id, coords: [...edge.coords].reverse(), oneway: false });
    }
    try { return routeOnGraph(undirected, start, end, cache); }
    catch { throw error; }
  }
}

const pathLength = (coords: Coord[]) => coords.slice(1).reduce((sum, point, index) => sum + distance(coords[index], point), 0);
function pathRoutingCost(graph: Map<string, Node>, coords: Coord[]) {
  const key = ([lon, lat]: Coord) => `${lon.toFixed(7)},${lat.toFixed(7)}`;
  return coords.slice(1).reduce((sum, point, index) => {
    const from = key(coords[index]), to = key(point);
    const edge = graph.get(from)?.edges.find((item) => item.to === to)
      ?? graph.get(to)?.edges.find((item) => item.to === from && item.oneway);
    if (edge) return sum + edge.weight;
    const midpoint: Coord = [(coords[index][0] + point[0]) / 2, (coords[index][1] + point[1]) / 2];
    const segment = nearestRoadSegment(graph, midpoint);
    const roadEdge = segment && (graph.get(segment.from.id)?.edges.find((item) => item.to === segment.to.id)
      ?? graph.get(segment.to.id)?.edges.find((item) => item.to === segment.from.id));
    const roadLength = segment && distance(segment.from.at, segment.to.at);
    const factor = roadEdge && roadLength ? roadEdge.weight / roadLength : 1;
    return sum + distance(coords[index], point) * factor;
  }, 0);
}

function buildDistributionTree(graph: Map<string, Node>, odc: Point, odps: Point[], maxLengthM: number, routeCache: Map<string, Coord[]>): Cable[] {
  const candidates: { source: Point; target: Point; coords: Coord[]; length: number; routingCost: number }[] = [];
  const addCandidate = (source: Point, target: Point) => {
    try {
      const coords = route(graph, source.at, target.at, routeCache), length = pathLength(coords);
      if (length <= maxLengthM) candidates.push({ source, target, coords, length, routingCost: pathRoutingCost(graph, coords) });
    } catch { /* an unavailable road connection is not an edge in the tree */ }
  };
  for (const odp of odps) addCandidate(odc, odp);
  for (let index = 0; index < odps.length; index++) for (let next = index + 1; next < odps.length; next++) addCandidate(odps[index], odps[next]);
  candidates.sort((a, b) => Number(a.source !== odc) - Number(b.source !== odc) || a.routingCost - b.routingCost || a.length - b.length || a.source.label.localeCompare(b.source.label) || a.target.label.localeCompare(b.target.label));

  const parent = new Map([odc, ...odps].map((point) => [point.label, point.label]));
  const find = (label: string): string => {
    const root = parent.get(label)!;
    if (root === label) return label;
    const result = find(root);
    parent.set(label, result);
    return result;
  };
  const selected: typeof candidates = [];
  const union = (source: string, target: string) => {
    const left = find(source), right = find(target);
    if (left === right) return false;
    parent.set(right, left);
    return true;
  };
  for (const candidate of candidates) {
    if (union(candidate.source.label, candidate.target.label)) selected.push(candidate);
    if (selected.length === odps.length) break;
  }
  const selectedTargets = new Set(selected.map((candidate) => candidate.target.label));
  for (const odp of odps) {
    if (selectedTargets.has(odp.label)) continue;
    const direct = candidates.find((candidate) => candidate.source === odc && candidate.target === odp);
    if (direct && union(direct.source.label, direct.target.label)) selected.push(direct);
  }

  const adjacency = new Map<string, { target: string; candidate: (typeof candidates)[number]; reverse: boolean }[]>();
  for (const candidate of selected) {
    adjacency.set(candidate.source.label, [...(adjacency.get(candidate.source.label) ?? []), { target: candidate.target.label, candidate, reverse: false }]);
    adjacency.set(candidate.target.label, [...(adjacency.get(candidate.target.label) ?? []), { target: candidate.source.label, candidate, reverse: true }]);
  }
  const points = new Map([odc, ...odps].map((point) => [point.label, point]));
  const visited = new Set([odc.label]), queue = [odc.label], cables: Cable[] = [];
  while (queue.length) {
    const source = queue.shift()!;
    for (const edge of adjacency.get(source) ?? []) {
      if (visited.has(edge.target)) continue;
      visited.add(edge.target);
      queue.push(edge.target);
      const sourcePoint = points.get(source)!, targetPoint = points.get(edge.target)!;
      const coords = (edge.reverse ? [...edge.candidate.coords].reverse() : [...edge.candidate.coords]).map((point) => [...point] as Coord);
      if (coords.length) { coords[0] = sourcePoint.at; coords[coords.length - 1] = targetPoint.at; }
      cables.push({ type: 'distribution', source, target: edge.target, coords, length: edge.candidate.length });
    }
  }
  return cables;
}

export function requireCompleteDistributionTree(odcLabel: string, assigned: Point[], distribution: Cable[]) {
  const connected = new Set(distribution.map((cable) => cable.target));
  const missing = assigned.filter((odp) => !connected.has(odp.label));
  if (missing.length) throw apiError('ROUTING_FAILED', `ODP tidak terhubung ke tree distribusi ${odcLabel}: ${missing.map((odp) => odp.label).join(', ')}.`, 500);
}

export function requireDistributionConnectivity(odcs: Point[], odps: Point[], distribution: Cable[]) {
  const connected = new Set(distribution.map((cable) => cable.target));
  const odpByLabel = new Map(odps.map((odp) => [odp.label, odp]));
  const missing = odcs.flatMap((odc) => (odc.members ?? [])
    .map((label) => odpByLabel.get(label))
    .filter((odp): odp is Point => odp !== undefined && !connected.has(odp.label))
    .map((odp) => `${odp.label} (ODC ${odc.label})`));
  if (missing.length) throw apiError('ROUTING_FAILED', `${missing.length} ODP belum tersambung ke jaringan jalan: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' ...' : ''}. Routing sudah mencoba jalan satu arah dan dua arah; periksa posisi ODP/ODC agar menempel pada jalan kendaraan yang sama. Kabel lurus otomatis tidak dibuat karena dapat melewati bangunan.`, 500);
}

function orderOdcChain(pop: Coord, odcs: Point[]): Point[] {
  const remaining = [...odcs], ordered: Point[] = [];
  let current = pop;
  while (remaining.length) {
    const nearest = remaining.reduce((best, odc) => Math.hypot(current[0] - odc.at[0], current[1] - odc.at[1]) < Math.hypot(current[0] - best.at[0], current[1] - best.at[1]) ? odc : best, remaining[0]);
    ordered.push(nearest);
    remaining.splice(remaining.indexOf(nearest), 1);
    current = nearest.at;
  }
  let improved = true, passes = 0;
  while (improved && passes++ < 200 && ordered.length > 2) {
    improved = false;
    for (let i = 0; i < ordered.length - 1; i++) for (let j = i + 1; j < ordered.length; j++) {
      const left = i ? ordered[i - 1].at : pop, first = ordered[i].at, last = ordered[j].at, right = ordered[j + 1]?.at;
      const oldLength = distance(left, first) + (right ? distance(last, right) : 0), newLength = distance(left, last) + (right ? distance(first, right) : 0);
      if (newLength < oldLength - 1e-6) { ordered.splice(i, j - i + 1, ...ordered.slice(i, j + 1).reverse()); improved = true; }
    }
  }
  return ordered;
}

function houseIconPng(value: unknown): Buffer {
  const match = typeof value === 'string' ? /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim()) : null;
  const hex = match?.[1].length === 3 ? [...match[1]].map((part) => part + part).join('') : match?.[1];
  const color = hex ? [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) : [107, 114, 128];
  const scale = 4, size = 96 * scale, pixels = Buffer.alloc(size * size * 4);
  const blend = (x: number, y: number, rgb: number[]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = (y * size + x) * 4;
    pixels[offset] = rgb[0]; pixels[offset + 1] = rgb[1]; pixels[offset + 2] = rgb[2]; pixels[offset + 3] = 255;
  };
  const circle = (cx: number, cy: number, radius: number, rgb: number[]) => {
    cx *= size / 24; cy *= size / 24; radius *= size / 24;
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(size - 1, Math.ceil(cy + radius)); y++) for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(size - 1, Math.ceil(cx + radius)); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) blend(x, y, rgb);
  };
  const line = (points: number[][], rgb: number[], width: number) => {
    const segments = points.slice(1).map((point, index) => [points[index], point]);
    for (const [[x1, y1], [x2, y2]] of segments) {
      const ax = x1 * size / 24, ay = y1 * size / 24, bx = x2 * size / 24, by = y2 * size / 24, radius = width * size / 48;
      const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
      for (let y = Math.max(0, Math.floor(Math.min(ay, by) - radius)); y <= Math.min(size - 1, Math.ceil(Math.max(ay, by) + radius)); y++) for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - radius)); x <= Math.min(size - 1, Math.ceil(Math.max(ax, bx) + radius)); x++) {
        const t = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
        if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= radius ** 2) blend(x, y, rgb);
      }
    }
  };
  circle(12, 12, 12, color); circle(12, 12, 10, [249, 250, 251]);
  line([[6.75, 10.25], [12, 6.166], [17.25, 10.25], [17.25, 16.67], [16.08, 17.83], [7.92, 17.83], [6.75, 16.67], [6.75, 10.25]], color, 2);
  line([[10.25, 17.83], [10.25, 12], [13.75, 12], [13.75, 17.83]], color, 2);
  const rows = Buffer.alloc(96 * (96 * 4 + 1));
  for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) for (let channel = 0; channel < 4; channel++) {
    let sum = 0;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) sum += pixels[(((y * scale + dy) * size + x * scale + dx) * 4) + channel];
    rows[y * 385 + 1 + x * 4 + channel] = Math.floor(sum / (scale * scale) + 0.5);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const chunk = (type: string, data: Buffer) => {
    const kind = Buffer.from(type), body = Buffer.concat([kind, data]); let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(96, 0); ihdr.writeUInt32BE(96, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

async function buildKmz(kml: string, featureColors: Record<string, string>) {
  return new JSZip().file('doc.kml', kml).file('files/ftth-house.png', houseIconPng(normalizeFeatureColors(featureColors).house), { createFolders: false }).generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function buildKml(pop: Point, odcs: Point[], odps: Point[], customers: Point[], cables: Cable[], featureColors: Record<string, string>, boundaries: Boundary[] = [], odpCapacity = 10, odcCapacity = 4) {
  const palette = normalizeFeatureColors(featureColors);
  const color = (value: unknown) => {
    const input = typeof value === 'string' ? value.trim() : '';
    const full = /^#?([0-9a-f]{6})$/i.exec(input);
    if (full) return full[1].toLowerCase();
    const short = /^#([0-9a-f]{3})$/i.exec(input);
    return short ? [...short[1]].map((part) => part + part).join('') : '6b7280';
  };
  const kmlColor = (value: unknown, alpha = 'ff') => { const hex = color(value); return `${alpha}${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`; };
  const iconStyle = (id: string, hex: unknown, href: string, scale: number) => `<Style id="${id}"><IconStyle><color>${kmlColor(hex)}</color><scale>${scale}</scale><Icon><href>${href}</href></Icon><hotSpot x="0.5" y="0.5" xunits="fraction" yunits="fraction"/></IconStyle></Style>`;
  const lineStyle = (id: string, hex: unknown, width: number) => `<Style id="${id}"><LineStyle><color>${kmlColor(hex)}</color><width>${width}</width></LineStyle></Style>`;
  const data = (name: string) => `<ExtendedData><Data name="name"><value>${escape(name)}</value></Data></ExtendedData>`;
  const pointMark = (name: string, description: string, style: string, at: Coord) => `<Placemark><name>${escape(name)}</name><description>${escape(description)}</description>${data(name)}<styleUrl>#${style}</styleUrl><Point><coordinates>${at[0]},${at[1]},0.0</coordinates></Point></Placemark>`;
  const lineMark = (_name: string, coords: Coord[], _style: string) => `<LineString><tessellate>1</tessellate><coordinates>${coords.map(([lon, lat]) => `${lon},${lat},0.0`).join(' ')}</coordinates></LineString>`;
  const odcLabel = new Map(odcs.map((odc, index) => [odc.label, `ODC${String(index + 1).padStart(3, '0')}`]));
  const odpByLabel = new Map(odps.map((odp) => [odp.label, odp]));
  const orderedOdps = odcs.flatMap((odc) => (odc.members ?? []).map((label) => odpByLabel.get(label)).filter((odp): odp is Point => Boolean(odp)));
  const odpLabel = new Map<string, string>();
  for (const [odcIndex, odc] of odcs.entries()) {
    let index = 0;
    for (const label of odc.members ?? []) if (odpByLabel.has(label)) odpLabel.set(label, outputOdpLabel(label, odcIndex + 1, ++index));
  }
  const canonical = (label: string) => odcLabel.get(label) ?? odpLabel.get(label) ?? label;
  const boundariesKml = boundaries.map((ring, index) => {
    const ringKml = (points: Coord[]) => {
      const closed = points[0]?.[0] === points.at(-1)?.[0] && points[0]?.[1] === points.at(-1)?.[1] ? points : [...points, points[0]];
      return `<LinearRing><coordinates>${closed.map(([lon, lat]) => `${lon},${lat},0.0`).join(' ')}</coordinates></LinearRing>`;
    };
    return `<Placemark><name>${boundaries.length === 1 ? 'Boundary' : `Boundary ${String(index + 1).padStart(2, '0')}`}</name><Style><LineStyle><color>ffff0000</color><width>2</width></LineStyle><PolyStyle><color>46ff0000</color></PolyStyle></Style><Polygon><outerBoundaryIs>${ringKml(ring.outer)}</outerBoundaryIs>${ring.holes.map((hole) => `<innerBoundaryIs>${ringKml(hole)}</innerBoundaryIs>`).join('')}</Polygon></Placemark>`;
  }).join('');
  const assets = [
    `<Folder><name>OLT</name>${pointMark('OLT001', 'SERVER OLT', 'pop', pop.at)}</Folder>`,
    `<Folder><name>ODC</name>${odcs.map((odc) => { const label = odcLabel.get(odc.label)!; return pointMark(label, `Splitter: 1:${odcCapacity}\nJumlah ODP: ${odc.members?.length ?? 0}`, 'odc', odc.at); }).join('')}</Folder>`,
    `<Folder><name>ODP</name>${orderedOdps.map((odp) => { const label = odpLabel.get(odp.label) ?? odp.label; const parent = odcs.find((odc) => odc.members?.includes(odp.label)); return pointMark(label, `Splitter: 1:${odpCapacity}\nJumlah rumah: ${odp.members?.length ?? 0}\nInduk: ${canonical(parent?.label ?? '')}`, 'odp', odp.at); }).join('')}</Folder>`,
  ];
  if (customers.length) assets.push(`<Folder><name>HC</name>${orderedOdps.flatMap((odp) => (odp.members ?? []).map((label) => customers.find((customer) => customer.label === label)).filter((customer): customer is Point => Boolean(customer)).map((customer, index) => pointMark(`${odpLabel.get(odp.label) ?? odp.label}-${String(index + 1).padStart(2, '0')}`, `Induk ODP: ${odpLabel.get(odp.label) ?? odp.label}`, 'house', customer.at))).join('')}</Folder>`);
  const feeders = cables.filter((cable) => cable.type === 'feeder');
  const feederCoords: Coord[] = [];
  const feederNames = [feeders.length ? (feeders[0].source === 'POP' ? pop.label : feeders[0].source) : ''];
  let previousFeederEnd: Coord | undefined;
  for (const feeder of feeders) {
    const coords = feeder.coords.map((point) => [...point] as Coord);
    if (previousFeederEnd && coords.length) coords[0] = previousFeederEnd;
    if (coords.length) previousFeederEnd = coords.at(-1);
    if (feederCoords.length && coords.length && feederCoords.at(-1)![0] === coords[0][0] && feederCoords.at(-1)![1] === coords[0][1]) feederCoords.push(...coords.slice(1));
    else feederCoords.push(...coords);
    feederNames.push(feeder.target);
  }
  const feederFolder = feederCoords.length >= 2 ? `<Placemark><name>${escape(feederNames.filter(Boolean).join('-'))}</name>${data(feederNames.filter(Boolean).join('-'))}<styleUrl>#feeder</styleUrl>${lineMark(feederNames.join('-'), feederCoords, 'feeder')}</Placemark>` : '';
  const devicePoints = new Map([...odcs, ...odps].map((point) => [point.label, point.at]));
  const distributionCables = cables.filter((cable) => cable.type === 'distribution');
  const distributions = orderedOdps.flatMap((odp) => distributionCables.filter((cable) => cable.target === odp.label)).map((cable) => {
    const coords = cable.coords.map((point) => [...point] as Coord);
    const source = devicePoints.get(cable.source) ?? devicePoints.get(odcs.find((odc) => odc.members?.includes(cable.target))?.label ?? '');
    const target = devicePoints.get(cable.target);
    if (source && coords.length) coords[0] = source;
    if (target && coords.length) coords[coords.length - 1] = target;
    return lineMark(`${canonical(cable.source)}-${odpLabel.get(cable.target) ?? cable.target}`, coords, 'distribution');
  }).join('');
  const drops = orderedOdps.flatMap((odp) => (odp.members ?? []).map((label) => customers.find((customer) => customer.label === label)).filter((customer): customer is Point => Boolean(customer)).map((customer, index) => lineMark(`ODP ${odpLabel.get(odp.label) ?? odp.label} TO HC ${odpLabel.get(odp.label) ?? odp.label}-${String(index + 1).padStart(2, '0')}`, [odp.at, customer.at], 'drop'))).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>FTTH Design</name>${iconStyle('pop', palette.pop, 'http://maps.google.com/mapfiles/kml/shapes/electronics.png', 1.2)}${iconStyle('odc', palette.odc, 'http://maps.google.com/mapfiles/kml/shapes/triangle.png', 1.2)}${iconStyle('odp', palette.odp, 'http://maps.google.com/mapfiles/kml/shapes/triangle.png', 1)}${iconStyle('house', '#ffffff', 'files/ftth-house.png', 20 / 96)}${lineStyle('feeder', palette.feeder, 4)}${lineStyle('distribution', palette.distribution, 4)}${lineStyle('drop', palette.house, 3)}${boundariesKml ? `<Folder><name>BOUNDARY</name>${boundariesKml}</Folder>` : ''}<Folder><name>Assets</name>${assets.join('')}</Folder><Folder><name>Routes</name><Folder><name>Feeder Route</name>${feederFolder}</Folder><Folder><name>Distribution Route</name>${distributions ? `<Placemark><name>Distribution Route</name>${data('Distribution Route')}<styleUrl>#distribution</styleUrl><MultiGeometry>${distributions}</MultiGeometry></Placemark>` : ''}</Folder>${customers.length ? `<Folder><name>Drop Route</name>${drops ? `<Placemark><name>Drop Route</name><description>KABEL DROP ODP KE HC</description>${data('Drop Route')}<styleUrl>#drop</styleUrl><MultiGeometry>${drops}</MultiGeometry></Placemark>` : ''}</Folder>` : ''}</Folder></Document></kml>`;
}

function csvFloat(value: number, decimals?: number) {
  if (!Number.isFinite(value)) return String(value);
  const negative = value < 0 || Object.is(value, -0), magnitude = Math.abs(value);
  if (decimals === undefined) return Object.is(value, -0) ? '-0.0' : Number.isInteger(value) ? `${value}.0` : String(value);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, magnitude);
  const bits = view.getBigUint64(0), exponent = Number((bits >> 52n) & 0x7ffn);
  let significand = bits & ((1n << 52n) - 1n), power: number;
  if (exponent === 0) power = -1074;
  else { significand |= 1n << 52n; power = exponent - 1023 - 52; }
  const scale = 10n ** BigInt(decimals), numerator = significand * scale;
  let rounded: bigint;
  if (power >= 0) rounded = numerator << BigInt(power);
  else {
    const denominator = 1n << BigInt(-power), quotient = numerator / denominator, remainder = numerator % denominator;
    const doubled = remainder * 2n;
    rounded = doubled > denominator || (doubled === denominator && quotient % 2n === 1n) ? quotient + 1n : quotient;
  }
  const whole = rounded / scale, fraction = (rounded % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : '.0'}`;
}

export function buildCsv(pop: Point, odcs: Point[], odps: Point[], customers: Point[], cables: Cable[]) {
  const quote = (value: unknown) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const float = csvFloat;
  const rows: unknown[][] = [['Tipe', 'Nama', 'Kuantitas/Panjang', 'Satuan', 'Latitude', 'Longitude']];
  rows.push(['POP / Server OLT', pop.label, 1, 'pcs', float(pop.at[1]), float(pop.at[0])]);
  const odcNames = new Map(odcs.map((odc, index) => [odc.label, `ODC ${String(index + 1).padStart(2, '0')}`]));
  const odpByLabel = new Map(odps.map((odp) => [odp.label, odp]));
  const odpNames = new Map<string, string>();
  for (let odcIndex = 0; odcIndex < odcs.length; odcIndex++) {
    let odpIndex = 0;
    for (const label of odcs[odcIndex].members ?? []) if (odpByLabel.has(label)) odpNames.set(label, `${String(odcIndex + 1).padStart(2, '0')}/${String(++odpIndex).padStart(2, '0')}`);
  }
  const distribution = new Map(cables.filter((cable) => cable.type === 'distribution').map((cable) => [cable.target, cable]));
  for (let odcIndex = 0; odcIndex < odcs.length; odcIndex++) {
    const odc = odcs[odcIndex], odcName = odcNames.get(odc.label)!;
    rows.push(['ODC', odcName, 1, 'pcs', float(odc.at[1]), float(odc.at[0])]);
    rows.push(['Join Closure', `JOIN CLOSURE ${odcName}`, 1, 'pcs', float(odc.at[1]), float(odc.at[0])]);
    const assigned = (odc.members ?? []).map((label) => odpByLabel.get(label)).filter((odp): odp is Point => Boolean(odp));
    for (let odpIndex = 0; odpIndex < assigned.length; odpIndex++) {
      const odp = assigned[odpIndex], odpName = `${String(odcIndex + 1).padStart(2, '0')}/${String(odpIndex + 1).padStart(2, '0')}`;
      rows.push(['ODP', odpName, 1, 'pcs', float(odp.at[1]), float(odp.at[0])]);
      const segment = distribution.get(odp.label), sourceName = segment?.source === odc.label ? odcName : odpNames.get(segment?.source ?? '') ?? odcName;
      rows.push(['Kabel Distribusi', `${sourceName} -> ${odpName}`, segment ? float(segment.length, 2) : 'DISCONNECTED', segment ? 'm' : '', '', '']);
      const odpCustomers = (odp.members ?? []).map((label) => customers.find((customer) => customer.label === label)).filter((customer): customer is Point => Boolean(customer));
      for (let houseIndex = 0; houseIndex < odpCustomers.length; houseIndex++) {
        const house = odpCustomers[houseIndex], houseName = `${odpName}-${String(houseIndex + 1).padStart(2, '0')}`;
        rows.push(['Homepass (Titik Rumah)', houseName, 1, 'pcs', float(house.at[1]), float(house.at[0])]);
        rows.push(['Kabel Drop', `${odpName} -> ${houseName}`, float(distance(odp.at, house.at) * 1.2, 2), 'm', '', '']);
      }
    }
  }
  for (const feeder of cables.filter((cable) => cable.type === 'feeder')) {
    rows.push(['Kabel Feeder', `${feeder.source === 'POP' ? pop.label : feeder.source} -> ${feeder.target}`, float(feeder.length, 2), 'm', '', '']);
  }
  return Buffer.from(`${rows.map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`);
}

@Injectable()
export class GeneratorService {
  constructor(@Inject(DB) private readonly db: any) {}

  validateOptions(options: any) { return generationConfig(options); }

  private sourceDecision(_rings: Boundary[]) {
    const tileSize = 0.05;
    const mode = (process.env.OSM_SOURCE_MODE ?? 'auto').trim().toLowerCase();
    if (mode && !['auto', 'online', 'local'].includes(mode)) throw apiError('OSM_UNAVAILABLE', 'OSM_SOURCE_MODE harus bernilai auto, online, atau local.', 503);
    return { mode, tileSize, local: mode === 'local' };
  }

  async coreSourceSignature(boundaryBytes: Buffer, boundaryName: string) {
    let rings = (await readKml(boundaryBytes, boundaryName)).flatMap((mark) => mark.polygon ? [mark.polygon] : []);
    rings = await this.unionBoundaries(rings);
    if (!rings.length) throw new BadRequestException('Boundary KML/KMZ wajib berisi polygon.');
    const { mode, local } = this.sourceDecision(rings);
    if (!local) return 'osm_online';
    const closed = (ring: Coord[]) => ring[0]?.[0] === ring.at(-1)?.[0] && ring[0]?.[1] === ring.at(-1)?.[1] ? ring : [...ring, ring[0]];
    const ringWkt = (ring: Coord[]) => `(${closed(ring).map(([lon, lat]) => `${lon} ${lat}`).join(',')})`;
    const polygonWkt = (boundary: Boundary) => [boundary.outer, ...boundary.holes].map(ringWkt).join(',');
    const wkt = rings.length === 1 ? `POLYGON(${polygonWkt(rings[0])})` : `MULTIPOLYGON(${rings.map((ring) => `(${polygonWkt(ring)})`).join(',')})`;
    let active;
    try { active = await this.db.execute(sql`SELECT dataset_id, ST_Covers(coverage, ST_GeomFromText(${wkt},4326)) AS covers FROM osm_data.dataset WHERE status = 'active' LIMIT 1`); }
    catch (error) { if (mode === 'local') throw error; return 'osm_online'; }
    const dataset = active.rows?.[0];
    if (!dataset || !dataset.covers) {
      if (mode === 'local') throw apiError('OSM_UNAVAILABLE', dataset ? `Boundary berada di luar cakupan dataset OSM lokal ${dataset.dataset_id}.` : 'Belum ada dataset OSM lokal yang aktif.', 503);
      return 'osm_online';
    }
    return `osm_postgis:${dataset.dataset_id}`;
  }

  private async buildRoadGraph(elements: any[], strategy: string, holes: Coord[][] = [], preserveOneway = false) {
    const roads = elements.filter((item) => highwayFactor(item.tags?.highway) !== undefined);
    const profile = 'vehicle-roads-v4';
    const key = createHash('sha256').update(JSON.stringify([profile, strategy, preserveOneway, holes, roads.map((way) => [way.id, way.tags.highway, way.tags.oneway ?? (way.tags.junction === 'roundabout' ? true : false), way.tags.length_m, way.geometry])])).digest('hex');
    const root = process.env.ROAD_GRAPH_CACHE_ROOT ?? join(tmpdir(), 'ftth_road_graphs');
    const cachePath = join(root, `${key}.json`);
    const ttl = Math.max(0, Number(process.env.OSM_CACHE_MAX_AGE_SECONDS ?? 86400)) * 1000;
    if (ttl) {
      try {
        const cached = JSON.parse(await readFile(cachePath, 'utf8'));
        if (Date.now() - cached.savedAt <= ttl && Array.isArray(cached.graph)) return new Map(cached.graph as [string, Node][]);
      } catch { /* no usable graph cache */ }
    }
    const graph = new Map<string, Node>();
    for (const way of roads) {
      const coords = (way.geometry ?? []).map(asCoord);
      const geometryLength = coords.slice(1).reduce((sum: number, point: Coord, index: number) => sum + distance(coords[index], point), 0);
      // reference implementation's PostGIS graph keeps each imported edge directed, even when the OSM way is bidirectional.
      const oneway = preserveOneway;
      const hasTopology = preserveOneway && way.tags.source_node !== undefined && way.tags.target_node !== undefined;
      const edgePrefix = `osm-edge:${way.id}:${way.tags.edge_index ?? 0}`;
      for (let i = 1; i < coords.length; i++) {
        const segmentLength = Number(way.tags.length_m);
        for (const [start, end] of clipSegmentOutsideHoles(coords[i - 1], coords[i], holes)) {
          const clippedLength = Number.isFinite(segmentLength) && segmentLength >= 0 && geometryLength > 0 ? segmentLength * distance(start, end) / geometryLength : distance(start, end);
          const nodeIds = hasTopology ? [
            i === 1 ? `osm-node:${way.tags.source_node}` : `${edgePrefix}:${i - 1}`,
            i === coords.length - 1 ? `osm-node:${way.tags.target_node}` : `${edgePrefix}:${i}`,
          ] as [string, string] : undefined;
          addEdge(graph, start, end, way.tags.highway, strategy, oneway, clippedLength, nodeIds);
        }
      }
    }
    try {
      await mkdir(root, { recursive: true });
      const temporary = `${cachePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ savedAt: Date.now(), graph: [...graph] }));
      await rename(temporary, cachePath);
    } catch { /* caching must not block generation */ }
    return graph;
  }

  private async fetchLocal(rings: Boundary[], pop?: Coord, refresh = false, signal?: AbortSignal) {
    throwIfAborted(signal);
    const closed = (ring: Coord[]) => ring[0]?.[0] === ring[ring.length - 1]?.[0] && ring[0]?.[1] === ring[ring.length - 1]?.[1] ? ring : [...ring, ring[0]];
    const polygonWkt = (boundary: Boundary) => [boundary.outer, ...boundary.holes].map((ring) => `(${closed(ring).map((p) => `${p[0]} ${p[1]}`).join(',')})`).join(',');
    const wkt = rings.length === 1
      ? `POLYGON(${polygonWkt(rings[0])})`
      : `MULTIPOLYGON(${rings.map((ring) => `(${polygonWkt(ring)})`).join(',')})`;
    const active = await this.db.execute(sql`SELECT dataset_id, source_timestamp, ST_Covers(coverage, ST_GeomFromText(${wkt},4326)) AS covers FROM osm_data.dataset WHERE status = 'active' LIMIT 1`);
    throwIfAborted(signal);
    const dataset = active.rows?.[0];
    if (!dataset) throw new Error('Belum ada dataset OSM lokal yang aktif. Import OSM PBF terlebih dahulu.');
    if (!dataset.covers) throw new Error(`Boundary berada di luar cakupan dataset OSM lokal ${dataset.dataset_id}.`);
    const cacheRoot = process.env.LOCAL_OSM_CACHE_ROOT ?? join(tmpdir(), 'ftth_local_osm');
    const cachePath = join(cacheRoot, `${createHash('sha256').update(JSON.stringify([dataset.dataset_id, 'local-osm-v6', wkt, pop])).digest('hex')}.json`);
    const ttl = Math.max(0, Number(process.env.OSM_CACHE_MAX_AGE_SECONDS ?? 86400)) * 1000;
    const forceRefresh = refresh || String(process.env.OSM_FORCE_REFRESH ?? '').toLowerCase() === 'true';
    if (!forceRefresh && ttl) {
      try {
        const cached = JSON.parse(await readFile(cachePath, 'utf8'));
        if (Date.now() - cached.savedAt <= ttl && Array.isArray(cached.elements)) return cached;
      } catch { /* no usable local OSM cache */ }
    }
    const buildings = await this.db.execute(sql`SELECT osm_id, ST_AsGeoJSON(geom) AS geometry FROM osm_data.building WHERE dataset_id = ${dataset.dataset_id} AND geom && ST_GeomFromText(${wkt},4326) AND ST_Intersects(geom, ST_GeomFromText(${wkt},4326))`);
    const roadWindow = localRoadWindow(wkt, pop);
    const roads = await this.db.execute(sql`SELECT e.edge_id, e.edge_index, e.source_node, e.target_node, e.highway, e.oneway, e.length_m, ST_AsGeoJSON(e.geom) AS geometry FROM osm_data.road_edge e WHERE e.dataset_id = ${dataset.dataset_id} AND e.geom && ${roadWindow} AND ST_Intersects(e.geom,${roadWindow}) ORDER BY e.edge_id, e.edge_index`);
    throwIfAborted(signal);
    let popCandidate: { name: string; at: Coord } | undefined;
    try {
      const searchArea = localPopSearchArea(wkt);
      const pois = await this.db.execute(sql`SELECT kind, name, ST_AsGeoJSON(ST_PointOnSurface(geom)) AS geometry FROM osm_data.poi WHERE dataset_id = ${dataset.dataset_id} AND kind IN ('station','office','main_road','road') AND geom && ${searchArea} AND ST_Intersects(geom,${searchArea}) ORDER BY CASE kind WHEN 'station' THEN 1 WHEN 'office' THEN 2 WHEN 'main_road' THEN 3 ELSE 4 END, poi_id LIMIT 1`);
      const poi = pois.rows?.[0];
      if (poi) popCandidate = { name: localOsmPopName(String(poi.kind), poi.name), at: JSON.parse(poi.geometry).coordinates as Coord };
      else {
        const roadNode = await this.db.execute(sql`SELECT ST_AsGeoJSON(geom) AS geometry FROM osm_data.road_node WHERE dataset_id = ${dataset.dataset_id} AND geom && ${searchArea} AND ST_Intersects(geom,${searchArea}) ORDER BY geom <-> ST_Centroid(${searchArea}) LIMIT 1`);
        if (roadNode.rows?.[0]) popCandidate = { name: 'POP OSM lokal (node jalan)', at: JSON.parse(roadNode.rows[0].geometry).coordinates as Coord };
      }
    } catch { /* Older local OSM imports may not include the POI table. */ }
    throwIfAborted(signal);
    popCandidate ??= { name: 'Auto POP (Titik Tengah)', at: boundaryCentroid(rings) };
    const result = {
      elements: [
        ...(buildings.rows ?? []).flatMap((row: any) => {
          const geometry = JSON.parse(row.geometry);
          const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
          if (!polygons.length) return [];
          const toPolygon = (rings: Coord[][]) => ({ outer: rings[0].map(asCoord), holes: rings.slice(1).map((ring) => ring.map(asCoord)) });
          const parts = polygons.map(toPolygon);
          return [{ id: String(row.osm_id), type: 'way', tags: { building: 'yes' }, geometry: parts[0].outer, holes: parts[0].holes, polygons: parts }];
        }),
        ...(roads.rows ?? []).map((row: any) => ({ id: `${row.edge_id}:${row.edge_index}`, tags: { highway: row.highway, oneway: row.oneway, length_m: Number(row.length_m), source_node: String(row.source_node), target_node: String(row.target_node), edge_index: row.edge_index }, geometry: JSON.parse(row.geometry).coordinates })),
      ],
      popCandidate,
      metadata: { source: 'osm_postgis', dataset_id: dataset.dataset_id, timestamp: dataset.source_timestamp ?? undefined, reason: 'boundary memakai dataset OSM lokal' },
    };
    try {
      await mkdir(cacheRoot, { recursive: true });
      const temporary = `${cachePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ ...result, savedAt: Date.now() }));
      await rename(temporary, cachePath);
    } catch { /* caching must not block generation */ }
    return result;
  }

  private async fetchNativeOsm(rings: Boundary[], refresh = false, checkpointDir?: string, signal?: AbortSignal) {
    const points = rings.flatMap((ring) => ring.outer);
    const tileSize = 0.05, overlap = 0.002;
    const minLon = Math.min(...points.map((point) => point[0])), maxLon = Math.max(...points.map((point) => point[0]));
    const minLat = Math.min(...points.map((point) => point[1])), maxLat = Math.max(...points.map((point) => point[1]));
    const tiles: { west: number; south: number; east: number; north: number }[] = [];
    for (let west = Math.floor(minLon / tileSize) * tileSize; west < maxLon; west += tileSize) {
      for (let south = Math.floor(minLat / tileSize) * tileSize; south < maxLat; south += tileSize) {
        if (rings.some((ring) => intersectsTile(ring, west, south, west + tileSize, south + tileSize))) tiles.push({ west: west - overlap, south: south - overlap, east: west + tileSize + overlap, north: south + tileSize + overlap });
      }
    }
    const cacheRoot = process.env.OSM_CACHE_ROOT ?? join(tmpdir(), 'ftth_osm_tiles');
    const ttl = Math.max(0, Number(process.env.OSM_CACHE_MAX_AGE_SECONDS ?? 86400)) * 1000;
    const forceRefresh = refresh || String(process.env.OSM_FORCE_REFRESH ?? '').toLowerCase() === 'true';
    const endpoint = process.env.OSM_NATIVE_URL ?? 'https://api.openstreetmap.org/api/0.6/map';
    const splitDepth = Number(process.env.OSM_NATIVE_SPLIT_DEPTH ?? 2);
    const retries = Number.isFinite(Number(process.env.OSM_NATIVE_RETRIES)) ? Math.max(1, Number(process.env.OSM_NATIVE_RETRIES)) : 3;
    const maxSplitDepth = Number.isFinite(splitDepth) ? Math.max(0, splitDepth) : 2;
    const timeout = osmRequestTimeoutSeconds() * 1000;
    const fetchTile = async (tile: { west: number; south: number; east: number; north: number }, depth = 0): Promise<any[]> => {
      const key = [tile.west, tile.south, tile.east, tile.north].map((value) => value.toFixed(6)).join(',');
      const tileId = createHash('sha256').update(`osm-native-tile-v1:${key}`).digest('hex');
      const cachePath = join(cacheRoot, `${tileId}.json`), checkpointPath = checkpointDir ? join(checkpointDir, `${tileId}.json`) : undefined;
      if (!forceRefresh && checkpointPath) {
        try { const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')); if (Array.isArray(checkpoint.elements) && checkpoint.elements.length) return checkpoint.elements; } catch { /* fetch missing checkpoint */ }
      }
      if (!forceRefresh && ttl) {
        try { const cached = JSON.parse(await readFile(cachePath, 'utf8')); if (Date.now() - cached.savedAt <= ttl && Array.isArray(cached.elements) && cached.elements.length) return cached.elements; } catch { /* fetch missing cache */ }
      }
      let lastError: unknown;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          throwIfAborted(signal);
          const url = new URL(endpoint);
          url.searchParams.set('bbox', key);
          const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
          const response = await fetch(url, { headers: { 'user-agent': 'ftth-design-generator/1.0' }, signal: requestSignal });
          if (response.status === 400 || response.status === 413) {
            if (depth >= maxSplitDepth) throw new Error(`Native OSM Error: ${response.status}`);
            const midLon = (tile.west + tile.east) / 2, midLat = (tile.south + tile.north) / 2;
            return (await Promise.all([
              fetchTile({ west: tile.west, south: tile.south, east: midLon, north: midLat }, depth + 1),
              fetchTile({ west: midLon, south: tile.south, east: tile.east, north: midLat }, depth + 1),
              fetchTile({ west: tile.west, south: midLat, east: midLon, north: tile.north }, depth + 1),
              fetchTile({ west: midLon, south: midLat, east: tile.east, north: tile.north }, depth + 1),
            ])).flat();
          }
          if (!response.ok) throw new Error(`Native OSM Error: ${response.status}`);
          const elements = parseNativeOsmXml(await response.text());
          if (checkpointPath && elements.length) {
            await mkdir(checkpointDir!, { recursive: true });
            const temporary = `${checkpointPath}.${randomUUID()}.tmp`;
            await writeFile(temporary, JSON.stringify({ savedAt: Date.now(), elements }));
            await rename(temporary, checkpointPath);
          }
          if (ttl && elements.length) {
            await mkdir(cacheRoot, { recursive: true });
            const temporary = `${cachePath}.${randomUUID()}.tmp`;
            await writeFile(temporary, JSON.stringify({ savedAt: Date.now(), elements }));
            await rename(temporary, cachePath);
          }
          return elements;
        } catch (error) {
          throwIfAborted(signal);
          lastError = error;
          if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, Math.min(4, attempt) * 1000));
        }
      }
      throw lastError instanceof Error ? lastError : new Error('Native OSM request failed.');
    };
    const tilesToFetch = tiles.length ? tiles : [{ west: minLon, south: minLat, east: maxLon, north: maxLat }];
    const results = await Promise.all(tilesToFetch.map((tile) => fetchTile(tile)));
    throwIfAborted(signal);
    const unique = new Map<string, any>();
    for (const elements of results) for (const element of elements) unique.set(`${element.type}:${element.id}`, element);
    const elements = [...unique.values()];
    if (!elements.length) throw new Error('Native OSM tidak mengembalikan fitur pada boundary.');
    return { elements, popCandidate: strategicPop(elements, boundaryCentroid(rings)), metadata: { source: 'osm_native', timestamp: new Date().toISOString(), tile_count: tilesToFetch.length } };
  }

  private async fetchOsm(rings: Boundary[], refresh = false, pop?: Coord, checkpointDir?: string, signal?: AbortSignal, requireBuildings = false) {
    throwIfAborted(signal);
    const points = rings.flatMap((boundary) => boundary.outer);
    const [minLon, maxLon] = [Math.min(...points.map((p) => p[0])), Math.max(...points.map((p) => p[0]))];
    const [minLat, maxLat] = [Math.min(...points.map((p) => p[1])), Math.max(...points.map((p) => p[1]))];
    const { mode, tileSize, local } = this.sourceDecision(rings);
    if (mode === 'local') return this.fetchLocal(rings, pop, refresh, signal);
    const queryRings = [...rings];
    if (!pop) {
      const boundaryPoints = rings.flatMap((boundary) => boundary.outer);
      const west = Math.min(...boundaryPoints.map((point) => point[0])) - 0.01;
      const south = Math.min(...boundaryPoints.map((point) => point[1])) - 0.01;
      const east = Math.max(...boundaryPoints.map((point) => point[0])) + 0.01;
      const north = Math.max(...boundaryPoints.map((point) => point[1])) + 0.01;
      queryRings.push({ outer: [[west, south], [west, north], [east, north], [east, south], [west, south]], holes: [] });
    }
    if (pop) for (const boundary of rings) if (!contains(boundary, pop)) queryRings.push({ outer: connectorRibbon(pop, nearestOnBoundary(pop, boundary), 0.002), holes: [] });
    let nativeError: unknown;
    try {
      const native = await this.fetchNativeOsm(queryRings, refresh, checkpointDir, signal);
      const hasBuildings = native.elements.some((item: any) => item.tags?.building);
      const hasPreferredPop = native.elements.some((item: any) => item.tags?.railway === 'station' || item.tags?.building === 'train_station' || item.tags?.office || item.tags?.building === 'office');
      if (hasBuildings && (pop || hasPreferredPop)) return native;
      nativeError = new Error(!hasBuildings ? 'Native OSM tidak mengembalikan bangunan.' : 'Native OSM tidak mengembalikan stasiun atau kantor untuk POP otomatis.');
    } catch (error) { throwIfAborted(signal); nativeError = error; }
    try {
      const queryPoints = queryRings.flatMap((boundary) => boundary.outer), westLimit = Math.min(...queryPoints.map((p) => p[0])), eastLimit = Math.max(...queryPoints.map((p) => p[0]));
      const southLimit = Math.min(...queryPoints.map((p) => p[1])), northLimit = Math.max(...queryPoints.map((p) => p[1]));
      const overlap = 0.002, tilesToFetch: { west: number; south: number; east: number; north: number }[] = [];
      for (let west = Math.floor(westLimit / tileSize) * tileSize; west < eastLimit; west += tileSize) {
        for (let south = Math.floor(southLimit / tileSize) * tileSize; south < northLimit; south += tileSize) {
          if (queryRings.some((ring) => intersectsTile(ring, west, south, west + tileSize, south + tileSize))) tilesToFetch.push({ west: west - overlap, south: south - overlap, east: west + tileSize + overlap, north: south + tileSize + overlap });
        }
      }
      const cacheRoot = process.env.OSM_CACHE_ROOT ?? join(tmpdir(), 'ftth_osm_tiles');
      const ttl = Math.max(0, Number(process.env.OSM_CACHE_MAX_AGE_SECONDS ?? 86400)) * 1000;
      const forceRefresh = refresh || String(process.env.OSM_FORCE_REFRESH ?? '').toLowerCase() === 'true';
      let nextTile = 0;
      const results: any[][] = new Array(tilesToFetch.length);
      const worker = async () => {
        while (true) {
          throwIfAborted(signal);
          const index = nextTile++;
          const tile = tilesToFetch[index];
          if (!tile) return;
          const tileKey = `${tile.west.toFixed(6)},${tile.south.toFixed(6)},${tile.east.toFixed(6)},${tile.north.toFixed(6)}`;
          const tileId = createHash('sha256').update(`osm-tile-v2:${tileKey}`).digest('hex');
          const cachePath = join(cacheRoot, `${tileId}.json`);
          const checkpointPath = checkpointDir ? join(checkpointDir, `${tileId}.json`) : undefined;
          if (!forceRefresh && checkpointPath) {
            try {
              const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
              if (Array.isArray(checkpoint.elements) && checkpoint.elements.length) { results[index] = checkpoint.elements; continue; }
            } catch { /* this tile has not been checkpointed yet */ }
          }
          if (!forceRefresh && ttl) {
            try {
              const cached = JSON.parse(await readFile(cachePath, 'utf8'));
              if (Date.now() - cached.savedAt <= ttl && Array.isArray(cached.elements) && cached.elements.length) { results[index] = cached.elements; continue; }
            } catch { /* no usable tile cache */ }
          }
          const polygon = [[tile.west, tile.south], [tile.west, tile.north], [tile.east, tile.north], [tile.east, tile.south], [tile.west, tile.south]].map(([lon, lat]) => `${lat} ${lon}`).join(' ');
          const query = `[out:json][timeout:90];(node(poly:"${polygon}")[building];way(poly:"${polygon}")[building];relation(poly:"${polygon}")[building];way(poly:"${polygon}")[highway];node(poly:"${polygon}")[railway=station];way(poly:"${polygon}")[building=train_station];relation(poly:"${polygon}")[railway=station];node(poly:"${polygon}")[office];way(poly:"${polygon}")[office];relation(poly:"${polygon}")[office];);out body geom;`;
          let elements: any[] | undefined, lastError: unknown;
          for (const endpoint of OVERPASS_ENDPOINTS) {
            try {
              throwIfAborted(signal);
              const timeoutSignal = AbortSignal.timeout(osmRequestTimeoutSeconds() * 1000);
              const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
              const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}`, signal: requestSignal });
              if (!response.ok) throw new Error(`Overpass ${response.status}`);
          elements = ((await response.json() as any).elements ?? []) as any[];
              break;
            } catch (error) { throwIfAborted(signal); lastError = error; }
          }
          if (!elements) throw lastError instanceof Error ? lastError : new Error('Semua endpoint Overpass gagal.');
          results[index] = elements;
          if (checkpointPath && elements.length) {
            await mkdir(checkpointDir!, { recursive: true });
            const temporary = `${checkpointPath}.${process.pid}.tmp`;
            await writeFile(temporary, JSON.stringify({ savedAt: Date.now(), elements }));
            await rename(temporary, checkpointPath);
          }
          if (elements.length) {
            await mkdir(cacheRoot, { recursive: true });
            const temporary = `${cachePath}.${process.pid}.tmp`;
            await writeFile(temporary, JSON.stringify({ savedAt: Date.now(), elements }));
            await rename(temporary, cachePath);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(tilesToFetch.length, Math.max(1, Number(process.env.OSM_TILE_WORKERS ?? 4))) }, worker));
      throwIfAborted(signal);
      const unique = new Map<string, any>();
      for (const elements of results) for (const element of elements ?? []) unique.set(`${element.type}:${element.id}`, element);
      const elements = parseOverpassElements([...unique.values()]);
      if (requireBuildings && !elements.some((item: any) => item.tags?.building)) throw new Error('Provider OSM online tidak mengembalikan bangunan untuk boundary.');
      return { elements, popCandidate: strategicPop(elements, boundaryCentroid(rings)), metadata: { source: 'osm_online', timestamp: new Date().toISOString(), tile_count: tilesToFetch.length } };
    } catch (error) {
      throwIfAborted(signal);
      throw apiError('OSM_UNAVAILABLE', `Native OSM dan Overpass gagal. Native: ${nativeError instanceof Error ? nativeError.message : 'service unavailable'}; Overpass: ${error instanceof Error ? error.message : 'service unavailable'}`, 503);
    }
  }

  private async postgisBuildingPoints(elements: any[], boundaries: Boundary[]): Promise<Map<number, Coord> | undefined> {
    const closed = (ring: Coord[]) => ring[0]?.[0] === ring[ring.length - 1]?.[0] && ring[0]?.[1] === ring[ring.length - 1]?.[1] ? ring : [...ring, ring[0]];
    const ringWkt = (ring: Coord[]) => `(${closed(ring).map(([lon, lat]) => `${lon} ${lat}`).join(',')})`;
    const boundaryWkt = boundaries.length === 1
      ? `POLYGON(${[boundaries[0].outer, ...boundaries[0].holes].map(ringWkt).join(',')})`
      : `MULTIPOLYGON(${boundaries.map((boundary) => `(${[boundary.outer, ...boundary.holes].map(ringWkt).join(',')})`).join(',')})`;
    const inputs = elements.flatMap((item, index) => {
      if (!item.tags?.building || !item.geometry?.length) return [];
      const polygons = Array.isArray(item.polygons) ? item.polygons : [{ outer: item.geometry, holes: item.holes ?? [] }];
      const polygonWkts = polygons.flatMap((polygon: any) => {
        const rings = [polygon.outer, ...(polygon.holes ?? [])].map((ring: Coord[]) => ring.map(asCoord).filter((point: Coord) => point.every(Number.isFinite)));
        return rings[0]?.length >= 3 ? [`(${rings.map(ringWkt).join(',')})`] : [];
      });
      if (!polygonWkts.length) return [];
      return [{ idx: index, wkt: polygonWkts.length === 1 ? `POLYGON${polygonWkts[0]}` : `MULTIPOLYGON(${polygonWkts.join(',')})` }];
    });
    if (!inputs.length) return new Map();
    try {
      const result = await this.db.execute(sql`WITH inputs AS (
        SELECT idx, wkt FROM jsonb_to_recordset(${JSON.stringify(inputs)}::jsonb) AS input(idx integer, wkt text)
      ), boundary AS (
        SELECT ST_GeomFromText(${boundaryWkt}, 4326) AS geom
      ), clipped AS (
        SELECT inputs.idx, footprint.geom, boundary.geom AS boundary,
          ST_Intersection(footprint.geom, boundary.geom) AS intersection
        FROM inputs CROSS JOIN boundary
        CROSS JOIN LATERAL (SELECT ST_GeomFromText(inputs.wkt, 4326) AS geom) AS footprint
        WHERE footprint.geom && boundary.geom AND ST_Intersects(footprint.geom, boundary.geom)
      )
      SELECT idx, ST_AsGeoJSON(CASE
        WHEN ST_Covers(boundary, ST_Centroid(geom)) THEN ST_Centroid(geom)
        ELSE ST_PointOnSurface(intersection)
      END, 15) AS geometry FROM clipped`);
      return new Map((result.rows ?? []).map((row: any) => [Number(row.idx), JSON.parse(row.geometry).coordinates as Coord]));
    } catch {
      return undefined;
    }
  }

  private async unionBoundaries(boundaries: Boundary[]): Promise<Boundary[]> {
    if (!boundaries.length) return boundaries;
    const closed = (ring: Coord[]) => ring[0]?.[0] === ring.at(-1)?.[0] && ring[0]?.[1] === ring.at(-1)?.[1] ? ring : [...ring, ring[0]];
    const ringWkt = (ring: Coord[]) => `(${closed(ring).map(([lon, lat]) => `${lon} ${lat}`).join(',')})`;
    const polygons = boundaries.map((boundary) => `POLYGON(${[boundary.outer, ...boundary.holes].map(ringWkt).join(',')})`);
    try {
      const inputs = sql.join(polygons.map((wkt) => sql`(${wkt})`), sql`, `);
      const result = await this.db.execute(sql`WITH inputs(wkt) AS (VALUES ${inputs}), fixed AS (
        SELECT ST_Buffer(ST_GeomFromText(wkt,4326),0) AS geom FROM inputs
      ) SELECT ST_AsGeoJSON(dumped.geom) AS geometry
        FROM (SELECT ST_CollectionExtract(ST_UnaryUnion(ST_Collect(geom)),3) AS geom FROM fixed) AS united
        CROSS JOIN LATERAL ST_Dump(united.geom) AS dumped`);
      const normalized = (result.rows ?? []).map((row: any) => {
        const geometry = JSON.parse(row.geometry);
        return { outer: geometry.coordinates[0] as Coord[], holes: geometry.coordinates.slice(1) as Coord[][] };
      }).filter((boundary: Boundary) => boundary.outer.length >= 3);
      return normalized.length ? normalized : boundaries;
    } catch {
      return boundaries;
    }
  }

  async generate(boundaryBytes: Buffer, boundaryName: string, popBytes: Buffer | undefined, popName: string | undefined, options: any, checkpointDir?: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    options = generationConfig(options);
    let noRoadFeeder = options.no_road_feeder === true;
    const marks = await readKml(boundaryBytes, boundaryName);
    let boundaries = marks.flatMap((item) => item.polygon ? [item.polygon] : []);
    if (!boundaries.length) throw new BadRequestException('Boundary KML/KMZ wajib berisi polygon.');
    if (boundaries.some((boundary) => boundary.outer.length < 3 || boundary.holes.some((hole) => hole.length < 3))) throw new BadRequestException('Setiap boundary harus memiliki minimal tiga titik.');
    boundaries = await this.unionBoundaries(boundaries);
    const popMark = popBytes && popName ? (await readKml(popBytes, popName)).find((item) => item.point) : undefined;
    let pop = popMark?.point;
    let popLabel = popMark?.name || 'POP';
    if (popBytes && pop && !boundaries.some((boundary) => contains(boundary, pop!))) {
      const distanceM = Math.min(...boundaries.map((boundary) => distance(pop!, nearestOnBoundary(pop!, boundary))));
      if (distanceM > 3000) throw apiError('POP_TOO_FAR', 'POP (Sentral) terlalu jauh dari area perancangan (> 3 km). Hal ini dapat membebani server saat meroute jalan. Harap letakkan POP lebih dekat dengan area boundary.', 400, { distance_m: Math.round(distanceM * 10) / 10, limit_m: 3000 });
    }
    const area = boundaryCentroid(boundaries);
    const manualProvided = Array.isArray(options.manual_houses);
    const manualNoRoad = noRoadFeeder && manualProvided;
    let osmResult: { elements: any[]; popCandidate?: any; metadata: any };
    try {
      osmResult = manualNoRoad
        ? { elements: [], popCandidate: undefined, metadata: { source: 'manual' } }
        : await this.fetchOsm(boundaries, options.force_refresh_osm, pop, checkpointDir, signal, !manualProvided && !marks.some((item) => item.point && /house|home|customer|rumah|building|tiang/i.test(item.name)));
    } catch (error) {
      if (!options.allow_road_fallback || !manualProvided || signal?.aborted) throw error;
      noRoadFeeder = true;
      osmResult = { elements: [], popCandidate: undefined, metadata: { source: 'manual', road_fallback: true } };
    }
    const { elements, popCandidate, metadata: sourceMetadata } = osmResult;
    throwIfAborted(signal);
    const roads = elements.filter((item) => highwayFactor(item.tags?.highway) !== undefined);
    const graph = noRoadFeeder ? new Map<string, Node>() : await this.buildRoadGraph(elements, options.routing_strategy, boundaries.flatMap((boundary) => boundary.holes), sourceMetadata.source === 'osm_postgis');
    throwIfAborted(signal);
    if (!graph.size && !noRoadFeeder) {
      if (options.allow_road_fallback) noRoadFeeder = true;
      else throw apiError('OSM_UNAVAILABLE', 'Tidak ada jaringan jalan kendaraan pada boundary.', 503);
    }
    if (!pop) {
      const candidate = popCandidate ?? strategicPop(elements, area);
      pop = candidate?.at ?? area;
      popLabel = candidate?.name || 'POP';
    }
    if (!pop) throw apiError('OSM_UNAVAILABLE', 'Lokasi POP tidak dapat ditentukan.', 503);
    const manualHouses: Point[] = Array.isArray(options.manual_houses)
      ? options.manual_houses.filter((item: any) => Array.isArray(item?.at) && boundaries.some((boundary) => contains(boundary, item.at))).map((item: any, index: number) => ({ label: String(item.label || `HOUSE-${index + 1}`), at: asCoord(item.at) }))
      : [];
    const customers: Point[] = marks.filter((item) => item.point && /house|home|customer|rumah|building|tiang/i.test(item.name)).map((item, index) => ({ label: item.name || `HOUSE-${index + 1}`, at: item.point! }));
    const seenBuildings = new Set<string>();
    const exactBuildingPoints = await this.postgisBuildingPoints(elements, boundaries);
    throwIfAborted(signal);
    const buildings = elements.flatMap((item, index) => {
      if (!item.tags?.building) return [];
      const geometry = item.type === 'node' && Number.isFinite(Number(item.lon)) && Number.isFinite(Number(item.lat))
        ? [[Number(item.lon), Number(item.lat)] as Coord]
        : Array.isArray(item.geometry) ? item.geometry.map(asCoord) : [];
      if (!geometry.length) return [];
      const centroidPoint = polygonComponentsCentroid(item.polygons ?? []) ?? (geometry.length <= 2 ? geometry[0] : polygonCentroid(geometry));
      const candidate = exactBuildingPoints?.get(index)
        ?? (geometry.length <= 2 ? boundaries.map((boundary) => contains(boundary, centroidPoint) ? centroidPoint : clippedPolygonPoint(geometry, boundary)).find(Boolean)
          : exactBuildingPoints ? undefined : boundaries.map((boundary) => contains(boundary, centroidPoint) ? centroidPoint : clippedPolygonPoint(geometry, boundary)).find(Boolean));
      if (!candidate) return [];
      const at: Coord = [Number(candidate[0].toFixed(7)), Number(candidate[1].toFixed(7))];
      const key = `${at[1].toFixed(7)},${at[0].toFixed(7)}`;
      if (seenBuildings.has(key)) return [];
      seenBuildings.add(key);
      return [{ label: String(item.tags?.name ?? `HOUSE-${index + 1}`), at }];
    });
    let houses = manualProvided ? manualHouses : customers.length ? customers : buildings;
    if (!houses.length) throw apiError('NO_CUSTOMER_FOUND', 'Tidak ada bangunan di area boundary.', 404);
    if (Number.isInteger(Number(options.target_homepass)) && Number(options.target_homepass) > 0 && houses.length > Number(options.target_homepass)) {
      houses = [...houses].sort((a, b) => distance(pop!, a.at) - distance(pop!, b.at)).slice(0, Number(options.target_homepass));
    }
    const odpCapacity = Math.max(1, Number(options.odp_capacity ?? 10)), odcCapacity = Math.max(1, Number(options.odc_capacity ?? 4));
    const minOdpSize = Math.max(1, Number(options.min_odp_cluster_size ?? 1)), minOdcSize = Math.max(1, Number(options.min_odc_cluster_size ?? 1));
    if (minOdpSize > odpCapacity || minOdcSize > odcCapacity) throw new BadRequestException('Ukuran minimum cluster tidak boleh melebihi kapasitas perangkat.');
    const houseGroups = capacitatedClusters(houses.map((house) => house.at), odpCapacity, minOdpSize).map((indices) => indices.map((index) => houses[index]));
    const snappingDistance = Number(options.snapping_distance_m ?? 100);
    const populatedHouseGroups = houseGroups;
    const byOdp: Point[] = houseGroups.map((group, index) => {
      const at: Coord = [group.reduce((sum, p) => sum + p.at[0], 0) / group.length, group.reduce((sum, p) => sum + p.at[1], 0) / group.length];
      return { label: `ODP-${String(index + 1).padStart(3, '0')}`, at: noRoadFeeder ? at : snapGeneratedPoint(graph, at, snappingDistance), members: group.map((house) => house.label) };
    });
    const odcGroups = capacitatedClusters(byOdp.map((odp) => odp.at), odcCapacity, minOdcSize);
    const odcs: Point[] = odcGroups.map((indices, index) => {
      const group = indices.map((i) => byOdp[i]);
      const at: Coord = [group.reduce((sum, odp) => sum + odp.at[0], 0) / group.length, group.reduce((sum, odp) => sum + odp.at[1], 0) / group.length];
      return { label: `ODC-${String(index + 1).padStart(3, '0')}`, at: noRoadFeeder ? at : snapGeneratedPoint(graph, at, snappingDistance), members: group.map((odp) => odp.label) };
    });
    if (noRoadFeeder || options.odc_min_distance_m !== undefined) {
      enforceStraightLineOdcSpacing(odcs, Math.max(0, Number(options.odc_min_distance_m ?? 40)));
    } else enforceOdcSpacing(graph, odcs);
    const cables: Cable[] = [], routeCache = new Map<string, Coord[]>();
    if (!noRoadFeeder) rebalanceOdpsByRoadConnectivity(graph, odcs, byOdp, Number(options.max_distribution_length_m ?? 500), odcCapacity, routeCache);
    const distributionCables: Cable[] = [];
    for (const odc of odcs) {
      const assigned = byOdp.filter((odp) => odc.members!.includes(odp.label));
      if (noRoadFeeder) cables.push(...assigned.map((odp) => ({ type: 'distribution' as const, source: odc.label, target: odp.label, coords: [odc.at, odp.at], length: distance(odc.at, odp.at) })));
      else {
        const distribution = buildDistributionTree(graph, odc, assigned, Number(options.max_distribution_length_m ?? 500), routeCache);
        distributionCables.push(...distribution);
        cables.push(...distribution);
      }
    }
    throwIfAborted(signal);
    const ordered = orderOdcChain(pop, odcs);
    const odcRenames = new Map(ordered.map((odc, index) => [odc.label, `ODC-${String(index + 1).padStart(3, '0')}`]));
    const feederOdcs = ordered.map((odc) => ({ ...odc, label: odcRenames.get(odc.label)! }));
    for (const cable of cables.filter((item) => item.type === 'distribution')) {
      cable.source = odcRenames.get(cable.source) ?? cable.source;
    }
    if (!noRoadFeeder) requireDistributionConnectivity(feederOdcs, byOdp, distributionCables);
    let feederSource = pop, feederSourceLabel = popLabel;
    for (const odc of feederOdcs) {
      const coords = noRoadFeeder ? [feederSource, odc.at] : route(graph, feederSource, odc.at, routeCache);
      cables.push({ type: 'feeder', source: feederSourceLabel, target: odc.label, coords, length: pathLength(coords) });
      feederSource = odc.at; feederSourceLabel = odc.label;
    }
    if (options.include_homepass) for (let i = 0; i < byOdp.length; i++) for (const house of populatedHouseGroups[i]) {
      const coords: Coord[] = [byOdp[i].at, house.at]; cables.push({ type: 'homepass', source: byOdp[i].label, target: house.label, coords, length: distance(byOdp[i].at, house.at) });
    }
    const styles = options.feature_colors && typeof options.feature_colors === 'object' ? options.feature_colors : {};
    const kml = buildKml({ label: popLabel, at: pop }, feederOdcs, byOdp, options.include_homepass ? houses : [], cables, styles, options.include_boundary === false ? [] : boundaries, odpCapacity, odcCapacity);
    const kmz = await buildKmz(kml, styles);
    throwIfAborted(signal);
    const csv = buildCsv({ label: popLabel, at: pop }, feederOdcs, byOdp, houses, cables);
    const stats = designStats(feederOdcs, byOdp, houses, cables);
    const validation = validateDesign(feederOdcs, byOdp, houses, cables, options);
    return { kmz, csv, state: { pop, pop_label: popLabel, boundaries, odcs: feederOdcs, odps: byOdp, customers: houses, cables, roads: serializedRoads(graph), validation }, stats, validation, metadata: { ...sourceMetadata, road_count: roads.length, boundary: boundaryName } };
  }

  async generateCustom(bytes: Buffer, name: string, options: any, checkpointDir?: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    options = generationConfig({ ...options, odp_capacity: 10, odc_capacity: 4, max_distribution_length_m: 500, routing_strategy: 'priority_road', include_homepass: true, force_refresh_osm: false });
    const marks = await readKml(bytes, name);
    const { pop, odcs, odps, customers } = classifyCustomPoints(marks);
    if (!pop) throw new BadRequestException(`KML custom tidak memiliki titik berlabel OLT/POP (${odcs.length} ODC, ${odps.length} ODP, ${customers.length} HC).`);
    if (!odcs.length || !odps.length) throw new BadRequestException(`KML custom perlu titik ODC dan ODP (${odcs.length} ODC, ${odps.length} ODP).`);
    const points = [pop, ...odcs, ...odps, ...customers].map((p) => p.at);
    const minLon = Math.min(...points.map((p) => p[0])), maxLon = Math.max(...points.map((p) => p[0]));
    const minLat = Math.min(...points.map((p) => p[1])), maxLat = Math.max(...points.map((p) => p[1]));
    const buffer = 0.015;
    const ring: Coord[] = [[minLon - buffer, minLat - buffer], [minLon - buffer, maxLat + buffer], [maxLon + buffer, maxLat + buffer], [maxLon + buffer, minLat - buffer], [minLon - buffer, minLat - buffer]];
    const { elements, metadata: sourceMetadata } = await this.fetchOsm([{ outer: ring, holes: [] }], options.force_refresh_osm, pop.at, checkpointDir, signal);
    throwIfAborted(signal);
    const graph = await this.buildRoadGraph(elements, options.routing_strategy, [], sourceMetadata.source === 'osm_postgis');
    throwIfAborted(signal);
    if (!graph.size) throw apiError('ROAD_GRAPH_UNAVAILABLE', 'Jaringan jalan OSM tidak tersedia. Generate dihentikan agar kabel tidak dibuat sebagai garis lurus.', 503);
    const snap = <T extends Point>(point: T): T => {
      const at = nearestRoadPoint(graph, point.at);
      if (!at) throw apiError('ROUTING_FAILED', 'ODC/ODP custom tidak dapat ditempatkan pada jalan kendaraan.', 500);
      return { ...point, at };
    };
    const explicitOdcGroups = new Map(odcs.flatMap((odc) => {
      const group = customMappingGroup(odc.context, 'odc');
      return group ? [[group, odc] as const] : [];
    }));
    for (const odp of odps) {
      const explicitGroup = customMappingGroup(odp.context, 'odp');
      const mapped = explicitGroup ? explicitOdcGroups.get(explicitGroup) : undefined;
      if (explicitGroup && explicitOdcGroups.size && !mapped) throw new BadRequestException(`Mapping ${odp.label} menunjuk ke group ODC ${explicitGroup}, tetapi ODC tersebut tidak ditemukan.`);
      const parent = mapped ?? odcs.reduce((best, item) => distance(item.at, odp.at) < distance(best.at, odp.at) ? item : best, odcs[0]);
      parent.members!.push(odp.label);
    }
    for (const customer of customers) {
      const parent = odps.reduce((best, item) => distance(item.at, customer.at) < distance(best.at, customer.at) ? item : best, odps[0]);
      parent.members!.push(customer.label);
    }
    const snappedPop = pop, snappedOdcs = odcs.map(snap), snappedOdps = odps.map(snap), snappedCustomers = customers;
    const customOdcs = orderOdcChain(snappedPop.at, snappedOdcs).map((odc, index) => ({ ...odc, label: `ODC-${String(index + 1).padStart(3, '0')}` }));
    const cables: Cable[] = [], distributionCables: Cable[] = [], routeCache = new Map<string, Coord[]>();
    let source: Coord = snappedPop.at, sourceLabel = snappedPop.label;
    for (const odc of customOdcs) {
      const coords = route(graph, source, odc.at, routeCache);
      cables.push({ type: 'feeder', source: sourceLabel, target: odc.label, coords, length: pathLength(coords) }); source = odc.at; sourceLabel = odc.label;
      const assigned = snappedOdps.filter((odp) => odc.members!.includes(odp.label));
      const distribution = buildDistributionTree(graph, odc, assigned, Number(options.max_distribution_length_m ?? 500), routeCache);
      distributionCables.push(...distribution);
      cables.push(...distribution);
    }
    requireDistributionConnectivity(customOdcs, snappedOdps, distributionCables);
    throwIfAborted(signal);
    if (options.include_homepass) for (const odp of snappedOdps) for (const customer of snappedCustomers.filter((item) => odp.members!.includes(item.label))) {
      const drop: Coord[] = [odp.at, customer.at];
      cables.push({ type: 'homepass', source: odp.label, target: customer.label, coords: drop, length: distance(odp.at, customer.at) });
    }
    const styles = options.feature_colors ?? {};
    const kmz = await buildKmz(buildKml(snappedPop, customOdcs, snappedOdps, options.include_homepass ? snappedCustomers : [], cables, styles, [], Number(options.odp_capacity), Number(options.odc_capacity)), styles);
    throwIfAborted(signal);
    const csv = buildCsv(snappedPop, customOdcs, snappedOdps, snappedCustomers, cables);
    const stats = designStats(customOdcs, snappedOdps, snappedCustomers, cables);
    const validation = validateDesign(customOdcs, snappedOdps, snappedCustomers, cables, options);
    return { kmz, csv, state: { pop: snappedPop.at, pop_label: snappedPop.label, odcs: customOdcs, odps: snappedOdps, customers: snappedCustomers, cables, roads: serializedRoads(graph), validation }, stats, validation, metadata: { ...sourceMetadata, source_file: name } };
  }

  async fromCache(state: any, options: any, operation: 'homepass' | 'regenerate', signal?: AbortSignal) {
    throwIfAborted(signal);
    options = generationConfig(options);
    state = normalizeCachedState(state);
    const rebuildNetwork = operation === 'regenerate' || (state.legacyCache && !state.networkComplete);
    const graph = new Map<string, Node>();
    const routeCache = new Map<string, Coord[]>();
    const odcs: Point[] = (state.odcs ?? []).map((odc: Point) => ({ ...odc, members: [...(odc.members ?? [])] }));
    const odps: Point[] = state.odps ?? [];
    for (const edge of state.roads ?? []) {
      const coords = Array.isArray(edge) ? edge : edge.coords;
      if (!Array.isArray(coords)) continue;
      for (let i = 1; i < coords.length; i++) {
        const nodeIds = !Array.isArray(edge) && typeof edge.from_id === 'string' && typeof edge.to_id === 'string' && coords.length === 2
          ? [edge.from_id, edge.to_id] as [string, string]
          : undefined;
        const lengthM = !Array.isArray(edge) && Number.isFinite(Number(edge.length_m))
          ? Number(edge.length_m) * distance(coords[i - 1], coords[i]) / pathLength(coords)
          : distance(coords[i - 1], coords[i]);
        addEdge(graph, coords[i - 1], coords[i], edge.highway ?? 'residential', options.routing_strategy, edge.oneway ?? false, lengthM, nodeIds);
      }
    }
    if (rebuildNetwork && !graph.size && state.legacyCache) {
      const points: Coord[] = [state.pop, ...odcs.map((odc) => odc.at), ...odps.map((odp) => odp.at)];
      const padding = 0.015;
      const west = Math.min(...points.map(([lon]) => lon)) - padding, east = Math.max(...points.map(([lon]) => lon)) + padding;
      const south = Math.min(...points.map(([, lat]) => lat)) - padding, north = Math.max(...points.map(([, lat]) => lat)) + padding;
      const bbox: Boundary = { outer: [[west, south], [west, north], [east, north], [east, south], [west, south]], holes: [] };
      const { elements, metadata } = await this.fetchOsm([bbox], false, state.pop, undefined, signal);
      throwIfAborted(signal);
      for (const [id, node] of await this.buildRoadGraph(elements, options.routing_strategy, [], metadata?.source === 'osm_postgis')) graph.set(id, node);
      throwIfAborted(signal);
      if (!graph.size) throw apiError('ROAD_GRAPH_UNAVAILABLE', 'Jaringan jalan OSM tidak tersedia. Regenerate dihentikan agar kabel tidak dibuat sebagai garis lurus.', 503);
    }
    if (rebuildNetwork && !graph.size) {
      throw apiError('ROAD_GRAPH_UNAVAILABLE', 'Cache tidak memiliki jaringan jalan. Regenerate dihentikan agar kabel tidak dibuat sebagai garis lurus.', 503);
    }
    const cables: Cable[] = rebuildNetwork ? [] : (state.cables ?? []).filter((cable: Cable) => cable.type !== 'homepass');
    if (!rebuildNetwork && operation === 'homepass') {
      for (const odp of odps) for (const customer of (state.customers ?? []).filter((item: Point) => odp.members?.includes(item.label))) {
        const coords: Coord[] = [odp.at, customer.at];
        cables.push({ type: 'homepass', source: odp.label, target: customer.label, coords, length: distance(odp.at, customer.at) });
      }
    } else if (rebuildNetwork) {
      rebalanceOdpsByRoadConnectivity(graph, odcs, odps, Number(options.max_distribution_length_m ?? 500), Number(options.odc_capacity ?? 4), routeCache);
      let source: Coord = state.pop, sourceLabel = state.pop_label || 'POP';
      const distributionCables: Cable[] = [];
      for (const odc of odcs) {
        const coords = route(graph, source, odc.at, routeCache);
        cables.push({ type: 'feeder', source: sourceLabel, target: odc.label, coords, length: pathLength(coords) });
        source = odc.at; sourceLabel = odc.label;
        const assigned = odps.filter((odp) => odc.members?.includes(odp.label));
        const distribution = buildDistributionTree(graph, odc, assigned, Number(options.max_distribution_length_m ?? 500), routeCache);
        distributionCables.push(...distribution);
        cables.push(...distribution);
      }
      requireDistributionConnectivity(odcs, odps, distributionCables);
      if ((operation === 'homepass' || options.include_homepass)) for (const odp of odps) for (const customer of (state.customers ?? []).filter((item: Point) => odp.members?.includes(item.label))) {
        const coords: Coord[] = [odp.at, customer.at];
        cables.push({ type: 'homepass', source: odp.label, target: customer.label, coords, length: distance(odp.at, customer.at) });
      }
    }
    const stats = designStats(odcs, odps, state.customers ?? [], cables);
    const featureColors = options.feature_colors ?? {};
    const kmz = await buildKmz(buildKml({ label: state.pop_label || 'POP', at: state.pop }, odcs, odps, state.customers ?? [], cables, featureColors, state.boundaries ?? [], Number(options.odp_capacity), Number(options.odc_capacity)), featureColors);
    const csv = buildCsv({ label: state.pop_label || 'POP', at: state.pop }, odcs, odps, state.customers ?? [], cables);
    const validation = validateDesign(odcs, odps, state.customers ?? [], cables, options);
    const roads = serializedRoads(graph);
    return { kmz, csv, state: { ...state, odcs, cables, roads: roads.length ? roads : state.roads ?? [], validation }, stats, validation, metadata: { source: 'cached', operation } };
  }

  async reuseCore(state: any, options: any) {
    options = generationConfig(options);
    state = normalizeCachedState(state);
    const odcs: Point[] = (state.odcs ?? []).map((odc: Point) => ({ ...odc, members: [...(odc.members ?? [])] }));
    const odps: Point[] = state.odps ?? [], customers: Point[] = state.customers ?? [];
    const cables: Cable[] = (state.cables ?? []).filter((cable: Cable) => cable.type !== 'homepass');
    const pop = { label: state.pop_label || 'POP', at: state.pop as Coord };
    const colors = options.feature_colors ?? {};
    const kmz = await buildKmz(buildKml(pop, odcs, odps, [], cables, colors, state.boundaries ?? [], Number(options.odp_capacity), Number(options.odc_capacity)), colors);
    const csv = buildCsv(pop, odcs, odps, customers, cables);
    const stats = designStats(odcs, odps, customers, cables), validation = validateDesign(odcs, odps, customers, cables, options);
    return { kmz, csv, state: { ...state, odcs, cables, validation }, stats, validation };
  }
}
