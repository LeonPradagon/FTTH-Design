import type {
  Geometry,
  KmlExportFeature,
  KmlExportFolder,
} from './kml-export.serializer';

type CsvExportInput = {
  mapName: string;
  provinceName: string;
  folders: KmlExportFolder[];
  importedFeatures: KmlExportFeature[];
  drawnFeatures: KmlExportFeature[];
};

type CsvFeatureRow = {
  source: 'imported' | 'drawn';
  feature: KmlExportFeature;
};

const COLUMNS = [
  'source',
  'id',
  'folder_id',
  'folder_path',
  'name',
  'description',
  'geometry_type',
  'longitude',
  'latitude',
  'coordinates',
  'source_path',
] as const;

function sanitizeFilenamePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function csvSafeText(value: string) {
  const withoutInvalidControls = value.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    '',
  );

  if (/^\s*[=+\-@]/.test(withoutInvalidControls)) {
    return `'${withoutInvalidControls}`;
  }

  return withoutInvalidControls;
}

function csvCell(value: unknown) {
  if (value === null || value === undefined) {
    return '';
  }

  const text =
    typeof value === 'number' ? String(value) : csvSafeText(String(value));
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function folderPathById(folders: KmlExportFolder[]) {
  const lookup = new Map(folders.map((folder) => [folder.id, folder]));
  const cache = new Map<string, string>();

  const resolvePath = (folderId: string): string => {
    const cached = cache.get(folderId);
    if (cached !== undefined) {
      return cached;
    }

    const folder = lookup.get(folderId);
    if (!folder) {
      return '';
    }

    const parentPath = folder.parentId ? resolvePath(folder.parentId) : '';
    const path = parentPath ? `${parentPath}/${folder.name}` : folder.name;
    cache.set(folderId, path);
    return path;
  };

  for (const folder of folders) {
    resolvePath(folder.id);
  }

  return cache;
}

function geometryType(geometry: Geometry | null) {
  return geometry?.type ?? '';
}

function pointCoordinates(geometry: Geometry | null) {
  if (geometry?.type !== 'Point') {
    return { longitude: '', latitude: '' };
  }

  const [longitude, latitude] = geometry.coordinates;
  return {
    longitude,
    latitude,
  };
}

function geometryCoordinates(geometry: Geometry | null) {
  if (!geometry) {
    return '';
  }

  if (geometry.type === 'GeometryCollection') {
    return JSON.stringify(geometry.geometries);
  }

  return JSON.stringify(geometry.coordinates);
}

export function serializeCsvExport(input: CsvExportInput) {
  const pathsByFolderId = folderPathById(input.folders);
  const rows: CsvFeatureRow[] = [
    ...input.importedFeatures.map((feature) => ({
      source: 'imported' as const,
      feature,
    })),
    ...input.drawnFeatures.map((feature) => ({
      source: 'drawn' as const,
      feature,
    })),
  ];

  return [
    COLUMNS.map(csvCell).join(','),
    ...rows.map(({ source, feature }) => {
      const point = pointCoordinates(feature.geometry);

      return [
        source,
        feature.id,
        feature.folderId ?? '',
        feature.folderId ? (pathsByFolderId.get(feature.folderId) ?? '') : '',
        feature.name || 'Untitled feature',
        feature.description ?? '',
        geometryType(feature.geometry),
        point.longitude,
        point.latitude,
        geometryCoordinates(feature.geometry),
        feature.sourcePath ?? '',
      ]
        .map(csvCell)
        .join(',');
    }),
  ].join('\r\n');
}

export function createCsvFilename(mapName: string, provinceName: string) {
  const slug = `${mapName}-${provinceName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);

  return `${sanitizeFilenamePart(slug || 'map-export')}.csv`;
}
