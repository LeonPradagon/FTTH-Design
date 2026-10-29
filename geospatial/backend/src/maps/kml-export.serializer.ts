import type { ResolvedFeatureStyle } from './map-style-resolver.service';

export type Position = [number, number] | [number, number, number];
export type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint'; coordinates: Position[] }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] }
  | { type: 'GeometryCollection'; geometries: Geometry[] };

export type KmlExportFolder = {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
};

export type KmlExportFeature = {
  id: string;
  folderId?: string | null;
  name: string;
  description?: string | null;
  geometry: Geometry | null;
  rawProperties?: Record<string, unknown> | null;
  style?: ResolvedFeatureStyle | null;
  sourcePath?: string | null;
};

export type KmlExportInput = {
  mapName: string;
  provinceName: string;
  folders: KmlExportFolder[];
  importedFeatures: KmlExportFeature[];
  drawnFeatures: KmlExportFeature[];
};

type FolderNode = KmlExportFolder & {
  children: FolderNode[];
  features: KmlExportFeature[];
};

type KmlSafeStyle = {
  pointColor: [number, number, number, number];
  lineColor: [number, number, number, number];
  fillColor: [number, number, number, number];
  labelColor: [number, number, number, number] | null;
  lineWidth: number;
  iconScale: number;
  iconHref: string | null;
  labelScale: number | null;
};

const DEFAULT_POINT_COLOR: [number, number, number, number] = [
  37, 99, 235, 255,
];
const DEFAULT_LINE_COLOR: [number, number, number, number] = [15, 23, 42, 255];
const DEFAULT_FILL_COLOR: [number, number, number, number] = [37, 99, 235, 72];

function escapeXml(value: string) {
  return value
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function kmlColor(color?: [number, number, number, number]) {
  const [red, green, blue, alpha] = color ?? DEFAULT_LINE_COLOR;
  return [alpha, blue, green, red]
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
}

function finiteNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const numericValue = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, numericValue));
}

function safeColor(
  value: unknown,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  if (!Array.isArray(value) || value.length < 3) {
    return fallback;
  }

  return [
    finiteNumber(value[0], fallback[0], 0, 255),
    finiteNumber(value[1], fallback[1], 0, 255),
    finiteNumber(value[2], fallback[2], 0, 255),
    finiteNumber(value[3], fallback[3], 0, 255),
  ];
}

function optionalColor(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  return safeColor(value, DEFAULT_LINE_COLOR);
}

function safeStyle(
  style: ResolvedFeatureStyle | null | undefined,
): KmlSafeStyle {
  return {
    pointColor: safeColor(style?.pointColor, DEFAULT_POINT_COLOR),
    lineColor: safeColor(style?.lineColor, DEFAULT_LINE_COLOR),
    fillColor: safeColor(style?.fillColor, DEFAULT_FILL_COLOR),
    labelColor: optionalColor(style?.labelColor),
    lineWidth: finiteNumber(style?.lineWidth, 2, 0.1, 64),
    iconScale: finiteNumber(style?.iconScale, 1, 0.1, 16),
    iconHref: typeof style?.iconHref === 'string' ? style.iconHref : null,
    labelScale:
      style?.labelScale === undefined || style?.labelScale === null
        ? null
        : finiteNumber(style.labelScale, 1, 0.1, 16),
  };
}

function coordinates(positions: Position[]) {
  return positions
    .map((position) =>
      position.map((item) => Number(item).toFixed(8)).join(','),
    )
    .join(' ');
}

function linearRing(positions: Position[]) {
  const closed = [...positions];
  const first = positions[0];
  const last = positions[positions.length - 1];

  if (
    first &&
    last &&
    (first[0] !== last[0] || first[1] !== last[1] || first[2] !== last[2])
  ) {
    closed.push(first);
  }

  return `<LinearRing><coordinates>${coordinates(closed)}</coordinates></LinearRing>`;
}

function polygonGeometry(rings: Position[][]) {
  const [outer, ...inner] = rings;
  if (!outer) {
    return '';
  }

  return [
    '<Polygon>',
    `<outerBoundaryIs>${linearRing(outer)}</outerBoundaryIs>`,
    ...inner.map(
      (ring) => `<innerBoundaryIs>${linearRing(ring)}</innerBoundaryIs>`,
    ),
    '</Polygon>',
  ].join('');
}

function geometryToKml(geometry: Geometry | null): string {
  if (!geometry) {
    return '';
  }

  switch (geometry.type) {
    case 'Point':
      return `<Point><coordinates>${coordinates([geometry.coordinates])}</coordinates></Point>`;
    case 'MultiPoint':
      return `<MultiGeometry>${geometry.coordinates
        .map((position) =>
          geometryToKml({ type: 'Point', coordinates: position }),
        )
        .join('')}</MultiGeometry>`;
    case 'LineString':
      return `<LineString><tessellate>1</tessellate><coordinates>${coordinates(
        geometry.coordinates,
      )}</coordinates></LineString>`;
    case 'MultiLineString':
      return `<MultiGeometry>${geometry.coordinates
        .map((line) => geometryToKml({ type: 'LineString', coordinates: line }))
        .join('')}</MultiGeometry>`;
    case 'Polygon':
      return polygonGeometry(geometry.coordinates);
    case 'MultiPolygon':
      return `<MultiGeometry>${geometry.coordinates
        .map((polygon) => polygonGeometry(polygon))
        .join('')}</MultiGeometry>`;
    case 'GeometryCollection':
      return `<MultiGeometry>${geometry.geometries.map(geometryToKml).join('')}</MultiGeometry>`;
  }
}

