import { Injectable, BadRequestException, Inject, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import { DB } from '../db/database.module';

type Coord = [number, number];
type Boundary = { outer: Coord[]; holes: Coord[][] };
type Placemark = { name: string; point?: Coord; polygon?: Boundary; context?: string };
type Node = { id: string; at: Coord; edges: { to: string; weight: number; highway: string; coords: Coord[]; oneway: boolean }[] };
type Point = { label: string; at: Coord; members?: string[] };
type Cable = { type: 'feeder' | 'distribution' | 'homepass'; source: string; target: string; coords: Coord[]; length: number };
const asCoord = (point: any): Coord => Array.isArray(point) ? [Number(point[0]), Number(point[1])] : [Number(point.lon), Number(point.lat)];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false });
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const distance = (a: Coord, b: Coord) => {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

function collectPlacemarks(root: any): Placemark[] {
  const result: Placemark[] = [];
  const walk = (value: any, context = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'Folder') for (const folder of (Array.isArray(child) ? child : [child]) as any[]) walk(folder, [context, folder.name].filter(Boolean).join(' '));
      else if (key === 'Placemark') for (const item of (Array.isArray(child) ? child : [child]) as any[]) {
        const coords = (v: any): Coord[] => String(v ?? '').trim().split(/\s+/).map((part) => part.split(',').map(Number) as Coord).filter((p) => p.length >= 2 && p.every(Number.isFinite));
        const point = coords(item.Point?.coordinates)[0];
        const polygons = [item.Polygon, ...(Array.isArray(item.MultiGeometry?.Polygon) ? item.MultiGeometry.Polygon : [item.MultiGeometry?.Polygon])]
          .filter(Boolean)
          .map((polygon) => ({
            outer: coords(polygon?.outerBoundaryIs?.LinearRing?.coordinates),
            holes: (Array.isArray(polygon?.innerBoundaryIs) ? polygon.innerBoundaryIs : polygon?.innerBoundaryIs ? [polygon.innerBoundaryIs] : [])
              .flatMap((inner: any) => coords(inner?.LinearRing?.coordinates)).filter((ring: Coord[]) => ring.length >= 3),
          }))
          .filter((polygon) => polygon.outer.length >= 3);
        const name = String(item.name ?? '');
        const placemarkContext = [context, String(item.description ?? '')].filter(Boolean).join(' ');
        if (point) result.push({ name, point, context: placemarkContext });
        for (const polygon of polygons) result.push({ name, polygon, context: placemarkContext });
        if (!point && !polygons.length) result.push({ name, context: placemarkContext });
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

function containsRing(ring: Coord[], point: Coord) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
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
  return containsRing(boundary.outer, point) && !boundary.holes.some((hole) => containsRing(hole, point));
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
  let areaTwice = 0, lon = 0, lat = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x, y] = ring[i], [nextX, nextY] = ring[(i + 1) % ring.length], cross = x * nextY - nextX * y;
    areaTwice += cross;
    lon += (x + nextX) * cross;
    lat += (y + nextY) * cross;
  }
  return Math.abs(areaTwice) < 1e-15 ? centroid(ring) : [lon / (3 * areaTwice), lat / (3 * areaTwice)];
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

function strategicPop(elements: any[], center: Coord): { name: string; at: Coord } | undefined {
  const candidate = (element: any): Coord | undefined => {
    if (element.type === 'node' && Number.isFinite(Number(element.lon)) && Number.isFinite(Number(element.lat))) return [Number(element.lon), Number(element.lat)];
    const points = (element.geometry ?? []).map(asCoord).filter((point: Coord) => point.every(Number.isFinite));
    if (!points.length) return undefined;
    return points.reduce((best: Coord, point: Coord) => distance(point, center) < distance(best, center) ? point : best, points[0]);
  };
  const priorities = [
    { name: 'POP OSM (stasiun)', matches: (tags: any) => tags.railway === 'station' || tags.building === 'train_station' },
    { name: 'POP OSM (kantor)', matches: (tags: any) => Boolean(tags.office) },
    { name: 'POP OSM (jalan utama)', matches: (tags: any) => ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(tags.highway) },
    { name: 'POP OSM (jalan)', matches: (tags: any) => Boolean(tags.highway) },
  ];
  for (const priority of priorities) {
    const found = elements.filter((item) => priority.matches(item.tags ?? '')).map((item) => candidate(item)).filter(Boolean) as Coord[];
    found.sort((a, b) => distance(a, center) - distance(b, center));
    if (found.length) return { name: priority.name, at: found[0] };
  }
}

const ROAD_FACTORS: Record<string, number> = { motorway: 0.9, motorway_link: 0.95, trunk: 0.85, trunk_link: 0.9, primary: 0.9, primary_link: 0.95, secondary: 1, secondary_link: 1.05, tertiary: 1.15, tertiary_link: 1.2, residential: 1.75, unclassified: 2, living_street: 2.25, road: 2.5, service: 3 };
function generationConfig(options: any) {
  const defaults: Record<string, number> = { odp_capacity: 10, odc_capacity: 4, min_odp_cluster_size: 1, min_odc_cluster_size: 1, max_odp_radius_m: 150, max_odc_radius_m: 500, max_feeder_length_m: 2000, max_distribution_length_m: 500, snapping_distance_m: 100 };
  const bounds: Record<string, [number, number, boolean]> = { odp_capacity: [1, 64, true], odc_capacity: [1, 32, true], min_odp_cluster_size: [1, 64, true], min_odc_cluster_size: [1, 32, true], max_odp_radius_m: [10, 500, false], max_odc_radius_m: [50, 5000, false], max_feeder_length_m: [100, 20000, false], max_distribution_length_m: [50, 5000, false], snapping_distance_m: [5, 1500, false] };
  const config = { ...options };
  for (const [key, [min, max, integer]] of Object.entries(bounds)) {
    const value = Number(config[key] ?? defaults[key]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new BadRequestException(`${key} harus ${integer ? 'bilangan bulat ' : ''}antara ${min} dan ${max}.`);
    config[key] = value;
  }
  if (config.min_odp_cluster_size > config.odp_capacity || config.min_odc_cluster_size > config.odc_capacity) throw new BadRequestException('Ukuran minimum cluster tidak boleh melebihi kapasitas perangkat.');
  if (!['shortest', 'priority_road'].includes(config.routing_strategy ?? 'shortest')) throw new BadRequestException('routing_strategy harus shortest atau priority_road.');
  config.routing_strategy ??= 'shortest';
  config.include_homepass ??= true;
  return config;
}

function addEdge(graph: Map<string, Node>, a: Coord, b: Coord, highway = 'residential', strategy = 'shortest', oneway: string | boolean = false) {
  const key = ([lon, lat]: Coord) => `${lon.toFixed(7)},${lat.toFixed(7)}`;
  if (oneway === '-1') [a, b] = [b, a];
  const directed = oneway === true || oneway === '-1' || ['yes', 'true', '1'].includes(String(oneway).toLowerCase());
  const from = key(a), to = key(b);
  if (!graph.has(from)) graph.set(from, { id: from, at: a, edges: [] });
  if (!graph.has(to)) graph.set(to, { id: to, at: b, edges: [] });
  const weight = distance(a, b) * (strategy === 'priority_road' ? ROAD_FACTORS[highway] ?? 1.5 : 1);
  graph.get(from)!.edges.push({ to, weight, highway, coords: [a, b], oneway: directed });
  if (!directed) graph.get(to)!.edges.push({ to: from, weight, highway, coords: [b, a], oneway: false });
}

function closestNode(graph: Map<string, Node>, point: Coord) {
  let closest: Node | undefined, best = Infinity;
  for (const node of graph.values()) { const d = distance(point, node.at); if (d < best) { closest = node; best = d; } }
  return closest;
}

function nearestRoadSegment(graph: Map<string, Node>, point: Coord) {
  let nearest: { from: Node; to: Node; point: Coord; fraction: number } | undefined, best = Infinity;
  for (const node of graph.values()) for (const edge of node.edges) {
    if (!edge.oneway && node.id > edge.to) continue;
    const to = graph.get(edge.to);
    if (!to) continue;
    const candidate = nearestOnRing(point, edge.coords), d = distance(point, candidate);
    if (d < best) {
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

function walkAlongRoad(graph: Map<string, Node>, origin: Coord, distanceM: number, direction: number, branchChoice: number): Coord | undefined {
  let nearest: { from: Node; to: Node; point: Coord } | undefined, best = Infinity;
  for (const from of graph.values()) for (const edge of from.edges) {
    if (!edge.oneway && from.id > edge.to) continue;
    const to = graph.get(edge.to);
    if (!to) continue;
    const point = nearestOnRing(origin, edge.coords), offset = distance(origin, point);
    if (offset < best) { nearest = { from, to, point }; best = offset; }
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
  const fraction = ratio(nearest.point, nearest.from.at, nearest.to.at);
  let segment = distance(nearest.from.at, nearest.to.at) * (direction > 0 ? 1 - fraction : fraction);
  for (let hop = 0; hop < 25; hop++) {
    if (remaining <= segment) {
      const length = distance(at, to.at);
      const progress = length ? remaining / length : 0;
      return [at[0] + (to.at[0] - at[0]) * progress, at[1] + (to.at[1] - at[1]) * progress];
    }
    remaining -= segment;
    at = to.at;
    const candidates: { from: Node; to: Node }[] = to.edges
      .filter((edge) => edge.to !== from.id)
      .map((edge) => ({ from: to, to: graph.get(edge.to)! }))
      .filter((edge) => edge.to && distance(edge.from.at, edge.to.at) > 0);
    for (const incoming of graph.values()) for (const edge of incoming.edges) {
      if (edge.oneway && edge.to === to.id && incoming.id !== from.id) candidates.push({ from: to, to: incoming });
    }
    if (!candidates.length) return at;
    const chosen = candidates[branchChoice % candidates.length];
    from = chosen.from;
    to = chosen.to;
    segment = distance(from.at, to.at);
  }
}

function enforceOdcSpacing(graph: Map<string, Node>, odcs: Point[], minimumM = 40) {
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

function rebalanceOdpsByRoadConnectivity(graph: Map<string, Node>, odcs: Point[], odps: Point[], maxLengthM: number, capacity: number, routeCache: Map<string, Coord[]>) {
  const routedLength = (odc: Point, odp: Point) => {
    try { return pathLength(route(graph, odc.at, odp.at, routeCache)); }
    catch { return undefined; }
  };
  const assignment = assignOdpsGloballyByRoad(graph, odcs, odps, maxLengthM, capacity, routeCache, routedLength);
  if (assignment?.every((odcIndex, odpIndex) => {
    const length = routedLength(odcs[odcIndex], odps[odpIndex]);
    return length !== undefined && length <= maxLengthM;
  })) {
    odcs.forEach((odc) => { odc.members = []; });
    assignment.forEach((odcIndex, odpIndex) => { odcs[odcIndex].members!.push(odps[odpIndex].label); });
  }
  for (const odp of odps) {
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
  let recoveryIndex = 1;
  for (const odp of odps) {
    const current = odcs.find((odc) => odc.members?.includes(odp.label));
    const length = current && routedLength(current, odp);
    if (length !== undefined && length <= maxLengthM) continue;
    let location: Coord | undefined;
    for (const offset of [40, 20, 10]) {
      for (const direction of [1, -1]) {
        const candidate = walkAlongRoad(graph, odp.at, offset, direction, 0);
        if (candidate && distance(candidate, odp.at) > 1) { location = candidate; break; }
      }
      if (location) break;
    }
    if (!location) continue;
    if (current) current.members = current.members?.filter((label) => label !== odp.label) ?? [];
    while (odcs.some((odc) => odc.label === `ODC-RECOVERY-${String(recoveryIndex).padStart(3, '0')}`)) recoveryIndex++;
    odcs.push({ label: `ODC-RECOVERY-${String(recoveryIndex++).padStart(3, '0')}`, at: location, members: [odp.label] });
  }
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
    type FlowEdge = { to: number; reverse: number; capacity: number; cost: number };
    const source = 0, odpStart = 1, odcStart = odpStart + odps.length, sink = odcStart + odcs.length;
    const network: FlowEdge[][] = Array.from({ length: sink + 1 }, () => []);
    const addEdge = (from: number, to: number, edgeCapacity: number, cost: number) => {
      const forward: FlowEdge = { to, reverse: network[to].length, capacity: edgeCapacity, cost };
      const reverse: FlowEdge = { to: from, reverse: network[from].length, capacity: 0, cost: -cost };
      network[from].push(forward);
      network[to].push(reverse);
    };
    odps.forEach((_, index) => addEdge(source, odpStart + index, 1, 0));
    odcs.forEach((_, index) => addEdge(odcStart + index, sink, capacity, 0));
    const assignmentEdges: { odpIndex: number; odcIndex: number; edgeIndex: number }[] = [];
    for (const [id, length] of routeLengths) {
      const [odpIndex, odcIndex] = id.split(':').map(Number);
      const penalty = length > maxLengthM ? maxLengthM * 1000 : 0;
      const cost = Math.round((length + penalty) * 100);
      const from = odpStart + odpIndex;
      assignmentEdges.push({ odpIndex, odcIndex, edgeIndex: network[from].length });
      addEdge(from, odcStart + odcIndex, 1, cost);
    }

    const potential = Array(network.length).fill(0), flow = Array(network.length).fill(Infinity);
    let sent = 0;
    while (sent < odps.length) {
      flow.fill(Infinity);
      const previousNode = Array(network.length).fill(-1), previousEdge = Array(network.length).fill(-1);
      const queue: QueueItem[] = [];
      flow[source] = 0;
      pushMin(queue, { id: String(source), cost: 0 });
      while (queue.length) {
        const item = popMin(queue)!;
        const from = Number(item.id);
        if (item.cost !== flow[from]) continue;
        for (let edgeIndex = 0; edgeIndex < network[from].length; edgeIndex++) {
          const edge = network[from][edgeIndex];
          if (!edge.capacity) continue;
          const nextCost = flow[from] + edge.cost + potential[from] - potential[edge.to];
          if (nextCost >= flow[edge.to]) continue;
          flow[edge.to] = nextCost;
          previousNode[edge.to] = from;
          previousEdge[edge.to] = edgeIndex;
          pushMin(queue, { id: String(edge.to), cost: nextCost });
        }
      }
      if (!Number.isFinite(flow[sink])) return undefined;
      potential.forEach((_, index) => { if (Number.isFinite(flow[index])) potential[index] += flow[index]; });
      for (let node = sink; node !== source; node = previousNode[node]) {
        const from = previousNode[node], edge = network[from][previousEdge[node]];
        edge.capacity--;
        network[node][edge.reverse].capacity++;
      }
      sent++;
    }
    const assignment = Array(odps.length).fill(-1);
    for (const edge of assignmentEdges) {
      if (network[odpStart + edge.odpIndex][edge.edgeIndex].capacity === 0) assignment[edge.odpIndex] = edge.odcIndex;
    }
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

function capacitatedClusters(points: Coord[], capacity: number, minSize: number): number[][] {
  if (!points.length) return [];
  if (points.length < minSize) throw new BadRequestException(`Tidak cukup titik untuk membentuk cluster berisi minimal ${minSize} titik.`);
  if (points.length <= capacity) return [points.map((_, index) => index)];
  const count = Math.ceil(points.length / capacity), base = Math.floor(points.length / count), extra = points.length % count;
  if (base < minSize) throw new BadRequestException(`Titik tidak dapat dibagi ke cluster berukuran ${minSize} sampai ${capacity}.`);
  const sizes = minSize > 1 ? Array.from({ length: count }, (_, i) => base + Number(i < extra)) : Array(count).fill(capacity);
  let remaining = points.map((_, index) => index), previous: Coord | undefined;
  const clusters: number[][] = [];
  // Match random.Random(42).randint(0, n - 1) so the first cluster starts at
  // the same house index as the Python generator.
  const pythonSeedIndex = (length: number) => {
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
      seedPosition = pythonSeedIndex(remaining.length);
    } else {
      seedPosition = remaining.reduce((best, index, i) => {
        const current = points[index], chosen = points[remaining[best]];
        const currentDistance = (current[0] - previous![0]) ** 2 + (current[1] - previous![1]) ** 2;
        const chosenDistance = (chosen[0] - previous![0]) ** 2 + (chosen[1] - previous![1]) ** 2;
        return currentDistance < chosenDistance ? i : best;
      }, 0);
    }
    const seed = points[remaining[seedPosition]];
    const targetSize = sizes[clusters.length] ?? remaining.length;
    const chosen = [...remaining].sort((left, right) => {
      const a = points[left], b = points[right];
      const da = (a[0] - seed[0]) ** 2 + (a[1] - seed[1]) ** 2;
      const db = (b[0] - seed[0]) ** 2 + (b[1] - seed[1]) ** 2;
      return da - db || left - right;
    }).slice(0, targetSize);
    clusters.push(chosen);
    previous = [chosen.reduce((sum, i) => sum + points[i][0], 0) / chosen.length, chosen.reduce((sum, i) => sum + points[i][1], 0) / chosen.length];
    const selected = new Set(chosen);
    remaining = remaining.filter((index) => !selected.has(index));
  }
  return clusters;
}

function snapGeneratedPoint(graph: Map<string, Node>, point: Coord, maxDistance: number): Coord {
  const nearest = nearestRoadPoint(graph, point);
  if (!nearest) throw new ServiceUnavailableException('Jaringan jalan kendaraan OSM tidak tersedia untuk menempatkan perangkat.');
  const snapDistance = distance(point, nearest);
  if (snapDistance > Math.max(maxDistance, 1500)) throw new BadRequestException(`Titik perangkat berjarak ${snapDistance.toFixed(0)}m dari jalan; batas otomatis 1500m.`);
  return nearest;
}

type QueueItem = { id: string; cost: number };
function pushMin(queue: QueueItem[], item: QueueItem) {
  queue.push(item);
  for (let index = queue.length - 1; index > 0;) {
    const parent = Math.floor((index - 1) / 2);
    if (queue[parent].cost <= queue[index].cost) break;
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
      if (left < queue.length && queue[left].cost < queue[smallest].cost) smallest = left;
      if (right < queue.length && queue[right].cost < queue[smallest].cost) smallest = right;
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
    const targetFraction = source.from.id === target.from.id ? target.fraction : 1 - target.fraction;
    const direction = targetFraction >= source.fraction ? graph.get(source.from.id)?.edges.some((edge) => edge.to === source.to.id)
      : graph.get(source.to.id)?.edges.some((edge) => edge.to === source.from.id);
    if (direction) {
      const path = [start, source.point, end];
      cache?.set(cacheKey, path);
      return path;
    }
  }
  const starts: { id: string; cost: number }[] = [], finishes: { id: string; cost: number }[] = [];
  const forward = graph.get(source.from.id)?.edges.find((edge) => edge.to === source.to.id);
  const backward = graph.get(source.to.id)?.edges.find((edge) => edge.to === source.from.id);
  if (forward) starts.push({ id: source.to.id, cost: forward.weight * (1 - source.fraction) });
  if (backward) starts.push({ id: source.from.id, cost: backward.weight * source.fraction });
  const targetForward = graph.get(target.from.id)?.edges.find((edge) => edge.to === target.to.id);
  const targetBackward = graph.get(target.to.id)?.edges.find((edge) => edge.to === target.from.id);
  if (targetForward) finishes.push({ id: target.from.id, cost: targetForward.weight * target.fraction });
  if (targetBackward) finishes.push({ id: target.to.id, cost: targetBackward.weight * (1 - target.fraction) });
  if (!starts.length || !finishes.length) throw new Error('Tidak ditemukan jalur jalan yang menghubungkan titik desain.');
  const queue: QueueItem[] = [], dist = new Map<string, number>(), prev = new Map<string, { id: string; coords: Coord[] }>();
  for (const option of starts) if (option.cost < (dist.get(option.id) ?? Infinity)) {
    dist.set(option.id, option.cost);
    pushMin(queue, { id: option.id, cost: option.cost });
  }
  while (queue.length) {
    const { id: current, cost } = popMin(queue)!;
    if (cost !== dist.get(current)) continue;
    for (const edge of graph.get(current)!.edges) {
      const next = cost + edge.weight;
      if (next < (dist.get(edge.to) ?? Infinity)) { dist.set(edge.to, next); prev.set(edge.to, { id: current, coords: edge.coords }); pushMin(queue, { id: edge.to, cost: next }); }
    }
  }
  const finish = finishes.map((option) => ({ ...option, cost: (dist.get(option.id) ?? Infinity) + option.cost }))
    .sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id))[0];
  if (!finish || !Number.isFinite(finish.cost)) throw new Error('Tidak ditemukan jalur jalan yang menghubungkan titik desain.');
  const pieces: Coord[][] = [];
  let root = finish.id;
  for (; prev.has(root);) { const step = prev.get(root)!; pieces.push(step.coords); root = step.id; }
  const path: Coord[] = [start, source.point, graph.get(root)!.at, ...pieces.reverse().flatMap((part, i) => i ? part.slice(1) : part), graph.get(finish.id)!.at, target.point, end];
  const compact = path.filter((point, index) => !index || distance(point, path[index - 1]) > 0.01);
  cache?.set(cacheKey, compact);
  return compact;
}

function route(graph: Map<string, Node>, start: Coord, end: Coord, cache?: Map<string, Coord[]>): Coord[] {
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
  const scale = 16, size = 96 * scale, pixels = Buffer.alloc(size * size * 4);
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
  const rows = Buffer.alloc(24 * (24 * 4 + 1));
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) for (let channel = 0; channel < 4; channel++) {
    let sum = 0;
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) sum += pixels[(((y * 4 + dy) * size + x * 4 + dx) * 4) + channel];
    rows[y * 97 + 1 + x * 4 + channel] = Math.floor(sum / 16 + 0.5);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const chunk = (type: string, data: Buffer) => {
    const kind = Buffer.from(type), body = Buffer.concat([kind, data]); let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(24, 0); ihdr.writeUInt32BE(24, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

async function buildKmz(kml: string, featureColors: Record<string, string>) {
  return new JSZip().file('doc.kml', kml).file('files/ftth-house.png', houseIconPng(featureColors?.house)).generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function buildKml(pop: Point, odcs: Point[], odps: Point[], customers: Point[], cables: Cable[], featureColors: Record<string, string>, boundaries: Boundary[] = [], odpCapacity = 10, odcCapacity = 4) {
  const palette = { pop: '#eab308', odc: '#ff0000', odp: '#0000ff', house: '#6b7280', feeder: '#ff0000', distribution: '#aa00ff', ...(featureColors ?? {}) };
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
  const pointMark = (name: string, description: string, style: string, at: Coord) => `<Placemark><name>${escape(name)}</name><description>${escape(description)}</description>${data(name)}<styleUrl>#${style}</styleUrl><Point><coordinates>${at[0]},${at[1]},0</coordinates></Point></Placemark>`;
  const lineMark = (_name: string, coords: Coord[], _style: string) => `<LineString><tessellate>1</tessellate><coordinates>${coords.map(([lon, lat]) => `${lon},${lat},0`).join(' ')}</coordinates></LineString>`;
  const odcLabel = new Map(odcs.map((odc, index) => [odc.label, `ODC${String(index + 1).padStart(3, '0')}`]));
  const odpLabel = new Map<string, string>();
  for (const odc of odcs) {
    let index = 0;
    for (const odp of odps) if (odc.members?.includes(odp.label)) odpLabel.set(odp.label, `${odcLabel.get(odc.label)}.ODP${String(++index).padStart(3, '0')}`);
  }
  const canonical = (label: string) => odcLabel.get(label) ?? odpLabel.get(label) ?? label;
  const boundariesKml = boundaries.map((ring, index) => {
    const ringKml = (points: Coord[]) => {
      const closed = points[0]?.[0] === points.at(-1)?.[0] && points[0]?.[1] === points.at(-1)?.[1] ? points : [...points, points[0]];
      return `<LinearRing><coordinates>${closed.map(([lon, lat]) => `${lon},${lat},0`).join(' ')}</coordinates></LinearRing>`;
    };
    return `<Placemark><name>${boundaries.length === 1 ? 'Boundary' : `Boundary ${String(index + 1).padStart(2, '0')}`}</name><Style><LineStyle><color>ffff0000</color><width>2</width></LineStyle><PolyStyle><color>460000ff</color></PolyStyle></Style><Polygon><outerBoundaryIs>${ringKml(ring.outer)}</outerBoundaryIs>${ring.holes.map((hole) => `<innerBoundaryIs>${ringKml(hole)}</innerBoundaryIs>`).join('')}</Polygon></Placemark>`;
  }).join('');
  const assets = [
    `<Folder><name>OLT</name>${pointMark('OLT001', 'SERVER OLT', 'pop', pop.at)}</Folder>`,
    `<Folder><name>ODC</name>${odcs.map((odc) => { const label = odcLabel.get(odc.label)!; return pointMark(label, `Splitter: 1:${odcCapacity}\nJumlah ODP: ${odc.members?.length ?? 0}`, 'odc', odc.at); }).join('')}</Folder>`,
    `<Folder><name>ODP</name>${odps.map((odp) => { const label = odpLabel.get(odp.label) ?? odp.label; const parent = odcs.find((odc) => odc.members?.includes(odp.label)); return pointMark(label, `Splitter: 1:${odpCapacity}\nJumlah rumah: ${odp.members?.length ?? 0}\nInduk: ${canonical(parent?.label ?? '')}`, 'odp', odp.at); }).join('')}</Folder>`,
  ];
  if (customers.length) assets.push(`<Folder><name>HC</name>${odps.flatMap((odp) => customers.filter((customer) => odp.members?.includes(customer.label)).map((customer, index) => pointMark(`${odpLabel.get(odp.label) ?? odp.label}-${String(index + 1).padStart(2, '0')}`, `Induk ODP: ${odpLabel.get(odp.label) ?? odp.label}`, 'house', customer.at))).join('')}</Folder>`);
  const feeders = cables.filter((cable) => cable.type === 'feeder');
  const feederCoords: Coord[] = [];
  const feederNames = [feeders.length ? (feeders[0].source === 'POP' ? 'OLT001' : canonical(feeders[0].source)) : ''];
  for (const feeder of feeders) {
    const coords = feeder.coords;
    if (feederCoords.length && coords.length && feederCoords.at(-1)![0] === coords[0][0] && feederCoords.at(-1)![1] === coords[0][1]) feederCoords.push(...coords.slice(1));
    else feederCoords.push(...coords);
    feederNames.push(canonical(feeder.target));
  }
  const feederFolder = feederCoords.length >= 2 ? `<Placemark><name>${escape(feederNames.filter(Boolean).join('-'))}</name>${data(feederNames.filter(Boolean).join('-'))}<styleUrl>#feeder</styleUrl>${lineMark(feederNames.join('-'), feederCoords, 'feeder')}</Placemark>` : '';
  const distributions = cables.filter((cable) => cable.type === 'distribution').map((cable) => lineMark(`${canonical(cable.source)}-${odpLabel.get(cable.target) ?? cable.target}`, cable.coords, 'distribution')).join('');
  const drops = odps.flatMap((odp) => customers.filter((customer) => odp.members?.includes(customer.label)).map((customer, index) => lineMark(`ODP ${odpLabel.get(odp.label) ?? odp.label} TO HC ${odpLabel.get(odp.label) ?? odp.label}-${String(index + 1).padStart(2, '0')}`, [odp.at, customer.at], 'drop'))).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>FTTH Design</name>${iconStyle('pop', palette.pop, 'http://maps.google.com/mapfiles/kml/shapes/electronics.png', 1.2)}${iconStyle('odc', palette.odc, 'http://maps.google.com/mapfiles/kml/shapes/triangle.png', 1.2)}${iconStyle('odp', palette.odp, 'http://maps.google.com/mapfiles/kml/shapes/triangle.png', 1)}${iconStyle('house', '#ffffff', 'files/ftth-house.png', 20 / 96)}${lineStyle('feeder', palette.feeder, 4)}${lineStyle('distribution', palette.distribution, 4)}${lineStyle('drop', palette.house, 3)}${boundariesKml ? `<Folder><name>BOUNDARY</name>${boundariesKml}</Folder>` : ''}<Folder><name>Assets</name>${assets.join('')}</Folder><Folder><name>Routes</name><Folder><name>Feeder Route</name>${feederFolder}</Folder><Folder><name>Distribution Route</name>${distributions ? `<Placemark><name>Distribution Route</name>${data('Distribution Route')}<styleUrl>#distribution</styleUrl><MultiGeometry>${distributions}</MultiGeometry></Placemark>` : ''}</Folder>${customers.length ? `<Folder><name>Drop Route</name>${drops ? `<Placemark><name>Drop Route</name><description>KABEL DROP ODP KE HC</description>${data('Drop Route')}<styleUrl>#drop</styleUrl><MultiGeometry>${drops}</MultiGeometry></Placemark>` : ''}</Folder>` : ''}</Folder></Document></kml>`;
}

function buildCsv(pop: Point, odcs: Point[], odps: Point[], customers: Point[], cables: Cable[]) {
  const quote = (value: unknown) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows: unknown[][] = [['Tipe', 'Nama', 'Kuantitas/Panjang', 'Satuan', 'Latitude', 'Longitude']];
  rows.push(['POP / Server OLT', pop.label, 1, 'pcs', pop.at[1], pop.at[0]]);
  const odcNames = new Map(odcs.map((odc, index) => [odc.label, `ODC ${String(index + 1).padStart(2, '0')}`]));
  const odpNames = new Map<string, string>();
  for (let odcIndex = 0; odcIndex < odcs.length; odcIndex++) {
    let odpIndex = 0;
    for (const odp of odps) if (odcs[odcIndex].members?.includes(odp.label)) odpNames.set(odp.label, `${String(odcIndex + 1).padStart(2, '0')}/${String(++odpIndex).padStart(2, '0')}`);
  }
  const distribution = new Map(cables.filter((cable) => cable.type === 'distribution').map((cable) => [cable.target, cable]));
  for (let odcIndex = 0; odcIndex < odcs.length; odcIndex++) {
    const odc = odcs[odcIndex], odcName = odcNames.get(odc.label)!;
    rows.push(['ODC', odcName, 1, 'pcs', odc.at[1], odc.at[0]]);
    rows.push(['Join Closure', `JOIN CLOSURE ${odcName}`, 1, 'pcs', odc.at[1], odc.at[0]]);
    const assigned = odps.filter((odp) => odc.members?.includes(odp.label));
    for (let odpIndex = 0; odpIndex < assigned.length; odpIndex++) {
      const odp = assigned[odpIndex], odpName = `${String(odcIndex + 1).padStart(2, '0')}/${String(odpIndex + 1).padStart(2, '0')}`;
      rows.push(['ODP', odpName, 1, 'pcs', odp.at[1], odp.at[0]]);
      const segment = distribution.get(odp.label), sourceName = segment?.source === odc.label ? odcName : odpNames.get(segment?.source ?? '') ?? odcName;
      rows.push(['Kabel Distribusi', `${sourceName} -> ${odpName}`, segment ? Number(segment.length.toFixed(2)) : 'DISCONNECTED', segment ? 'm' : '', '', '']);
      const odpCustomers = customers.filter((customer) => odp.members?.includes(customer.label));
      for (let houseIndex = 0; houseIndex < odpCustomers.length; houseIndex++) {
        const house = odpCustomers[houseIndex], houseName = `${odpName}-${String(houseIndex + 1).padStart(2, '0')}`;
        rows.push(['Homepass (Titik Rumah)', houseName, 1, 'pcs', house.at[1], house.at[0]]);
        rows.push(['Kabel Drop', `${odpName} -> ${houseName}`, Number((distance(odp.at, house.at) * 1.2).toFixed(2)), 'm', '', '']);
      }
    }
  }
  for (const feeder of cables.filter((cable) => cable.type === 'feeder')) {
    rows.push(['Kabel Feeder', `${feeder.source === 'POP' ? pop.label : odcNames.get(feeder.source) ?? feeder.source} -> ${odcNames.get(feeder.target) ?? feeder.target}`, Number(feeder.length.toFixed(2)), 'm', '', '']);
  }
  return Buffer.from(`${rows.map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`);
}

@Injectable()
export class GeneratorService {
  constructor(@Inject(DB) private readonly db: any) {}

  private async buildRoadGraph(elements: any[], strategy: string, holes: Coord[][] = []) {
    const roads = elements.filter((item) => ROAD_FACTORS[item.tags?.highway] !== undefined);
    const profile = 'vehicle-roads-v2';
    const key = createHash('sha256').update(JSON.stringify([profile, strategy, holes, roads.map((way) => [way.id, way.tags.highway, way.tags.oneway ?? (way.tags.junction === 'roundabout' ? true : false), way.geometry])])).digest('hex');
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
      const oneway = way.tags.oneway ?? (way.tags.junction === 'roundabout' ? true : false);
      for (let i = 1; i < coords.length; i++) {
        for (const [start, end] of clipSegmentOutsideHoles(coords[i - 1], coords[i], holes)) addEdge(graph, start, end, way.tags.highway, strategy, oneway);
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

  private async fetchLocal(rings: Boundary[], pop?: Coord, refresh = false) {
    const closed = (ring: Coord[]) => ring[0]?.[0] === ring[ring.length - 1]?.[0] && ring[0]?.[1] === ring[ring.length - 1]?.[1] ? ring : [...ring, ring[0]];
    const polygonWkt = (boundary: Boundary) => [boundary.outer, ...boundary.holes].map((ring) => `(${closed(ring).map((p) => `${p[0]} ${p[1]}`).join(',')})`).join(',');
    const wkt = rings.length === 1
      ? `POLYGON(${polygonWkt(rings[0])})`
      : `MULTIPOLYGON(${rings.map((ring) => `(${polygonWkt(ring)})`).join(',')})`;
    const active = await this.db.execute(sql`SELECT dataset_id, ST_Covers(coverage, ST_GeomFromText(${wkt},4326)) AS covers FROM osm_data.dataset WHERE status = 'active' LIMIT 1`);
    const dataset = active.rows?.[0];
    if (!dataset) throw new Error('Belum ada dataset OSM lokal yang aktif. Import OSM PBF terlebih dahulu.');
    if (!dataset.covers) throw new Error(`Boundary berada di luar cakupan dataset OSM lokal ${dataset.dataset_id}.`);
    const cacheRoot = process.env.LOCAL_OSM_CACHE_ROOT ?? join(tmpdir(), 'ftth_local_osm');
    const cachePath = join(cacheRoot, `${createHash('sha256').update(JSON.stringify([dataset.dataset_id, wkt, pop])).digest('hex')}.json`);
    const ttl = Math.max(0, Number(process.env.OSM_CACHE_MAX_AGE_SECONDS ?? 86400)) * 1000;
    const forceRefresh = refresh || String(process.env.OSM_FORCE_REFRESH ?? '').toLowerCase() === 'true';
    if (!forceRefresh && ttl) {
      try {
        const cached = JSON.parse(await readFile(cachePath, 'utf8'));
        if (Date.now() - cached.savedAt <= ttl && Array.isArray(cached.elements)) return cached;
      } catch { /* no usable local OSM cache */ }
    }
    const extent = rings.flatMap((ring) => ring.outer), tileSize = 0.05;
    const minLon = Math.min(...extent.map((point) => point[0])), maxLon = Math.max(...extent.map((point) => point[0]));
    const minLat = Math.min(...extent.map((point) => point[1])), maxLat = Math.max(...extent.map((point) => point[1]));
    const buildingTiles: { west: number; south: number; east: number; north: number }[] = [];
    for (let west = Math.floor(minLon / tileSize) * tileSize; west < maxLon; west += tileSize) for (let south = Math.floor(minLat / tileSize) * tileSize; south < maxLat; south += tileSize) {
      if (rings.some((ring) => intersectsTile(ring, west, south, west + tileSize, south + tileSize))) buildingTiles.push({ west, south, east: west + tileSize, north: south + tileSize });
    }
    const buildingTileIds: string[][] = new Array(buildingTiles.length);
    let nextBuildingTile = 0;
    const loadBuildingTiles = async () => {
      while (true) {
        const index = nextBuildingTile++, tile = buildingTiles[index];
        if (!tile) return;
        const tileKey = [tile.west, tile.south, tile.east, tile.north].map((value) => value.toFixed(6));
        const tilePath = join(cacheRoot, 'building_tiles', `${createHash('sha256').update(JSON.stringify([dataset.dataset_id, tileKey])).digest('hex')}.json`);
        if (!forceRefresh && ttl) {
          try {
            const cached = JSON.parse(await readFile(tilePath, 'utf8'));
            if (Date.now() - cached.savedAt <= ttl && Array.isArray(cached.ids)) { buildingTileIds[index] = cached.ids.map(String); continue; }
          } catch { /* query this region tile */ }
        }
        const ids = await this.db.execute(sql`SELECT osm_id FROM osm_data.building WHERE dataset_id = ${dataset.dataset_id} AND geom && ST_MakeEnvelope(${tile.west},${tile.south},${tile.east},${tile.north},4326) AND ST_Intersects(geom,ST_MakeEnvelope(${tile.west},${tile.south},${tile.east},${tile.north},4326))`);
        buildingTileIds[index] = (ids.rows ?? []).map((row: any) => String(row.osm_id));
        try {
          await mkdir(dirname(tilePath), { recursive: true });
          const temporary = `${tilePath}.${randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify({ savedAt: Date.now(), ids: buildingTileIds[index] }));
          await rename(temporary, tilePath);
        } catch { /* cache writes must not block generation */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(buildingTiles.length, 4) }, loadBuildingTiles));
    const buildingIds = [...new Set(buildingTileIds.flat())];
    const buildings = buildingIds.length ? await this.db.execute(sql`SELECT osm_id, ST_AsGeoJSON(CASE WHEN ST_Covers(ST_GeomFromText(${wkt},4326),ST_Centroid(geom)) THEN ST_Centroid(geom) ELSE ST_PointOnSurface(ST_Intersection(geom,ST_GeomFromText(${wkt},4326))) END) AS geometry FROM osm_data.building WHERE dataset_id = ${dataset.dataset_id} AND osm_id::text = ANY(${buildingIds}::text[]) AND geom && ST_GeomFromText(${wkt},4326) AND ST_Intersects(geom, ST_GeomFromText(${wkt},4326))`) : { rows: [] };
    const roadAreas = [sql`e.geom && ST_Expand(ST_GeomFromText(${wkt},4326),0.015)`];
    if (pop) for (const boundary of rings) if (!contains(boundary, pop)) {
      const nearest = nearestOnBoundary(pop, boundary), line = `LINESTRING(${pop[0]} ${pop[1]},${nearest[0]} ${nearest[1]})`;
      roadAreas.push(sql`e.geom && ST_Expand(ST_GeomFromText(${line},4326),0.015)`);
    }
    const roads = await this.db.execute(sql`SELECT e.edge_id, e.edge_index, e.highway, e.oneway, ST_AsGeoJSON(e.geom) AS geometry FROM osm_data.road_edge e WHERE e.dataset_id = ${dataset.dataset_id} AND (${sql.join(roadAreas, sql` OR `)})`);
    let popCandidate: { name: string; at: Coord } | undefined;
    try {
      const pois = await this.db.execute(sql`SELECT kind, name, ST_AsGeoJSON(ST_PointOnSurface(geom)) AS geometry FROM osm_data.poi WHERE dataset_id = ${dataset.dataset_id} AND kind IN ('station','office','main_road','road') AND geom && ST_Expand(ST_GeomFromText(${wkt},4326),0.01) AND ST_Intersects(geom,ST_Expand(ST_GeomFromText(${wkt},4326),0.01)) ORDER BY CASE kind WHEN 'station' THEN 1 WHEN 'office' THEN 2 WHEN 'main_road' THEN 3 ELSE 4 END, poi_id LIMIT 1`);
      const poi = pois.rows?.[0];
      if (poi) popCandidate = { name: poi.name || `POP OSM lokal (${poi.kind})`, at: JSON.parse(poi.geometry).coordinates as Coord };
    } catch { /* Older local OSM imports may not include the POI table. */ }
    const result = {
      elements: [
        ...(buildings.rows ?? []).map((row: any) => { const at = JSON.parse(row.geometry).coordinates as Coord; return { tags: { building: 'yes' }, geometry: [at, at] }; }),
        ...(roads.rows ?? []).map((row: any) => ({ tags: { highway: row.highway, oneway: row.oneway }, geometry: JSON.parse(row.geometry).coordinates })),
      ],
      popCandidate,
      metadata: { source: 'osm_postgis', dataset_id: dataset.dataset_id },
    };
    try {
      await mkdir(cacheRoot, { recursive: true });
      const temporary = `${cachePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ ...result, savedAt: Date.now() }));
      await rename(temporary, cachePath);
    } catch { /* caching must not block generation */ }
    return result;
  }

  private async fetchOsm(rings: Boundary[], refresh = false, pop?: Coord, checkpointDir?: string) {
    const points = rings.flatMap((boundary) => boundary.outer);
    const [minLon, maxLon] = [Math.min(...points.map((p) => p[0])), Math.max(...points.map((p) => p[0]))];
    const [minLat, maxLat] = [Math.min(...points.map((p) => p[1])), Math.max(...points.map((p) => p[1]))];
    const areaKm2 = Math.abs((maxLon - minLon) * 111.32 * Math.max(0.05, Math.cos(((minLat + maxLat) / 2) * Math.PI / 180)) * (maxLat - minLat) * 111.32);
    const tileSize = Math.max(0.005, Number(process.env.OSM_TILE_SIZE_DEG ?? 0.05)), tiles = Math.max(1, Math.ceil((maxLon - minLon) / tileSize)) * Math.max(1, Math.ceil((maxLat - minLat) / tileSize));
    const mode = (process.env.OSM_SOURCE_MODE ?? 'auto').trim().toLowerCase();
    const maxArea = Number(process.env.OSM_ONLINE_MAX_AREA_KM2 ?? 25), maxTiles = Number(process.env.OSM_ONLINE_MAX_TILES ?? 4);
    const local = mode === 'local' || (mode !== 'online' && (areaKm2 > maxArea || tiles > maxTiles));
    if (mode && !['auto', 'online', 'local'].includes(mode)) throw new BadRequestException('OSM_SOURCE_MODE harus bernilai auto, online, atau local.');
    if (local) return this.fetchLocal(rings, pop, refresh);
    try {
      const queryRings = [...rings];
      if (pop) for (const boundary of rings) if (!contains(boundary, pop)) queryRings.push({ outer: connectorRibbon(pop, nearestOnBoundary(pop, boundary), Number(process.env.OSM_CONNECTOR_BUFFER_DEG ?? 0.002)), holes: [] });
      const queryPoints = queryRings.flatMap((boundary) => boundary.outer), westLimit = Math.min(...queryPoints.map((p) => p[0])), eastLimit = Math.max(...queryPoints.map((p) => p[0]));
      const southLimit = Math.min(...queryPoints.map((p) => p[1])), northLimit = Math.max(...queryPoints.map((p) => p[1]));
      const overlap = Number(process.env.OSM_TILE_OVERLAP_DEG ?? 0.002), tilesToFetch: { west: number; south: number; east: number; north: number }[] = [];
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
              if (Array.isArray(checkpoint.elements)) { results[index] = checkpoint.elements; continue; }
            } catch { /* this tile has not been checkpointed yet */ }
          }
          if (!forceRefresh && ttl) {
            try {
              const cached = JSON.parse(await readFile(cachePath, 'utf8'));
              if (Date.now() - cached.savedAt <= ttl && Array.isArray(cached.elements) && cached.elements.length) { results[index] = cached.elements; continue; }
            } catch { /* no usable tile cache */ }
          }
          const polygon = [[tile.west, tile.south], [tile.west, tile.north], [tile.east, tile.north], [tile.east, tile.south], [tile.west, tile.south]].map(([lon, lat]) => `${lat} ${lon}`).join(' ');
          const query = `[out:json][timeout:90];(way(poly:"${polygon}")[building];way(poly:"${polygon}")[highway];node(poly:"${polygon}")[railway=station];way(poly:"${polygon}")[building=train_station];node(poly:"${polygon}")[office];way(poly:"${polygon}")[office];);out body geom;`;
          const response = await fetch(process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(Number(process.env.OSM_REQUEST_TIMEOUT_SECONDS ?? 100) * 1000) });
          if (!response.ok) throw new Error(`Overpass ${response.status}`);
          const elements = ((await response.json() as any).elements ?? []) as any[];
          results[index] = elements;
          if (checkpointPath) {
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
      const unique = new Map<string, any>();
      for (const elements of results) for (const element of elements ?? []) unique.set(`${element.type}:${element.id}`, element);
      const elements = [...unique.values()];
      return { elements, popCandidate: strategicPop(elements, centroid(rings[0].outer)), metadata: { source: 'osm_online', timestamp: new Date().toISOString(), tile_count: tilesToFetch.length } };
    } catch (error) {
      if ((process.env.OSM_LOCAL_FALLBACK_ON_ONLINE_FAILURE ?? 'true').toLowerCase() === 'false') throw new ServiceUnavailableException(`Gagal mengambil data OSM online: ${error instanceof Error ? error.message : 'service unavailable'}`);
      try { return await this.fetchLocal(rings, pop, refresh); }
      catch (localError) { throw new ServiceUnavailableException(`OSM online gagal dan dataset lokal tidak tersedia: ${localError instanceof Error ? localError.message : 'service unavailable'}`); }
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
      const ring = item.geometry.map(asCoord).filter((point: Coord) => point.every(Number.isFinite));
      if (ring.length < 3) return [];
      return [{ index, wkt: `POLYGON(${ringWkt(ring)})` }];
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
      END) AS geometry FROM clipped`);
      return new Map((result.rows ?? []).map((row: any) => [Number(row.idx), JSON.parse(row.geometry).coordinates as Coord]));
    } catch {
      return undefined;
    }
  }

  async generate(boundaryBytes: Buffer, boundaryName: string, popBytes: Buffer | undefined, popName: string | undefined, options: any, checkpointDir?: string) {
    options = generationConfig(options);
    const marks = await readKml(boundaryBytes, boundaryName);
    const boundaries = marks.flatMap((item) => item.polygon ? [item.polygon] : []);
    if (!boundaries.length) throw new BadRequestException('Boundary KML/KMZ wajib berisi polygon.');
    if (boundaries.some((boundary) => boundary.outer.length < 3 || boundary.holes.some((hole) => hole.length < 3))) throw new BadRequestException('Setiap boundary harus memiliki minimal tiga titik.');
    let pop = popBytes && popName ? (await readKml(popBytes, popName)).find((item) => item.point)?.point : undefined;
    if (popBytes && pop && !boundaries.some((boundary) => contains(boundary, pop!))) {
      const distanceM = Math.min(...boundaries.map((boundary) => distance(pop!, nearestOnBoundary(pop!, boundary))));
      if (distanceM > 3000) throw new BadRequestException({ message: 'POP (Sentral) terlalu jauh dari area perancangan (> 3 km). Harap letakkan POP lebih dekat dengan area boundary.', details: { distance_m: Math.round(distanceM * 10) / 10, limit_m: 3000 } });
    }
    const area = centroid([...boundaries].sort((a, b) => b.outer.length - a.outer.length)[0].outer);
    const { elements, popCandidate, metadata: sourceMetadata } = await this.fetchOsm(boundaries, options.force_refresh_osm, pop, checkpointDir);
    const roads = elements.filter((item) => ROAD_FACTORS[item.tags?.highway] !== undefined);
    const graph = await this.buildRoadGraph(elements, options.routing_strategy, boundaries.flatMap((boundary) => boundary.holes));
    if (!graph.size) throw new ServiceUnavailableException('Tidak ada jaringan jalan kendaraan pada boundary.');
    if (!pop) {
      const candidate = popCandidate?.at ?? strategicPop(elements, area)?.at;
      pop = candidate ? closestNode(graph, candidate)?.at ?? candidate : closestNode(graph, area)?.at ?? area;
    }
    if (!pop) throw new ServiceUnavailableException('Lokasi POP tidak dapat ditentukan.');
    const customers: Point[] = marks.filter((item) => item.point && /house|home|customer|rumah|building|tiang/i.test(item.name)).map((item, index) => ({ label: item.name || `HOUSE-${index + 1}`, at: item.point! }));
    const seenBuildings = new Set<string>();
    const exactBuildingPoints = await this.postgisBuildingPoints(elements, boundaries);
    const buildings = elements.flatMap((item, index) => {
      if (!item.tags?.building || !item.geometry?.length) return [];
      const geometry = item.geometry.map(asCoord);
      const centroidPoint = geometry.length <= 2 ? geometry[0] : polygonCentroid(geometry);
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
    const houses = customers.length ? customers : buildings;
    if (!houses.length) throw new BadRequestException('Tidak ada bangunan di area boundary.');
    const odpCapacity = Math.max(1, Number(options.odp_capacity ?? 10)), odcCapacity = Math.max(1, Number(options.odc_capacity ?? 4));
    const minOdpSize = Math.max(1, Number(options.min_odp_cluster_size ?? 1)), minOdcSize = Math.max(1, Number(options.min_odc_cluster_size ?? 1));
    if (minOdpSize > odpCapacity || minOdcSize > odcCapacity) throw new BadRequestException('Ukuran minimum cluster tidak boleh melebihi kapasitas perangkat.');
    const houseGroups = capacitatedClusters(houses.map((house) => house.at), odpCapacity, minOdpSize).map((indices) => indices.map((index) => houses[index]));
    const snappingDistance = Number(options.snapping_distance_m ?? 100);
    const populatedHouseGroups = houseGroups;
    const byOdp: Point[] = houseGroups.map((group, index) => {
      const at: Coord = [group.reduce((sum, p) => sum + p.at[0], 0) / group.length, group.reduce((sum, p) => sum + p.at[1], 0) / group.length];
      return { label: `ODP-${String(index + 1).padStart(3, '0')}`, at: snapGeneratedPoint(graph, at, snappingDistance), members: group.map((house) => house.label) };
    });
    const odcGroups = capacitatedClusters(byOdp.map((odp) => odp.at), odcCapacity, minOdcSize);
    const odcs: Point[] = odcGroups.map((indices, index) => {
      const group = indices.map((i) => byOdp[i]);
      const at: Coord = [group.reduce((sum, odp) => sum + odp.at[0], 0) / group.length, group.reduce((sum, odp) => sum + odp.at[1], 0) / group.length];
      return { label: `ODC-${String(index + 1).padStart(3, '0')}`, at: snapGeneratedPoint(graph, at, snappingDistance), members: group.map((odp) => odp.label) };
    });
    enforceOdcSpacing(graph, odcs);
    const cables: Cable[] = [], routeCache = new Map<string, Coord[]>();
    rebalanceOdpsByRoadConnectivity(graph, odcs, byOdp, Number(options.max_distribution_length_m ?? 500), odcCapacity, routeCache);
    for (const odc of odcs) cables.push(...buildDistributionTree(graph, odc, byOdp.filter((odp) => odc.members!.includes(odp.label)), Number(options.max_distribution_length_m ?? 500), routeCache));
    const ordered = orderOdcChain(pop, odcs);
    const odcRenames = new Map(ordered.map((odc, index) => [odc.label, `ODC-${String(index + 1).padStart(3, '0')}`]));
    const feederOdcs = ordered.map((odc) => ({ ...odc, label: odcRenames.get(odc.label)! }));
    for (const cable of cables.filter((item) => item.type === 'distribution')) {
      cable.source = odcRenames.get(cable.source) ?? cable.source;
    }
    let feederSource = pop, feederSourceLabel = 'POP';
    for (const odc of feederOdcs) {
      const coords = route(graph, feederSource, odc.at, routeCache);
      cables.push({ type: 'feeder', source: feederSourceLabel, target: odc.label, coords, length: pathLength(coords) });
      feederSource = odc.at; feederSourceLabel = odc.label;
    }
    if (options.include_homepass) for (let i = 0; i < byOdp.length; i++) for (const house of populatedHouseGroups[i]) {
      const coords: Coord[] = [byOdp[i].at, house.at]; cables.push({ type: 'homepass', source: byOdp[i].label, target: house.label, coords, length: distance(byOdp[i].at, house.at) });
    }
    const styles = options.feature_colors && typeof options.feature_colors === 'object' ? options.feature_colors : {};
    const kml = buildKml({ label: 'POP', at: pop }, feederOdcs, byOdp, options.include_homepass ? houses : [], cables, styles, boundaries, odpCapacity, odcCapacity);
    const kmz = await buildKmz(kml, styles);
    const csv = buildCsv({ label: 'POP', at: pop }, feederOdcs, byOdp, houses, cables);
    const stats = { odc_count: odcs.length, odp_count: byOdp.length, customer_count: houses.length, feeder_length_km: cables.filter((c) => c.type === 'feeder').reduce((s, c) => s + c.length, 0) / 1000, distribution_length_km: cables.filter((c) => c.type === 'distribution').reduce((s, c) => s + c.length, 0) / 1000 };
    const issues: { severity: string; code: string; message: string; details: Record<string, unknown> }[] = [];
    const addIssue = (severity: string, code: string, message: string, details: Record<string, unknown>) => issues.push({ severity, code, message, details });
    for (let i = 0; i < byOdp.length; i++) {
      const odp = byOdp[i], group = populatedHouseGroups[i];
      const radiusLimit = Number(options.max_odp_radius_m ?? 150);
      for (let index = 0; index < group.length; index++) {
        const radius = distance(odp.at, group[index].at);
        if (radius > radiusLimit) addIssue('WARNING', 'ODP_RADIUS_EXCEEDED', `${odp.label}: rumah #${index + 1} berjarak ${radius.toFixed(0)}m (batas ${radiusLimit.toFixed(0)}m).`, { odp_id: odp.label, house_index: index, distance_m: Math.round(radius * 10) / 10, limit_m: radiusLimit });
      }
      if (group.length > odpCapacity) addIssue('WARNING', 'ODP_OVER_CAPACITY', `${odp.label} melayani ${group.length} rumah (batas ${odpCapacity}).`, { odp_id: odp.label, count: group.length, limit: odpCapacity });
    }
    for (const odc of feederOdcs) {
      const assigned = byOdp.filter((odp) => odc.members?.includes(odp.label));
      if (assigned.length > odcCapacity) addIssue('WARNING', 'ODC_OVER_CAPACITY', `${odc.label} melayani ${assigned.length} ODP (batas ${odcCapacity}).`, { odc_id: odc.label, count: assigned.length, limit: odcCapacity });
      for (const odp of assigned) {
        const radius = distance(odc.at, odp.at);
        const radiusLimit = Number(options.max_odc_radius_m ?? 500);
        if (radius > radiusLimit) addIssue('WARNING', 'ODC_RADIUS_EXCEEDED', `${odc.label} → ${odp.label} berjarak ${radius.toFixed(0)}m (batas ${radiusLimit.toFixed(0)}m).`, { odc_id: odc.label, odp_id: odp.label, distance_m: Math.round(radius * 10) / 10, limit_m: radiusLimit });
      }
    }
    for (const cable of cables) {
      const limit = cable.type === 'feeder' ? Number(options.max_feeder_length_m ?? 2000) : cable.type === 'distribution' ? Number(options.max_distribution_length_m ?? 500) : Infinity;
      if (cable.length > limit) addIssue(cable.type === 'feeder' || cable.type === 'distribution' ? 'ERROR' : 'WARNING', `${cable.type.toUpperCase()}_LENGTH_EXCEEDED`, `${cable.source} → ${cable.target} ${cable.length.toFixed(0)}m (batas ${limit.toFixed(0)}m).`, { source: cable.source, target: cable.target, length_m: Math.round(cable.length), limit_m: limit });
    }
    const feederTargets = new Set(cables.filter((cable) => cable.type === 'feeder').map((cable) => cable.target));
    if (feederTargets.size < feederOdcs.length) addIssue('ERROR', 'DISCONNECTED_ODC', `Hanya ${feederTargets.size} dari ${feederOdcs.length} ODC memiliki feeder.`, { connected: feederTargets.size, total: feederOdcs.length });
    const distributionParent = new Map(cables.filter((cable) => cable.type === 'distribution').map((cable) => [cable.target, cable.source]));
    for (const odc of feederOdcs) {
      const assigned = new Set(odc.members ?? []);
      for (const odp of byOdp.filter((item) => assigned.has(item.label))) {
        const parent = distributionParent.get(odp.label);
        if (!parent || (parent !== odc.label && !assigned.has(parent))) {
          addIssue('ERROR', 'DISCONNECTED_DISTRIBUTION', `${odp.label} tidak terhubung ke ${odc.label}.`, { odp_id: odp.label, odc_id: odc.label, source_id: parent ?? null });
          continue;
        }
        const seen = new Set<string>();
        let current: string | undefined = odp.label;
        while (current && current !== odc.label) {
          if (seen.has(current)) {
            addIssue('ERROR', 'DISTRIBUTION_CYCLE', `Siklus ditemukan pada tree distribusi ${odc.label}.`, { odc_id: odc.label, odp_id: odp.label });
            break;
          }
          seen.add(current);
          current = distributionParent.get(current);
        }
        if (current !== odc.label) addIssue('ERROR', 'DISCONNECTED_DISTRIBUTION', `${odp.label} tidak memiliki jalur ke ${odc.label}.`, { odp_id: odp.label, odc_id: odc.label });
      }
    }
    const houseOwner = new Map<string, string>();
    for (let index = 0; index < byOdp.length; index++) for (const house of populatedHouseGroups[index]) {
      const key = `${house.at[0].toFixed(8)},${house.at[1].toFixed(8)}`, previous = houseOwner.get(key);
      if (previous) addIssue('ERROR', 'DUPLICATE_ASSIGNMENT', `Rumah ${house.label} dipetakan ke ${previous} dan ${byOdp[index].label}.`, { lat: house.at[1], lon: house.at[0], odp_1: previous, odp_2: byOdp[index].label });
      else houseOwner.set(key, byOdp[index].label);
    }
    const errors = issues.filter((issue) => issue.severity === 'ERROR').length, warnings = issues.filter((issue) => issue.severity === 'WARNING').length;
    const validation = { status: errors ? 'ERROR' : warnings ? 'WARNING' : 'PASS', issues, summary: { errors, warnings, info: 0 } };
    return { kmz, csv, state: { pop, boundaries, odcs: feederOdcs, odps: byOdp, customers: houses, cables, roads: [...graph.values()].flatMap((node) => node.edges.filter((edge) => edge.oneway || node.id < edge.to).map((edge) => ({ coords: edge.coords, highway: edge.highway, oneway: edge.oneway }))), validation }, stats, validation, metadata: { ...sourceMetadata, road_count: roads.length, boundary: boundaryName } };
  }

  async generateCustom(bytes: Buffer, name: string, options: any, checkpointDir?: string) {
    options = generationConfig(options);
    const marks = await readKml(bytes, name);
    const labeledPoints = marks.filter((item) => item.point).map((item, index) => {
      const label = item.name || 'Unknown', context = `${label} ${item.context ?? ''}`;
      const role = /(^|[^A-Z0-9])ODP/i.test(label) || /^\s*\d+\s*\/\s*\d+\s*$/.test(label) ? 'odp'
        : /(^|[^A-Z0-9])ODC/i.test(label) ? 'odc'
          : /(^|[^A-Z0-9])(OLT|POP|SENTRAL|RBS)(?:\s*[-_ ]?\s*\d+)?(?=$|[^A-Z0-9])/i.test(context) ? 'pop'
            : /(^|[^A-Z0-9])ODC/i.test(context) ? 'odc'
              : /(^|[^A-Z0-9])ODP/i.test(context) ? 'odp'
                : /(^|[^A-Z0-9])(HC|RUMAH|HOME\s*PASS)([^A-Z0-9]|$)/i.test(context) ? 'hc' : undefined;
      return { label: item.name || `${role ?? 'POINT'}-${index + 1}`, at: item.point!, context, role };
    });
    const pop = labeledPoints.find((item) => item.role === 'pop');
    const odcs = labeledPoints.filter((item) => item.role === 'odc').map((p) => ({ ...p, members: [] as string[] }));
    const odps = labeledPoints.filter((item) => item.role === 'odp').map((p) => ({ ...p, members: [] as string[] }));
    const customers = labeledPoints.filter((item) => item.role === 'hc');
    if (!pop) throw new BadRequestException(`KML custom tidak memiliki titik berlabel OLT/POP (${odcs.length} ODC, ${odps.length} ODP, ${customers.length} HC).`);
    if (!odcs.length || !odps.length) throw new BadRequestException(`KML custom perlu titik ODC dan ODP (${odcs.length} ODC, ${odps.length} ODP).`);
    const points = [pop, ...odcs, ...odps, ...customers].map((p) => p.at);
    const minLon = Math.min(...points.map((p) => p[0])), maxLon = Math.max(...points.map((p) => p[0]));
    const minLat = Math.min(...points.map((p) => p[1])), maxLat = Math.max(...points.map((p) => p[1]));
    const ring: Coord[] = [[minLon, minLat], [minLon, maxLat], [maxLon, maxLat], [maxLon, minLat], [minLon, minLat]];
    const { elements, metadata: sourceMetadata } = await this.fetchOsm([{ outer: ring, holes: [] }], options.force_refresh_osm, pop.at, checkpointDir);
    const graph = await this.buildRoadGraph(elements, options.routing_strategy);
    if (!graph.size) throw new ServiceUnavailableException('Jaringan jalan OSM tidak tersedia.');
    const snap = <T extends Point>(point: T): T => {
      const at = nearestRoadPoint(graph, point.at);
      if (!at) throw new ServiceUnavailableException('Jaringan jalan kendaraan OSM tidak tersedia untuk snapping perangkat.');
      return { ...point, at };
    };
    const snappedPop = pop, snappedOdcs = odcs.map(snap), snappedOdps = odps.map(snap), snappedCustomers = customers;
    const groupNumber = (text: string, kind: 'odc' | 'odp') => {
      const value = text.match(/(?:^|[^A-Z0-9])ODC\s*[-_ ]?\s*(\d+)/i)?.[1]
        ?? (kind === 'odp' ? text.match(/(?:^|[^A-Z0-9])ODP\s*[-_ ]?\s*(\d+)\s*\/\s*\d+/i)?.[1] : undefined)
        ?? (kind === 'odp' ? text.match(/^\s*(\d+)\s*\//)?.[1] : undefined);
      return value === undefined ? undefined : String(Number(value));
    };
    const explicitOdcGroups = new Set(snappedOdcs.map((odc) => groupNumber(odc.context, 'odc')).filter((group): group is string => Boolean(group)));
    for (const odp of snappedOdps) {
      const explicitGroup = groupNumber(odp.context, 'odp');
      const mapped = explicitGroup ? snappedOdcs.find((odc) => groupNumber(odc.context, 'odc') === explicitGroup) : undefined;
      if (explicitGroup && explicitOdcGroups.size && !mapped) throw new BadRequestException(`Mapping ${odp.label} menunjuk ke group ODC ${explicitGroup}, tetapi ODC tersebut tidak ditemukan.`);
      const parent = mapped ?? snappedOdcs.reduce((best, item) => distance(item.at, odp.at) < distance(best.at, odp.at) ? item : best, snappedOdcs[0]);
      parent.members!.push(odp.label);
    }
    for (const customer of snappedCustomers) {
      const parent = snappedOdps.reduce((best, item) => distance(item.at, customer.at) < distance(best.at, customer.at) ? item : best, snappedOdps[0]);
      parent.members!.push(customer.label);
    }
    const customOdcs = orderOdcChain(snappedPop.at, snappedOdcs).map((odc, index) => ({ ...odc, label: `ODC-${String(index + 1).padStart(3, '0')}` }));
    const cables: Cable[] = [], routeCache = new Map<string, Coord[]>();
    let source: Coord = snappedPop.at, sourceLabel = snappedPop.label;
    for (const odc of customOdcs) {
      const coords = route(graph, source, odc.at, routeCache);
      cables.push({ type: 'feeder', source: sourceLabel, target: odc.label, coords, length: pathLength(coords) }); source = odc.at; sourceLabel = odc.label;
      const assigned = snappedOdps.filter((odp) => odc.members!.includes(odp.label));
      const distribution = buildDistributionTree(graph, odc, assigned, Number(options.max_distribution_length_m ?? 500), routeCache);
      if (distribution.length !== assigned.length) throw new ServiceUnavailableException(`Tidak semua ODP terhubung ke tree distribusi ${odc.label}.`);
      cables.push(...distribution);
    }
    if (options.include_homepass) for (const odp of snappedOdps) for (const customer of snappedCustomers.filter((item) => odp.members!.includes(item.label))) {
      const drop: Coord[] = [odp.at, customer.at];
      cables.push({ type: 'homepass', source: odp.label, target: customer.label, coords: drop, length: distance(odp.at, customer.at) });
    }
    const styles = options.feature_colors ?? {};
    const kmz = await buildKmz(buildKml(snappedPop, customOdcs, snappedOdps, options.include_homepass ? snappedCustomers : [], cables, styles, [], Number(options.odp_capacity), Number(options.odc_capacity)), styles);
    const csv = buildCsv(snappedPop, customOdcs, snappedOdps, snappedCustomers, cables);
    const stats = { odc_count: odcs.length, odp_count: odps.length, customer_count: customers.length, feeder_length_km: cables.filter((c) => c.type === 'feeder').reduce((s, c) => s + c.length, 0) / 1000, distribution_length_km: cables.filter((c) => c.type === 'distribution').reduce((s, c) => s + c.length, 0) / 1000 };
    const issues: { severity: string; code: string; message: string; details: Record<string, unknown> }[] = cables.flatMap((cable) => {
      const limit = cable.type === 'feeder' ? options.max_feeder_length_m : cable.type === 'distribution' ? options.max_distribution_length_m : Infinity;
      return cable.length > limit ? [{ severity: 'ERROR', code: `${cable.type.toUpperCase()}_LENGTH_EXCEEDED`, message: `${cable.source} → ${cable.target} ${cable.length.toFixed(0)}m (batas ${limit}m).`, details: { source: cable.source, target: cable.target, length_m: Math.round(cable.length), limit_m: limit } }] : [];
    });
    const addIssue = (severity: string, code: string, message: string, details: Record<string, unknown>) => issues.push({ severity, code, message, details });
    for (const odc of customOdcs) {
      const assigned = snappedOdps.filter((odp) => odc.members!.includes(odp.label));
      if (!assigned.length) addIssue('ERROR', 'ODC_EMPTY', `${odc.label} tidak memiliki ODP.`, { odc_id: odc.label });
      if (assigned.length > options.odc_capacity) addIssue('WARNING', 'ODC_OVER_CAPACITY', `${odc.label} melayani ${assigned.length} ODP (batas ${options.odc_capacity}).`, { odc_id: odc.label, count: assigned.length, limit: options.odc_capacity });
      for (const odp of assigned) {
        const radius = distance(odc.at, odp.at);
        if (radius > options.max_odc_radius_m) addIssue('WARNING', 'ODC_RADIUS_EXCEEDED', `${odc.label} → ${odp.label} berjarak ${radius.toFixed(0)}m (batas ${options.max_odc_radius_m}m).`, { odc_id: odc.label, odp_id: odp.label, distance_m: Math.round(radius), limit_m: options.max_odc_radius_m });
        const customersForOdp = snappedCustomers.filter((customer) => odp.members!.includes(customer.label));
        if (!customersForOdp.length) addIssue('WARNING', 'ODP_EMPTY', `${odp.label} tidak memiliki rumah.`, { odp_id: odp.label, odc_id: odc.label });
        if (customersForOdp.length > options.odp_capacity) addIssue('WARNING', 'ODP_OVER_CAPACITY', `${odp.label} melayani ${customersForOdp.length} rumah (batas ${options.odp_capacity}).`, { odp_id: odp.label, count: customersForOdp.length, limit: options.odp_capacity });
        for (let index = 0; index < customersForOdp.length; index++) {
          const radius = distance(odp.at, customersForOdp[index].at);
          if (radius > options.max_odp_radius_m) addIssue('WARNING', 'ODP_RADIUS_EXCEEDED', `${odp.label}: rumah #${index + 1} berjarak ${radius.toFixed(0)}m (batas ${options.max_odp_radius_m}m).`, { odp_id: odp.label, house_index: index, distance_m: Math.round(radius), limit_m: options.max_odp_radius_m });
        }
      }
    }
    const errors = issues.filter((issue) => issue.severity === 'ERROR').length, warnings = issues.filter((issue) => issue.severity === 'WARNING').length;
    const validation = { status: errors ? 'ERROR' : warnings ? 'WARNING' : 'PASS', issues, summary: { errors, warnings, info: 0 } };
    return { kmz, csv, state: { pop: snappedPop.at, odcs: customOdcs, odps: snappedOdps, customers: snappedCustomers, cables, roads: [...graph.values()].flatMap((node) => node.edges.filter((edge) => edge.oneway || node.id < edge.to).map((edge) => ({ coords: edge.coords, highway: edge.highway, oneway: edge.oneway }))), validation }, stats, validation, metadata: { ...sourceMetadata, source_file: name } };
  }

  async fromCache(state: any, options: any, operation: 'homepass' | 'regenerate') {
    options = generationConfig(options);
    const graph = new Map<string, Node>();
    const routeCache = new Map<string, Coord[]>();
    const odcs: Point[] = (state.odcs ?? []).map((odc: Point) => ({ ...odc, members: [...(odc.members ?? [])] }));
    const odps: Point[] = state.odps ?? [];
    for (const edge of state.roads ?? []) {
      const coords = Array.isArray(edge) ? edge : edge.coords;
      addEdge(graph, coords[0], coords[1], edge.highway ?? 'residential', options.routing_strategy, edge.oneway ?? false);
    }
    const cables: Cable[] = operation === 'regenerate' ? [] : (state.cables ?? []).filter((cable: Cable) => cable.type !== 'homepass');
    if (operation === 'homepass') {
      for (const odp of odps) for (const customer of (state.customers ?? []).filter((item: Point) => odp.members?.includes(item.label))) {
        const coords: Coord[] = [odp.at, customer.at];
        cables.push({ type: 'homepass', source: odp.label, target: customer.label, coords, length: distance(odp.at, customer.at) });
      }
    } else {
      rebalanceOdpsByRoadConnectivity(graph, odcs, odps, Number(options.max_distribution_length_m ?? 500), Number(options.odc_capacity ?? 4), routeCache);
      let source: Coord = state.pop, sourceLabel = 'POP';
      for (const odc of odcs) {
        const coords = route(graph, source, odc.at, routeCache);
        cables.push({ type: 'feeder', source: sourceLabel, target: odc.label, coords, length: pathLength(coords) });
        source = odc.at; sourceLabel = odc.label;
        const assigned = odps.filter((odp) => odc.members?.includes(odp.label));
        const distribution = buildDistributionTree(graph, odc, assigned, Number(options.max_distribution_length_m ?? 500), routeCache);
        if (distribution.length !== assigned.length) {
          const connected = new Set(distribution.map((cable) => cable.target));
          throw new ServiceUnavailableException(`ODP tidak terhubung ke tree distribusi ${odc.label}: ${assigned.filter((odp) => !connected.has(odp.label)).map((odp) => odp.label).join(', ')}.`);
        }
        cables.push(...distribution);
      }
      if (options.include_homepass) for (const odp of odps) for (const customer of (state.customers ?? []).filter((item: Point) => odp.members?.includes(item.label))) {
        const coords: Coord[] = [odp.at, customer.at];
        cables.push({ type: 'homepass', source: odp.label, target: customer.label, coords, length: distance(odp.at, customer.at) });
      }
    }
    const stats = { odc_count: odcs.length, odp_count: odps.length, customer_count: state.customers?.length ?? 0, feeder_length_km: cables.filter((c) => c.type === 'feeder').reduce((s, c) => s + c.length, 0) / 1000, distribution_length_km: cables.filter((c) => c.type === 'distribution').reduce((s, c) => s + c.length, 0) / 1000 };
    const featureColors = options.feature_colors ?? {};
    const kmz = await buildKmz(buildKml({ label: 'POP', at: state.pop }, odcs, odps, state.customers ?? [], cables, featureColors, state.boundaries ?? [], Number(options.odp_capacity), Number(options.odc_capacity)), featureColors);
    const csv = buildCsv({ label: 'POP', at: state.pop }, odcs, odps, state.customers ?? [], cables);
    const validation = state.validation ?? { status: 'PASS', issues: [], summary: { errors: 0, warnings: 0, info: 0 } };
    return { kmz, csv, state: { ...state, odcs, cables, validation }, stats, validation, metadata: { source: 'cached', operation } };
  }
}
