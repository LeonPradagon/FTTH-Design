import type {
  Feature,
  FeatureCollection,
  Geometry,
  GeoJsonProperties,
  LineString,
  MultiPolygon,
  Point,
  Polygon,
} from "geojson";

export interface HealthResponse {
  status: string;
  service: string;
  timestamp: string;
  database: {
    status: string;
    database?: string;
    databaseVersion?: string;
    postgisEnabled?: boolean;
    postgisVersion?: string | null;
    checkedAt?: string;
  };
  error?: string;
}

export interface ImportedMapSummary {
  id: string;
  name: string;
  originalFilename: string;
  uploadedByUserId?: string | null;
  importStatus: string;
  importError?: string | null;
  catalogRootName?: string | null;
  folderCount: number;
  featureCount: number;
  pointCount: number;
  lineStringCount: number;
  polygonCount: number;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MapUploadHistoryItem {
  id: string;
  name: string;
  originalFilename: string;
  fileSizeBytes: number;
  importStatus: string;
  importError: string | null;
  folderCount: number;
  featureCount: number;
  pointCount: number;
  lineStringCount: number;
  polygonCount: number;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
  uploadedByUserId: string | null;
  uploadedByName: string | null;
  uploadedByEmail: string | null;
}

export interface SuggestedProvince {
  id: string;
  name: string;
  featureCount: number;
  pointCount: number;
}

export interface ImportMapResponse {
  message: string;
  map: ImportedMapSummary;
  suggestedProvince?: SuggestedProvince | null;
}

export interface DeleteMapPackageResponse {
  success: boolean;
  deletedMapId: string;
  deletedName: string;
}

export type UserRole = "admin" | "staff";
export type AppAccess = "geospatial" | "planner";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  role: UserRole;
  appAccess: AppAccess[];
  status: "active" | "disabled";
  forcePasswordReset: boolean;
  lastLoginAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  token?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CurrentSessionResponse {
  user: SessionUser;
  session: SessionRecord;
}

export type ImportedColor = [number, number, number, number];

export interface ImportedFeatureStyle {
  pointColor?: ImportedColor;
  lineColor?: ImportedColor;
  fillColor?: ImportedColor;
  labelColor?: ImportedColor;
  lineWidth?: number;
  iconScale?: number;
  iconHref?: string;
  labelScale?: number;
}

export type ImportedFeatureProperties = NonNullable<GeoJsonProperties> & {
  name?: string | null;
  description?: string | null;
  geometryType?: string | null;
  sourcePath?: string | null;
  styleUrl?: string | null;
  style?: ImportedFeatureStyle | null;
  rawProperties?: Record<string, unknown> | null;
};

export type ImportedFeature = Feature<Geometry, ImportedFeatureProperties>;
export type DrawnGeometry = Point | LineString | Polygon;

export type DrawnFeature = Feature<DrawnGeometry, ImportedFeatureProperties>;

export type ProvinceProperties = NonNullable<GeoJsonProperties> & {
  provinceId: string;
  name: string;
  rawProperties?: Record<string, unknown> | null;
};

export type ProvinceFeature = Feature<
  Polygon | MultiPolygon,
  ProvinceProperties
>;

export type ProvinceFeatureCollection = FeatureCollection<
  Polygon | MultiPolygon,
  ProvinceProperties
>;

export interface MapTreeNode {
  id: string;
  parentId: string | null;
  name: string;
  depth: number;
  sourcePath: string;
  isOpenByDefault: boolean;
  symbols: MapTreeSymbol[];
  features: MapTreeFeature[];
  counts: {
    childFolders: number;
    descendantFolders: number;
    directFeatures: number;
    descendantFeatures: number;
  };
  children: MapTreeNode[];
}

export interface MapTreeFeature {
  displayName?: string | null;
  id: string;
  name: string;
  geometryType: string | null;
  styleUrl: string | null;
  style?: ImportedFeatureStyle | null;
}

export interface MapTreeSymbol {
  geometryType: string | null;
  styleUrl: string | null;
  count: number;
  style?: ImportedFeatureStyle | null;
}

export interface MapTreeResponse {
  map: ImportedMapSummary;
  tree: MapTreeNode[];
}

export interface ImportedFeatureCollection extends FeatureCollection<
  Geometry,
  ImportedFeatureProperties
> {
  meta: {
    mapId: string;
    provinceId: string | null;
    bbox: string | null;
    limit: number;
    truncated: boolean;
  };
}

export type PointTileMode = "points" | "clusters";

export interface ImportedPointTilePoint {
  id: string;
  featureId: string | null;
  name: string;
  longitude: number;
  latitude: number;
  sourcePath: string | null;
  rawProperties?: Record<string, unknown> | null;
  styleUrl?: string | null;
  style?: ImportedFeatureStyle | null;
}

export interface ImportedPointCluster {
  id: string;
  position: [number, number];
  count: number;
}

export interface ImportedPointSummary {
  mapId: string;
  provinceId: string;
  provinceName: string;
  pointCount: number;
}

export interface ImportedPointTileResponse {
  meta: {
    mapId: string;
    provinceId: string;
    provinceName: string;
    mode: "points";
    z: number;
    x: number;
    y: number;
    tileId: string;
    pointCount: number;
  };
  points: ImportedPointTilePoint[];
}

export interface ImportedPointClusterTileResponse {
  meta: {
    mapId: string;
    provinceId: string;
    provinceName: string;
    mode: "clusters";
    z: number;
    x: number;
    y: number;
    tileId: string;
    pointCount: number;
    clusterCount: number;
  };
  clusters: ImportedPointCluster[];
}

export interface CreateDrawnFeatureRequest {
  description?: string;
  geometry: DrawnGeometry;
  name?: string;
  rawProperties?: Record<string, unknown>;
  style?: ImportedFeatureStyle | null;
}

export interface UpdateDrawnFeatureRequest {
  description?: string;
  geometryType: "Point" | "LineString" | "Polygon";
  name?: string;
  rawProperties?: Record<string, unknown>;
  style?: ImportedFeatureStyle | null;
}

export interface PreviewRouteResponse {
  provider: "graphhopper";
  costing: "motor_scooter";
  fallbackUsed: boolean;
  strictAvoidanceApplied: boolean;
  distanceMeters: number;
  durationSeconds: number;
  warnings: string[];
  geometry: LineString;
  segments: PreviewRouteSegment[];
}

export interface PreviewRouteSegment extends PreviewRouteResponseBase {
  from: [number, number];
  routeError?: string;
  routeStatus: "routed" | "failed";
  segmentIndex: number;
  to: [number, number];
}

interface PreviewRouteResponseBase {
  provider: "graphhopper";
  costing: "motor_scooter";
  fallbackUsed: boolean;
  strictAvoidanceApplied: boolean;
  distanceMeters: number;
  durationSeconds: number;
  warnings: string[];
  geometry: LineString;
}

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL;

export const API_BASE_URL = (
  configuredBaseUrl === undefined
    ? "http://localhost:3000"
    : configuredBaseUrl.trim()
).replace(/\/+$/, "");

async function readErrorMessage(response: Response) {
  try {
    const body = (await response.json()) as {
      error?: string;
      message?: string | string[];
    };

    if (Array.isArray(body.message)) {
      return body.message.join(", ");
    }

    return body.error || body.message || response.statusText;
  } catch {
    return response.statusText || "Request failed";
  }
}

type RequestJsonOptions = {
  body?: unknown;
  method?: "DELETE" | "GET" | "PATCH" | "POST";
  signal?: AbortSignal;
};

function filenameFromContentDisposition(value: string | null) {
  const filenameStarMatch = value?.match(/filename\*=UTF-8''([^;]+)/i);
  if (filenameStarMatch?.[1]) {
    return decodeURIComponent(filenameStarMatch[1].replace(/"/g, ""));
  }

  const filenameMatch = value?.match(/filename="?([^";]+)"?/i);
  return filenameMatch?.[1] ?? "map-export.kml";
}

async function requestJson<T>(path: string, options: RequestJsonOptions = {}) {
  const headers = new Headers();

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    signal: options.signal,
    headers,
    credentials: "include",
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as T;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/health");
}

export async function fetchMaps(): Promise<ImportedMapSummary[]> {
  return requestJson<ImportedMapSummary[]>("/maps");
}

export async function fetchUsers(): Promise<SessionUser[]> {
  return requestJson<SessionUser[]>("/users");
}

export async function createUser(input: {
  email: string;
  password: string;
  role: UserRole;
  appAccess: AppAccess[];
}): Promise<SessionUser> {
  return requestJson<SessionUser>("/users", {
    method: "POST",
    body: input,
  });
}

export async function updateUserAppAccess(
  userId: string,
  appAccess: AppAccess[],
): Promise<SessionUser> {
  return requestJson<SessionUser>(`/users/${userId}/app-access`, {
    method: "PATCH",
    body: { appAccess },
  });
}

export async function resetUserPassword(
  userId: string,
  password: string,
): Promise<SessionUser> {
  return requestJson<SessionUser>(`/users/${userId}/reset-password`, {
    method: "POST",
    body: {
      password,
    },
  });
}

export async function deleteUser(userId: string): Promise<{
  success: boolean;
  deletedUserId: string;
  deletedEmail: string;
}> {
  return requestJson(`/users/${userId}`, {
    method: "DELETE",
  });
}

export async function changeMyPassword(input: {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions?: boolean;
}): Promise<SessionUser> {
  return requestJson<SessionUser>("/users/me/password", {
    method: "POST",
    body: input,
  });
}

export async function fetchMapUploadHistory(): Promise<MapUploadHistoryItem[]> {
  return requestJson<MapUploadHistoryItem[]>("/maps/upload-history");
}

export async function deleteMapPackage(
  mapId: string,
): Promise<DeleteMapPackageResponse> {
  return requestJson<DeleteMapPackageResponse>(`/maps/${mapId}`, {
    method: "DELETE",
  });
}

export async function uploadMapSource(
  file: File,
  name?: string,
  autoRoute = true,
): Promise<ImportMapResponse> {
  const body = new FormData();
  body.append("file", file);
  body.append("autoRoute", String(autoRoute));

  if (name?.trim()) {
    body.append("name", name.trim());
  }

  const response = await fetch(`${API_BASE_URL}/maps/import-upload`, {
    method: "POST",
    body,
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as ImportMapResponse;
}

export async function fetchProvinces(): Promise<ProvinceFeatureCollection> {
  return requestJson<ProvinceFeatureCollection>("/provinces");
}

export async function fetchMapTree(mapId: string): Promise<MapTreeResponse> {
  return requestJson<MapTreeResponse>(`/maps/${mapId}/tree`);
}

export async function fetchMapFeatures(
  mapId: string,
  options: {
    provinceId: string;
    bbox?: string;
    folderIds?: string[];
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<ImportedFeatureCollection> {
  return requestJson<ImportedFeatureCollection>(`/maps/${mapId}/features`, {
    method: "POST",
    body: {
      provinceId: options.provinceId,
      bbox: options.bbox,
      folderIds: options.folderIds,
      limit: options.limit,
    },
    signal: options.signal,
  });
}

export async function suggestMapProvince(
  mapId: string,
  folderIds: string[],
  signal?: AbortSignal,
): Promise<SuggestedProvince | null> {
  return requestJson<SuggestedProvince | null>(
    `/maps/${mapId}/provinces/suggest`,
    {
      method: "POST",
      body: {
        folderIds,
      },
      signal,
    },
  );
}

type MapExportOptions = {
  provinceId: string;
  folderIds?: string[];
  excludedFolderIds?: string[];
  hiddenFeatureIds?: string[];
};

async function downloadMapExport(
  mapId: string,
  format: "kml" | "csv",
  options: MapExportOptions,
): Promise<void> {
  const exportUrl = `${API_BASE_URL}/maps/${mapId}/export/${format}`;
  const response = await fetch(exportUrl, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provinceId: options.provinceId,
      folderIds: options.folderIds,
      excludedFolderIds: options.excludedFolderIds,
      hiddenFeatureIds: options.hiddenFeatureIds,
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const blob = await response.blob();
  const filename = filenameFromContentDisposition(
    response.headers.get("Content-Disposition"),
  );
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

export async function downloadMapKml(
  mapId: string,
  options: MapExportOptions,
): Promise<void> {
  await downloadMapExport(mapId, "kml", options);
}

export async function downloadMapCsv(
  mapId: string,
  options: MapExportOptions,
): Promise<void> {
  await downloadMapExport(mapId, "csv", options);
}

export async function fetchPointSummary(
  mapId: string,
  provinceId: string,
  folderIds?: string[],
  signal?: AbortSignal,
): Promise<ImportedPointSummary> {
  return requestJson<ImportedPointSummary>(
    `/maps/${mapId}/provinces/${provinceId}/points/summary`,
    {
      method: "POST",
      body: {
        folderIds,
      },
      signal,
    },
  );
}

export async function fetchPointTile(
  mapId: string,
  provinceId: string,
  z: number,
  x: number,
  y: number,
  folderIds?: string[],
  signal?: AbortSignal,
): Promise<ImportedPointTileResponse> {
  return requestJson<ImportedPointTileResponse>(
    `/maps/${mapId}/provinces/${provinceId}/points/tiles/${z}/${x}/${y}`,
    {
      method: "POST",
      body: {
        folderIds,
      },
      signal,
    },
  );
}

export async function fetchPointClusterTile(
  mapId: string,
  provinceId: string,
  z: number,
  x: number,
  y: number,
  folderIds?: string[],
  signal?: AbortSignal,
): Promise<ImportedPointClusterTileResponse> {
  return requestJson<ImportedPointClusterTileResponse>(
    `/maps/${mapId}/provinces/${provinceId}/point-clusters/tiles/${z}/${x}/${y}`,
    {
      method: "POST",
      body: {
        folderIds,
      },
      signal,
    },
  );
}

export async function previewRoute(
  mapId: string,
  options: {
    points: [number, number][];
    signal?: AbortSignal;
  },
): Promise<PreviewRouteResponse> {
  return requestJson<PreviewRouteResponse>(`/maps/${mapId}/routes/preview`, {
    method: "POST",
    body: {
      points: options.points,
    },
    signal: options.signal,
  });
}

export async function createDrawnFeature(
  mapId: string,
  payload: CreateDrawnFeatureRequest,
): Promise<DrawnFeature> {
  return requestJson<DrawnFeature>(`/maps/${mapId}/drawn-features`, {
    method: "POST",
    body: payload,
  });
}

export async function updateDrawnFeature(
  mapId: string,
  featureId: string,
  payload: UpdateDrawnFeatureRequest,
): Promise<DrawnFeature> {
  return requestJson<DrawnFeature>(
    `/maps/${mapId}/drawn-features/${featureId}`,
    {
      method: "PATCH",
      body: payload,
    },
  );
}

export async function deleteDrawnFeature(
  mapId: string,
  featureId: string,
  geometryType: UpdateDrawnFeatureRequest["geometryType"],
): Promise<{
  success: boolean;
  deletedFeatureId: string;
  geometryType: UpdateDrawnFeatureRequest["geometryType"];
}> {
  return requestJson(`/maps/${mapId}/drawn-features/${featureId}`, {
    method: "DELETE",
    body: {
      geometryType,
    },
  });
}