function extendedData(feature: KmlExportFeature) {
  const entries = Object.entries(feature.rawProperties ?? {}).filter(
    ([, value]) =>
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean',
  );

  if (entries.length === 0) {
    return '';
  }

  return [
    '<ExtendedData>',
    ...entries.map(
      ([key, value]) =>
        `<Data name="${escapeXml(key)}"><value>${escapeXml(String(value))}</value></Data>`,
    ),
    '</ExtendedData>',
  ].join('');
}

function styleKey(style: ResolvedFeatureStyle | null | undefined) {
  return JSON.stringify(safeStyle(style));
}

function buildStyles(features: KmlExportFeature[]) {
  const styleIds = new Map<string, string>();
  const styles: string[] = [];

  for (const feature of features) {
    const key = styleKey(feature.style);
    if (styleIds.has(key)) {
      continue;
    }

    const style = safeStyle(feature.style);
    const styleId = `style-${styleIds.size + 1}`;
    styleIds.set(key, styleId);
    styles.push(
      [
        `<Style id="${styleId}">`,
        '<IconStyle>',
        `<color>${kmlColor(style.pointColor)}</color>`,
        `<scale>${style.iconScale}</scale>`,
        style.iconHref
          ? `<Icon><href>${escapeXml(style.iconHref)}</href></Icon>`
          : '',
        '</IconStyle>',
        '<LineStyle>',
        `<color>${kmlColor(style.lineColor)}</color>`,
        `<width>${style.lineWidth}</width>`,
        '</LineStyle>',
        '<PolyStyle>',
        `<color>${kmlColor(style.fillColor)}</color>`,
        '</PolyStyle>',
        style.labelColor || style.labelScale
          ? `<LabelStyle><color>${kmlColor(
              style.labelColor ?? DEFAULT_LINE_COLOR,
            )}</color><scale>${style.labelScale ?? 1}</scale></LabelStyle>`
          : '',
        '</Style>',
      ].join(''),
    );
  }

  return { styleIds, styles };
}

function placemark(feature: KmlExportFeature, styleId: string | undefined) {
  const geometry = geometryToKml(feature.geometry);
  if (!geometry) {
    return '';
  }

  return [
    '<Placemark>',
    `<name>${escapeXml(feature.name || 'Untitled feature')}</name>`,
    feature.description
      ? `<description>${escapeXml(feature.description)}</description>`
      : '',
    styleId ? `<styleUrl>#${styleId}</styleUrl>` : '',
    extendedData(feature),
    geometry,
    '</Placemark>',
  ].join('');
}

function buildFolderTree(
  folders: KmlExportFolder[],
  importedFeatures: KmlExportFeature[],
) {
  const nodeById = new Map<string, FolderNode>();
  const requiredIds = new Set<string>();

  for (const folder of folders) {
    nodeById.set(folder.id, { ...folder, children: [], features: [] });
  }

  for (const feature of importedFeatures) {
    if (!feature.folderId) {
      continue;
    }

    let folder = nodeById.get(feature.folderId);
    folder?.features.push(feature);

    while (folder) {
      requiredIds.add(folder.id);
      folder = folder.parentId ? nodeById.get(folder.parentId) : undefined;
    }
  }

  const roots: FolderNode[] = [];
  for (const node of nodeById.values()) {
    if (!requiredIds.has(node.id)) {
      continue;
    }

    const parent = node.parentId ? nodeById.get(node.parentId) : null;
    if (parent && requiredIds.has(parent.id)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (nodes: FolderNode[]) => {
    nodes.sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.name.localeCompare(right.name),
    );
    for (const node of nodes) {
      node.children.sort(
        (left, right) =>
          left.sortOrder - right.sortOrder ||
          left.name.localeCompare(right.name),
      );
      sortNodes(node.children);
      node.features.sort((left, right) =>
        (left.sourcePath ?? left.name).localeCompare(
          right.sourcePath ?? right.name,
        ),
      );
    }
  };

  sortNodes(roots);
  return roots;
}

function folderToKml(
  folder: FolderNode,
  styleIds: Map<string, string>,
): string {
  return [
    '<Folder>',
    `<name>${escapeXml(folder.name || 'Folder')}</name>`,
    ...folder.features.map((feature) =>
      placemark(feature, styleIds.get(styleKey(feature.style))),
    ),
    ...folder.children.map((child) => folderToKml(child, styleIds)),
    '</Folder>',
  ].join('');
}

export function serializeKmlExport(input: KmlExportInput) {
  const allFeatures = [...input.importedFeatures, ...input.drawnFeatures];
  const { styleIds, styles } = buildStyles(allFeatures);
  const importedRoots = buildFolderTree(input.folders, input.importedFeatures);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    `<name>${escapeXml(`${input.mapName} - ${input.provinceName}`)}</name>`,
    ...styles,
    ...importedRoots.map((folder) => folderToKml(folder, styleIds)),
    input.drawnFeatures.length > 0
      ? [
          '<Folder>',
          '<name>Drawn Features</name>',
          ...input.drawnFeatures.map((feature) =>
            placemark(feature, styleIds.get(styleKey(feature.style))),
          ),
          '</Folder>',
        ].join('')
      : '',
    '</Document>',
    '</kml>',
  ].join('');
}

export function createKmlFilename(mapName: string, provinceName: string) {
  const slug = `${mapName}-${provinceName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);

  return `${sanitizeId(slug || 'map-export')}.kml`;
}
