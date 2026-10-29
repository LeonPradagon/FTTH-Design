import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Compass,
  Download,
  FileSpreadsheet,
  Menu,
  Minus,
  Plus,
  Save,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import type { Feature, Geometry } from "geojson";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import "./App.css";
import { useAuth } from "./auth/auth-context";
import { useMediaQuery } from "./hooks/use-media-query";
import { AppNavbar } from "./components/app-shell/AppNavbar";
import { LegendSidebar } from "./components/app-shell/LegendSidebar";
import { StreetViewPanel } from "./components/StreetViewPanel";
import {
  collectHiddenFeatureIds,
  collectHiddenFolderIds,
  collectNodeIds,
  collectRenderableFolderIds,
  collectTreeCheckIds,
  featureTreeKey,
} from "./components/VisibilityTree";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import {
  DeckMapView,
  INITIAL_VIEW_STATE,
  POINT_CLUSTER_ZOOM_THRESHOLD,
  emptyImportedFeatureCollection,
  type MapViewportBounds,
  type MeasurementOverlay,
  type PointLoadProgress,
  type PointRenderState,
  type SelectedMapFeatureDetail,
} from "./components/DeckMapView";
import {
  createDrawnFeature,
  deleteDrawnFeature,
  deleteMapPackage,
  downloadMapCsv,
  downloadMapKml,
  fetchMapFeatures,
  fetchMapTree,
  fetchMapUploadHistory,
  fetchMaps,
  fetchPointClusterTile,
  fetchPointTile,
  fetchProvinces,
  previewRoute,
  suggestMapProvince,
  type ImportedColor,
  type ImportedFeatureCollection,
  type ImportedFeatureStyle,
  type ImportedMapSummary,
  type ImportedPointCluster,
  type ImportedPointTilePoint,
  type MapUploadHistoryItem,
  type MapTreeNode,
  type MapTreeFeature,
  type UpdateDrawnFeatureRequest,
  updateDrawnFeature,
  uploadMapSource,
} from "./lib/api";
import {
  bboxContains,
  clampTileZoom,
  decodeTileKey,
  geometryBounds,
  parseBbox,
  tileRangeFromBboxes,
} from "./lib/tile-grid";
import {
  formatDuration,
  formatMetricDistance,
  initialMeasurementState,
  measurementReducer,
  straightLineDistanceMeters,
  type LngLat,
} from "./lib/measurement";
import type {
  DraftFeatureKind,
  DraftFeatureRecord,
  LegendClassItem,
  WorkspaceTool,
} from "./components/app-shell/types";

type LoadedPointTileEntry = {
  status: "loading" | "loaded" | "error";
  pointCount: number;
  points: ImportedPointTilePoint[];
  clusters: ImportedPointCluster[];
};

type PointTileCaches = Record<string, Record<string, LoadedPointTileEntry>>;
type DisplayPointView = {
  scopeKey: string;
  state: PointRenderState;
  tileKeys: string[];
};

const VIEWPORT_BBOX_DEBOUNCE_MS = 320;
const POINT_TILE_QUEUE_CONCURRENCY = 4;
const POINT_REQUEST_BUFFER_TILES = 1;
const POINT_CACHE_BUFFER_TILES = 2;
const CLUSTER_REQUEST_BUFFER_TILES = 2;
const CLUSTER_CACHE_BUFFER_TILES = 4;
const VIEWPORT_QUERY_CACHE_MS = 30000;

const INITIAL_LEGEND_CLASSES: LegendClassItem[] = [
  {
    id: "odp",
    name: "ODP",
    description: "Optical distribution point for last-mile handoff.",
    color: "#2563eb",
    visible: true,
  },
  {
    id: "odc",
    name: "ODC",
    description: "Optical distribution cabinet for feeder aggregation.",
    color: "#0f766e",
    visible: true,
  },
  {
    id: "olt",
    name: "OLT",
    description: "Optical line terminal at the active network headend.",
    color: "#7c3aed",
    visible: true,
  },
  {
    id: "ont",
    name: "ONT",
    description: "Optical network terminal for customer termination points.",
    color: "#f97316",
    visible: true,
  },
  {
    id: "closure",
    name: "Closure",
    description: "Splice or access closure used along the distribution run.",
    color: "#db2777",
    visible: true,
  },
];

function clampColorChannel(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexToImportedColor(hex: string, alpha = 255): ImportedColor {
  const normalized = hex.trim().replace("#", "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((value) => `${value}${value}`)
          .join("")
      : normalized.padEnd(6, "0").slice(0, 6);

  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
    clampColorChannel(alpha),
  ];
}

function darkenImportedColor(
  color: ImportedColor,
  factor = 0.72,
): ImportedColor {
  return [
    clampColorChannel(color[0] * factor),
    clampColorChannel(color[1] * factor),
    clampColorChannel(color[2] * factor),
    color[3],
  ];
}

function legendStyleFor(
  kind: DraftFeatureKind,
  legendClass: LegendClassItem,
): ImportedFeatureStyle {
  const solidColor = hexToImportedColor(legendClass.color, 255);
  const pointColor = hexToImportedColor(legendClass.color, 224);
  const fillColor = hexToImportedColor(
    legendClass.color,
    kind === "polygon" ? 68 : 44,
  );

  return {
    pointColor,
    lineColor: solidColor,
    fillColor,
    labelColor: darkenImportedColor(solidColor, 0.42),
    lineWidth: kind === "line" ? 4 : 3,
    iconScale: 1,
    labelScale: 1,
  };
}

function applyLegendClassToFeature(
  feature: Feature<Geometry>,
  kind: DraftFeatureKind,
  draftName: string,
  legendClass: LegendClassItem,
): Feature<Geometry> {
  const existingRawProperties =
    feature.properties &&
    typeof feature.properties === "object" &&
    feature.properties.rawProperties &&
    typeof feature.properties.rawProperties === "object"
      ? feature.properties.rawProperties
      : {};

  return {
    ...feature,
    properties: {
      ...feature.properties,
      name: draftName,
      geometryType: feature.geometry.type,
      style: legendStyleFor(kind, legendClass),
      rawProperties: {
        ...existingRawProperties,
        source: "drawn",
        legendClassId: legendClass.id,
        legendClassName: legendClass.name,
        legendColor: legendClass.color,
      },
    },
  };
}

function draftKindForGeometry(geometryType: string): DraftFeatureKind | null {
  if (geometryType === "Point") {
    return "node";
  }

  if (geometryType === "LineString") {
    return "line";
  }

  if (geometryType === "Polygon") {
    return "polygon";
  }

  return null;
}

function pointOverlayFromFeature(
  feature: Feature<Geometry>,
): ImportedPointTilePoint | null {
  if (feature.geometry.type !== "Point") {
    return null;
  }

  const [longitude, latitude] = feature.geometry.coordinates;

  return {
    id: String(feature.id ?? `${longitude}:${latitude}`),
    featureId: null,
    name:
      typeof feature.properties?.name === "string"
        ? feature.properties.name
        : "Drawn node",
    longitude: Number(longitude),
    latitude: Number(latitude),
    sourcePath: null,
    rawProperties:
      feature.properties?.rawProperties &&
      typeof feature.properties.rawProperties === "object"
        ? feature.properties.rawProperties
        : null,
    style:
      feature.properties?.style && typeof feature.properties.style === "object"
        ? (feature.properties.style as ImportedFeatureStyle)
        : null,
    styleUrl: null,
  };
}

function eyeAltitudeFromZoom(zoom: number) {
  const kilometers = Math.max(1, Math.round(220 / 2 ** (zoom - 6)));
  return `${kilometers}km`;
}

function findFirstMap(maps: { importStatus: string; id: string }[]) {
  return (
    maps.find((entry) => entry.importStatus === "imported") ?? maps[0] ?? null
  );
}

function pointStateKey(state: PointRenderState | null) {
  return state ? `${state.mode}:${state.zoom}` : null;
}

function pointStateScopeKey(state: PointRenderState | null, folderKey: string) {
  const baseKey = pointStateKey(state);
  return baseKey ? `${baseKey}:${folderKey}` : null;
}

function pointStateEquals(
  left: PointRenderState | null,
  right: PointRenderState | null,
) {
  return left?.mode === right?.mode && left?.zoom === right?.zoom;
}

function tileKeysEqual(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function createEmptyTileEntry(
  status: LoadedPointTileEntry["status"],
): LoadedPointTileEntry {
  return {
    status,
    pointCount: 0,
    points: [],
    clusters: [],
  };
}

function buildTreeStateRecord(
  nodes: MapTreeNode[],
  current: Record<string, boolean> | undefined,
  defaultValue: (node: MapTreeNode) => boolean,
) {
  const next: Record<string, boolean> = {};

  const walk = (node: MapTreeNode) => {
    next[node.id] = current?.[node.id] ?? defaultValue(node);
    for (const feature of node.features ?? []) {
      const featureKey = featureTreeKey(feature.id);
      next[featureKey] = current?.[featureKey] ?? defaultValue(node);
    }
    for (const child of node.children) {
      walk(child);
    }
  };

  for (const node of nodes) {
    walk(node);
  }

  return next;
}

function recordEqual(
  left: Record<string, boolean> | undefined,
  right: Record<string, boolean>,
) {
  if (!left) {
    return Object.keys(right).length === 0;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return rightKeys.every((key) => left[key] === right[key]);
}

function dedupeRenderedPoints(points: ImportedPointTilePoint[]) {
  const seen = new Set<string>();

  return points.filter((point) => {
    if (seen.has(point.id)) {
      return false;
    }

    seen.add(point.id);
    return true;
  });
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

type DraftSketchTool = Extract<WorkspaceTool, "line" | "polygon">;

function draftLabel(kind: DraftFeatureKind, index: number) {
  const prefix =
    kind === "node" ? "Node" : kind === "line" ? "Line" : "Polygon";

  return `${prefix} ${String(index).padStart(3, "0")}`;
}

function fallbackDraftName(draft: DraftFeatureRecord) {
  const match = draft.id.match(/-(\d+)$/);
  const sequence = match ? Number.parseInt(match[1], 10) : Number.NaN;

  return Number.isFinite(sequence)
    ? draftLabel(draft.kind, sequence)
    : `${draft.kind} draft`;
}

function normalizeDraftRecord(draft: DraftFeatureRecord): DraftFeatureRecord {
  const trimmedName = draft.name.trim();
  const resolvedName = trimmedName || fallbackDraftName(draft);

  return {
    ...draft,
    name: resolvedName,
    feature: {
      ...draft.feature,
      properties: {
        ...draft.feature.properties,
        name: resolvedName,
      },
    },
  };
}

function routeSegmentName(
  routeName: string,
  segmentIndex: number,
  count: number,
) {
  return count > 1 ? `${routeName} - Segment ${segmentIndex + 1}` : routeName;
}

function segmentizedRouteFeatures(
  draft: DraftFeatureRecord,
  routeGroupId: string,
): Feature<Geometry>[] {
  if (draft.feature.geometry.type !== "LineString") {
    return [draft.feature];
  }

  const segments = draft.routeSegments?.length
    ? draft.routeSegments
    : [
        {
          provider: "graphhopper" as const,
          costing: "motor_scooter" as const,
          fallbackUsed: false,
          strictAvoidanceApplied: false,
          distanceMeters: 0,
          durationSeconds: 0,
          warnings: [],
          geometry: draft.feature.geometry,
          from: draft.feature.geometry.coordinates[0] as [number, number],
          routeStatus: "routed" as const,
          segmentIndex: 0,
          to: draft.feature.geometry.coordinates[
            draft.feature.geometry.coordinates.length - 1
          ] as [number, number],
        },
      ];

  const existingRawProperties =
    draft.feature.properties?.rawProperties &&
    typeof draft.feature.properties.rawProperties === "object"
      ? draft.feature.properties.rawProperties
      : {};

  return segments.map((segment) => {
    const name = routeSegmentName(
      draft.name,
      segment.segmentIndex,
      segments.length,
    );

    return {
      ...draft.feature,
      geometry: segment.geometry,
      properties: {
        ...draft.feature.properties,
        name,
        rawProperties: {
          ...existingRawProperties,
          routeGroupId,
          routeName: draft.name,
          routeSegmentCount: segments.length,
          routeSegmentIndex: segment.segmentIndex,
          routeSegmentName: name,
          routeSegmentFrom: segment.from,
          routeSegmentTo: segment.to,
          routeProvider: segment.provider,
          routeCosting: segment.costing,
          routeDistanceMeters: segment.distanceMeters,
          routeDurationSeconds: segment.durationSeconds,
          routeFallbackUsed: segment.fallbackUsed,
          routeWarnings: segment.warnings,
          routeStatus: segment.routeStatus,
          ...(segment.routeError ? { routeError: segment.routeError } : {}),
        },
      },
    };
  });
}

function createDrawnFeaturePayload(feature: Feature<Geometry>) {
  return {
    name:
      typeof feature.properties?.name === "string"
        ? feature.properties.name
        : undefined,
    description:
      typeof feature.properties?.description === "string"
        ? feature.properties.description
        : undefined,
    geometry: feature.geometry as Parameters<
      typeof createDrawnFeature
    >[1]["geometry"],
    rawProperties:
      feature.properties?.rawProperties &&
      typeof feature.properties.rawProperties === "object"
        ? feature.properties.rawProperties
        : undefined,
    style:
      feature.properties?.style && typeof feature.properties.style === "object"
        ? feature.properties.style
        : undefined,
  };
}

function buildCompletedFeature(
  tool: DraftSketchTool,
  coordinates: [number, number][],
) {
  if (tool === "line" && coordinates.length >= 2) {
    return {
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates,
      },
      properties: {},
    };
  }

  if (tool === "polygon" && coordinates.length >= 3) {
    return {
      type: "Feature" as const,
      geometry: {
        type: "Polygon" as const,
        coordinates: [[...coordinates, coordinates[0]]],
      },
      properties: {},
    };
  }

  return null;
}

function buildInProgressFeature(
  tool: DraftSketchTool,
  coordinates: [number, number][],
) {
  if (coordinates.length === 1) {
    return {
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: coordinates[0],
      },
      properties: {},
    };
  }

  if (tool === "line" && coordinates.length >= 2) {
    return {
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates,
      },
      properties: {},
    };
  }

  if (tool === "polygon" && coordinates.length >= 3) {
    return buildCompletedFeature(tool, coordinates);
  }

  if (tool === "polygon" && coordinates.length >= 2) {
    return {
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates,
      },
      properties: {},
    };
  }

  return null;
}

function App() {
  const queryClient = useQueryClient();
  const { logout, user } = useAuth();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [viewportBounds, setViewportBounds] =
    useState<MapViewportBounds | null>(null);
  const [debouncedViewportBounds, setDebouncedViewportBounds] =
    useState<MapViewportBounds | null>(null);
  const [requestedViewportBbox, setRequestedViewportBbox] = useState<
    string | null
  >(null);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const [selectedProvinceId, setSelectedProvinceId] = useState<string | null>(
    null,
  );
  const [pendingProvinceId, setPendingProvinceId] = useState<string | null>(
    null,
  );
  const [selectedFeature, setSelectedFeature] =
    useState<SelectedMapFeatureDetail | null>(null);
  const [selectedDrawnName, setSelectedDrawnName] = useState("");
  const [selectedDrawnLegendClassId, setSelectedDrawnLegendClassId] = useState<
    string | null
  >(null);
  const [mapFolderCheckedMaps, setMapFolderCheckedMaps] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const [mapFolderExpandedMaps, setMapFolderExpandedMaps] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const [pointTileCaches, setPointTileCaches] = useState<PointTileCaches>({});
  const [displayPointView, setDisplayPointView] =
    useState<DisplayPointView | null>(null);
  const [isPointQueueLoading, setIsPointQueueLoading] = useState(false);
  const [pointReloadVersion, setPointReloadVersion] = useState(0);
  const [savedPointOverlays, setSavedPointOverlays] = useState<
    ImportedPointTilePoint[]
  >([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activeTool, setActiveTool] = useState<WorkspaceTool>("pan");
  const [measurement, dispatchMeasurement] = useReducer(
    measurementReducer,
    initialMeasurementState,
  );
  const [clearVersion, setClearVersion] = useState(0);
  const [draftFeatures, setDraftFeatures] = useState<DraftFeatureRecord[]>([]);
  const [legendClasses, setLegendClasses] = useState(INITIAL_LEGEND_CLASSES);
  const [activeLegendClassId, setActiveLegendClassId] = useState<string | null>(
    INITIAL_LEGEND_CLASSES[0]?.id ?? null,
  );
  const [mapViewState, setMapViewState] = useState(INITIAL_VIEW_STATE);
  const [pointerCoordinates, setPointerCoordinates] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [streetViewLocation, setStreetViewLocation] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(
    null,
  );
  const draftSequenceRef = useRef<Record<DraftFeatureKind, number>>({
    node: 0,
    line: 0,
    polygon: 0,
  });
  const activeSketchDraftIdRef = useRef<string | null>(null);
  const routePreviewAbortRefs = useRef(new Map<string, AbortController>());
  const routePreviewSequenceRefs = useRef(new Map<string, number>());
  const measurementAbortRef = useRef<AbortController | null>(null);
  const measurementSequenceRef = useRef(0);
  const selectedProvinceIdRef = useRef<string | null>(null);
  const folderProvinceSuggestionAbortRef = useRef<AbortController | null>(null);
  const folderProvinceSuggestionSequenceRef = useRef(0);

  const clearMeasurement = useCallback(() => {
    measurementSequenceRef.current += 1;
    measurementAbortRef.current?.abort();
    measurementAbortRef.current = null;
    dispatchMeasurement({ type: "clear" });
  }, []);

  const abortFolderProvinceSuggestion = useCallback(() => {
    folderProvinceSuggestionSequenceRef.current += 1;
    folderProvinceSuggestionAbortRef.current?.abort();
    folderProvinceSuggestionAbortRef.current = null;
  }, []);

  useEffect(() => {
    selectedProvinceIdRef.current = selectedProvinceId;
  }, [selectedProvinceId]);

  const mapsQuery = useQuery({
    queryKey: ["maps"],
    queryFn: fetchMaps,
  });
  const mapTreeQuery = useQuery({
    queryKey: ["map-tree", selectedMapId],
    queryFn: () => fetchMapTree(selectedMapId!),
    enabled: Boolean(selectedMapId),
  });
  const mapUploadHistoryQuery = useQuery({
    queryKey: ["map-upload-history"],
    queryFn: fetchMapUploadHistory,
    enabled: user?.role === "admin",
  });
  const selectMap = useCallback(
    (mapId: string) => {
      if (!mapId) {
        return;
      }

      setSelectedMapId((current) => (current === mapId ? current : mapId));
      setSelectedProvinceId(null);
      setPendingProvinceId(null);
      setRequestedViewportBbox(null);
      setSelectedFeature(null);
      clearMeasurement();
      abortFolderProvinceSuggestion();
      setPointTileCaches({});
      setDisplayPointView(null);
      setPointReloadVersion((current) => current + 1);
    },
    [abortFolderProvinceSuggestion, clearMeasurement],
  );
  const selectProvince = useCallback(
    (provinceId: string | null) => {
      setSelectedProvinceId((current) =>
        current === provinceId ? current : provinceId,
      );
      setPendingProvinceId(provinceId);
      setRequestedViewportBbox(null);
      setSelectedFeature(null);
      clearMeasurement();
      abortFolderProvinceSuggestion();
    },
    [abortFolderProvinceSuggestion, clearMeasurement],
  );

  const uploadMapMutation = useMutation({
    mutationFn: (input: { file: File; autoRoute: boolean }) =>
      uploadMapSource(input.file, undefined, input.autoRoute),
    onMutate: (input) => {
      setUploadingFileName(input.file.name);
    },
    onSuccess: async (result, input) => {
      selectMap(result.map.id);
      if (result.suggestedProvince) {
        selectProvince(result.suggestedProvince.id);
      }
      await queryClient.invalidateQueries({ queryKey: ["maps"] });
      toast.success("Map imported", {
        description: input.autoRoute
          ? result.suggestedProvince
            ? `${input.file.name} - opening ${result.suggestedProvince.name}`
            : input.file.name
          : result.suggestedProvince
            ? `${input.file.name} - source geometry kept; opening ${result.suggestedProvince.name}`
            : `${input.file.name} - source geometry kept`,
      });
    },
    onError: (error) => {
      toast.error("Unable to import map file", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    },
    onSettled: () => {
      setUploadingFileName(null);
      void queryClient.invalidateQueries({ queryKey: ["map-upload-history"] });
    },
  });
  const deleteMapPackageMutation = useMutation({
    mutationFn: (mapId: string) => deleteMapPackage(mapId),
    onSuccess: async (result, deletedMapId) => {
      queryClient.removeQueries({ queryKey: ["map-tree", deletedMapId] });
      queryClient.removeQueries({ queryKey: ["map-features", deletedMapId] });

      const nextMaps = (
        queryClient.getQueryData<ImportedMapSummary[]>(["maps"]) ?? []
      ).filter((entry) => entry.id !== deletedMapId);
      queryClient.setQueryData<ImportedMapSummary[]>(["maps"], nextMaps);
      queryClient.setQueryData<MapUploadHistoryItem[]>(
        ["map-upload-history"],
        (current) => current?.filter((entry) => entry.id !== deletedMapId),
      );

      setMapFolderCheckedMaps((current) => {
        const next = { ...current };
        delete next[deletedMapId];
        return next;
      });
      setMapFolderExpandedMaps((current) => {
        const next = { ...current };
        delete next[deletedMapId];
        return next;
      });

      if (selectedMapId === deletedMapId) {
        const nextMap = findFirstMap(
          nextMaps.filter((entry) => entry.importStatus === "imported"),
        );

        if (nextMap) {
          selectMap(nextMap.id);
        } else {
          setSelectedMapId(null);
          setSelectedProvinceId(null);
          setPendingProvinceId(null);
          setRequestedViewportBbox(null);
          setSelectedFeature(null);
          clearMeasurement();
          abortFolderProvinceSuggestion();
          setPointTileCaches({});
          setDisplayPointView(null);
          setPointReloadVersion((current) => current + 1);
        }
      }

      toast.success("Map Package deleted", {
        description: result.deletedName,
      });

      void queryClient.invalidateQueries({ queryKey: ["maps"] });
      void queryClient.invalidateQueries({
        queryKey: ["map-upload-history"],
      });
    },
    onError: (error) => {
      toast.error("Unable to delete Map Package", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    },
  });
  const provincesQuery = useQuery({
    queryKey: ["provinces"],
    queryFn: fetchProvinces,
  });
  const createDrawnFeatureMutation = useMutation({
    mutationFn: ({
      mapId,
      feature,
    }: {
      draftId: string;
      feature: Feature<Geometry>;
      mapId: string;
    }) =>
      createDrawnFeature(mapId, createDrawnFeaturePayload(feature)),
    onSuccess: async (feature, { draftId, mapId }) => {
      setDraftFeatures((current) =>
        current.filter((draft) => draft.id !== draftId),
      );

      await queryClient.invalidateQueries({
        queryKey: ["map-features", mapId],
      });

      if (feature.geometry.type === "Point") {
        const savedPointOverlay = pointOverlayFromFeature(feature);
        if (savedPointOverlay) {
          setSavedPointOverlays((current) => [
            ...current.filter((point) => point.id !== savedPointOverlay.id),
            savedPointOverlay,
          ]);
        }
        setPointTileCaches({});
        setDisplayPointView(null);
        setPointReloadVersion((current) => current + 1);
      }

      toast.success("Feature saved", {
        description:
          typeof feature.properties?.name === "string"
            ? feature.properties.name
            : "The drawn feature is now stored in the backend.",
      });
    },
    onError: (error, { draftId }) => {
      setDraftFeatures((current) =>
        current.map((draft) =>
          draft.id === draftId
            ? {
                ...draft,
                isSaving: false,
              }
            : draft,
        ),
      );

      toast.error("Failed to save feature", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    },
  });
  const updateDrawnFeatureMutation = useMutation({
    mutationFn: ({
      featureId,
      mapId,
      payload,
    }: {
      featureId: string;
      mapId: string;
      payload: UpdateDrawnFeatureRequest;
    }) => updateDrawnFeature(mapId, featureId, payload),
    onSuccess: async (feature, { featureId, mapId }) => {
      await queryClient.invalidateQueries({
        queryKey: ["map-features", mapId],
      });

      if (feature.geometry.type === "Point") {
        const savedPointOverlay = pointOverlayFromFeature(feature);
        if (savedPointOverlay) {
          setSavedPointOverlays((current) => [
            ...current.filter((point) => point.id !== savedPointOverlay.id),
            savedPointOverlay,
          ]);
        }
        setPointTileCaches({});
        setDisplayPointView(null);
        setPointReloadVersion((current) => current + 1);
      }

      setSelectedFeature((current) => {
        if (current?.id !== featureId) {
          return current;
        }

        const rawProperties = feature.properties?.rawProperties;
        const legendClassId =
          rawProperties &&
          typeof rawProperties === "object" &&
          !Array.isArray(rawProperties) &&
          typeof rawProperties.legendClassId === "string"
            ? rawProperties.legendClassId
            : current.legendClassId;

        return {
          ...current,
          legendClassId,
          name:
            typeof feature.properties?.name === "string"
              ? feature.properties.name
              : current.name,
        };
      });
      toast.success("Feature updated");
    },
    onError: (error) => {
      toast.error("Failed to update feature", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    },
  });
  const deleteDrawnFeatureMutation = useMutation({
    mutationFn: ({
      featureId,
      geometryType,
      mapId,
    }: {
      featureId: string;
      geometryType: UpdateDrawnFeatureRequest["geometryType"];
      mapId: string;
    }) => deleteDrawnFeature(mapId, featureId, geometryType),
    onSuccess: async (result, { mapId }) => {
      await queryClient.invalidateQueries({
        queryKey: ["map-features", mapId],
      });

      setSavedPointOverlays((current) =>
        current.filter((point) => point.id !== result.deletedFeatureId),
      );
      setPointTileCaches({});
      setDisplayPointView(null);
      setPointReloadVersion((current) => current + 1);
      setSelectedFeature((current) =>
        current?.id === result.deletedFeatureId ? null : current,
      );
      toast.success("Feature deleted");
    },
    onError: (error) => {
      toast.error("Failed to delete feature", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    },
  });

  const availableMaps = useMemo(
    () =>
      mapsQuery.data?.filter((entry) => entry.importStatus === "imported") ??
      [],
    [mapsQuery.data],
  );
  useEffect(() => {
    if (selectedMapId || availableMaps.length === 0) {
      return;
    }

    const firstMap = findFirstMap(availableMaps);
    if (firstMap) {
      setSelectedMapId(firstMap.id);
    }
  }, [availableMaps, selectedMapId]);

  useEffect(() => {
    const routePreviewAbortControllers = routePreviewAbortRefs.current;
    const routePreviewSequences = routePreviewSequenceRefs.current;

    return () => {
      measurementAbortRef.current?.abort();
      measurementAbortRef.current = null;
      measurementSequenceRef.current += 1;
      folderProvinceSuggestionAbortRef.current?.abort();
      folderProvinceSuggestionAbortRef.current = null;
      folderProvinceSuggestionSequenceRef.current += 1;

      for (const controller of routePreviewAbortControllers.values()) {
        controller.abort();
      }

      routePreviewAbortControllers.clear();
      routePreviewSequences.clear();
    };
  }, [selectedMapId]);

  const mapTreeNodes = useMemo(
    () => mapTreeQuery.data?.tree ?? [],
    [mapTreeQuery.data?.tree],
  );
  const mapFolderCheckedMap = selectedMapId
    ? (mapFolderCheckedMaps[selectedMapId] ?? {})
    : {};
  const mapFolderExpandedMap = selectedMapId
    ? (mapFolderExpandedMaps[selectedMapId] ?? {})
    : {};
  const allMapFolderIds = useMemo(
    () => mapTreeNodes.flatMap(collectNodeIds),
    [mapTreeNodes],
  );

  useEffect(() => {
    if (!selectedMapId || !mapTreeQuery.data) {
      return;
    }

    setMapFolderCheckedMaps((current) => {
      const existing = current[selectedMapId];
      const next = buildTreeStateRecord(mapTreeNodes, existing, () => true);

      if (recordEqual(existing, next)) {
        return current;
      }

      return {
        ...current,
        [selectedMapId]: next,
      };
    });

    setMapFolderExpandedMaps((current) => {
      const existing = current[selectedMapId];
      const next = buildTreeStateRecord(
        mapTreeNodes,
        existing,
        (node) => node.isOpenByDefault || node.depth <= 1,
      );

      if (recordEqual(existing, next)) {
        return current;
      }

      return {
        ...current,
        [selectedMapId]: next,
      };
    });
  }, [mapTreeNodes, mapTreeQuery.data, selectedMapId]);

  useEffect(() => {
    if (viewportBounds === null) {
      setDebouncedViewportBounds(null);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setDebouncedViewportBounds(viewportBounds);
    }, VIEWPORT_BBOX_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [viewportBounds]);

  const debouncedViewportBbox = debouncedViewportBounds?.viewportBbox ?? null;
  const debouncedFetchBbox = debouncedViewportBounds?.fetchBbox ?? null;
  const requestedViewportKey = requestedViewportBbox ?? "";
  const selectedRenderableFolderIds = useMemo(() => {
    if (!selectedMapId || !mapTreeQuery.data) {
      return undefined;
    }

    if (
      mapTreeNodes.length > 0 &&
      Object.keys(mapFolderCheckedMap).length === 0
    ) {
      return undefined;
    }

    const selectedFolderIds = collectRenderableFolderIds(
      mapTreeNodes,
      mapFolderCheckedMap,
    );

    if (
      selectedFolderIds.length === allMapFolderIds.length &&
      allMapFolderIds.every(
        (folderId) => mapFolderCheckedMap[folderId] ?? false,
      )
    ) {
      return undefined;
    }

    return selectedFolderIds;
  }, [
    allMapFolderIds,
    mapFolderCheckedMap,
    mapTreeNodes,
    mapTreeQuery.data,
    selectedMapId,
  ]);
  const selectedRenderableFolderKey =
    selectedRenderableFolderIds === undefined
      ? "all"
      : selectedRenderableFolderIds.join(",");
  const hiddenFeatureIds = useMemo(
    () =>
      collectHiddenFeatureIds(
        mapTreeNodes,
        mapFolderCheckedMap,
        selectedRenderableFolderIds,
      ),
    [mapFolderCheckedMap, mapTreeNodes, selectedRenderableFolderIds],
  );
  const hiddenFolderIds = useMemo(
    () => collectHiddenFolderIds(mapTreeNodes, mapFolderCheckedMap),
    [mapFolderCheckedMap, mapTreeNodes],
  );
  const exportFolderFilter = useMemo(() => {
    if (selectedRenderableFolderIds === undefined) {
      return {
        folderIds: undefined,
        excludedFolderIds: undefined,
      };
    }

    if (
      hiddenFolderIds.length > 0 &&
      hiddenFolderIds.length < selectedRenderableFolderIds.length
    ) {
      return {
        folderIds: undefined,
        excludedFolderIds: hiddenFolderIds,
      };
    }

    return {
      folderIds: selectedRenderableFolderIds,
      excludedFolderIds: undefined,
    };
  }, [hiddenFolderIds, selectedRenderableFolderIds]);

  const exportKmlMutation = useMutation({
    mutationFn: async () => {
      if (!selectedMapId || !selectedProvinceId) {
        throw new Error("Select a map and province before exporting.");
      }

      await downloadMapKml(selectedMapId, {
        provinceId: selectedProvinceId,
        folderIds: exportFolderFilter.folderIds,
        excludedFolderIds: exportFolderFilter.excludedFolderIds,
        hiddenFeatureIds,
      });
    },
    onSuccess: () => {
      toast.success("KML export started");
    },
    onError: (error) => {
      toast.error("Unable to export KML", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    },
  });

  const exportCsvMutation = useMutation({
    mutationFn: async () => {
      if (!selectedMapId || !selectedProvinceId) {
        throw new Error("Select a map and province before exporting.");
      }

      await downloadMapCsv(selectedMapId, {
        provinceId: selectedProvinceId,
        folderIds: exportFolderFilter.folderIds,
        excludedFolderIds: exportFolderFilter.excludedFolderIds,
        hiddenFeatureIds,
      });
    },
    onSuccess: () => {
      toast.success("CSV export started");
    },
    onError: (error) => {
      toast.error("Unable to export CSV", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    },
  });

  useEffect(() => {
    if (!selectedProvinceId || !debouncedViewportBbox || !debouncedFetchBbox) {
      return;
    }

    setRequestedViewportBbox((current) =>
      current && bboxContains(current, debouncedViewportBbox)
        ? current
        : debouncedFetchBbox,
    );
  }, [debouncedFetchBbox, debouncedViewportBbox, selectedProvinceId]);

  const featuresQuery = useQuery({
    queryKey: [
      "map-features",
      selectedMapId,
      selectedProvinceId,
      requestedViewportKey,
      selectedRenderableFolderKey,
    ],
    queryFn: ({ signal }) =>
      fetchMapFeatures(selectedMapId!, {
        provinceId: selectedProvinceId!,
        bbox: requestedViewportBbox ?? undefined,
        folderIds: selectedRenderableFolderIds,
        limit: 12000,
        signal,
      }),
    enabled:
      Boolean(selectedMapId) &&
      Boolean(selectedProvinceId) &&
      Boolean(requestedViewportBbox),
    gcTime: VIEWPORT_QUERY_CACHE_MS,
    placeholderData: (previousData) => previousData,
  });

  const selectedProvince = useMemo(
    () =>
      provincesQuery.data?.features.find(
        (feature) => feature.properties.provinceId === selectedProvinceId,
      ) ?? null,
    [provincesQuery.data, selectedProvinceId],
  );
  const selectedProvinceBounds = useMemo(
    () => geometryBounds(selectedProvince?.geometry),
    [selectedProvince],
  );
  const canImportMaps = user?.role === "admin";
  const canUseStreetView = user?.role === "admin";
  const activeLegendClass = useMemo(
    () =>
      legendClasses.find((entry) => entry.id === activeLegendClassId) ??
      legendClasses[0] ??
      null,
    [activeLegendClassId, legendClasses],
  );

  useEffect(() => {
    if (!legendClasses.length) {
      if (activeLegendClassId !== null) {
        setActiveLegendClassId(null);
      }
      return;
    }

    if (
      !activeLegendClassId ||
      !legendClasses.some((entry) => entry.id === activeLegendClassId)
    ) {
      setActiveLegendClassId(legendClasses[0].id);
    }
  }, [activeLegendClassId, legendClasses]);

  useEffect(() => {
    setSelectedDrawnName(selectedFeature?.isDrawn ? selectedFeature.name : "");
    setSelectedDrawnLegendClassId(
      selectedFeature?.isDrawn
        ? (selectedFeature.legendClassId ?? activeLegendClass?.id ?? null)
        : null,
    );
  }, [activeLegendClass?.id, selectedFeature]);

  const visibleFeatureCollection: ImportedFeatureCollection = useMemo(() => {
    const collection = selectedProvinceId
      ? (featuresQuery.data ?? emptyImportedFeatureCollection())
      : emptyImportedFeatureCollection();

    if (hiddenFeatureIds.length === 0) {
      return collection;
    }

    const hidden = new Set(hiddenFeatureIds);

    return {
      ...collection,
      features: collection.features.filter((feature) => {
        const id =
          feature.id === undefined || feature.id === null
            ? null
            : String(feature.id);

        return !id || !hidden.has(id);
      }),
    };
  }, [featuresQuery.data, hiddenFeatureIds, selectedProvinceId]);
  const resolvedProvinceId = featuresQuery.data?.meta.provinceId ?? null;

  const isMapMoving = Boolean(
    selectedProvinceId &&
    viewportBounds &&
    debouncedViewportBounds &&
    (viewportBounds.fetchBbox !== debouncedViewportBounds.fetchBbox ||
      Math.abs(viewportBounds.zoom - debouncedViewportBounds.zoom) > 0.001),
  );

  const requestedPointState = useMemo<PointRenderState | null>(() => {
    if (
      !selectedProvinceId ||
      !debouncedViewportBounds?.viewportBbox ||
      !selectedProvinceBounds
    ) {
      return null;
    }

    return {
      mode:
        debouncedViewportBounds.zoom < POINT_CLUSTER_ZOOM_THRESHOLD
          ? "clusters"
          : "points",
      zoom: clampTileZoom(debouncedViewportBounds.zoom),
    };
  }, [debouncedViewportBounds, selectedProvinceBounds, selectedProvinceId]);

  const requestedPointScopeKey = pointStateScopeKey(
    requestedPointState,
    selectedRenderableFolderKey,
  );
  const debouncedViewportBoundsValue = useMemo(
    () => parseBbox(debouncedViewportBounds?.viewportBbox),
    [debouncedViewportBounds?.viewportBbox],
  );
  const requestedPointPlan = useMemo(() => {
    if (
      !requestedPointState ||
      !selectedProvinceBounds ||
      !debouncedViewportBoundsValue
    ) {
      return null;
    }

    return tileRangeFromBboxes(
      selectedProvinceBounds,
      debouncedViewportBoundsValue,
      requestedPointState.zoom,
      requestedPointState.mode === "clusters"
        ? {
            requestBufferTiles: CLUSTER_REQUEST_BUFFER_TILES,
            cacheBufferTiles: CLUSTER_CACHE_BUFFER_TILES,
          }
        : {
            requestBufferTiles: POINT_REQUEST_BUFFER_TILES,
            cacheBufferTiles: POINT_CACHE_BUFFER_TILES,
          },
    );
  }, [
    debouncedViewportBoundsValue,
    requestedPointState,
    selectedProvinceBounds,
  ]);

  const requestedOrderedTileKeys = requestedPointPlan?.orderedKeys ?? [];
  const requestedVisibleTileKeys = requestedPointPlan?.visibleKeys ?? [];
  const requestedCacheTileKeys = requestedPointPlan?.cacheKeys ?? [];
  const requestedPointCache = requestedPointScopeKey
    ? (pointTileCaches[requestedPointScopeKey] ?? {})
    : {};
  const requestedPointCacheRef = useRef(requestedPointCache);
  const requestedVisibleResolvedCount = requestedVisibleTileKeys.filter(
    (tileId) => {
      const status = requestedPointCache[tileId]?.status;
      return status === "loaded" || status === "error";
    },
  ).length;
  const requestedVisibleLoadedCount = requestedVisibleTileKeys.filter(
    (tileId) => requestedPointCache[tileId]?.status === "loaded",
  ).length;
  const requestedLoadedTileCount = requestedOrderedTileKeys.filter(
    (tileId) => requestedPointCache[tileId]?.status === "loaded",
  ).length;
  const requestedCachedTileCount = requestedCacheTileKeys.filter(
    (tileId) => requestedPointCache[tileId]?.status === "loaded",
  ).length;
  const requestedCachedPointCount = requestedCacheTileKeys.reduce(
    (total, tileId) => {
      const entry = requestedPointCache[tileId];
      return entry?.status === "loaded" ? total + entry.pointCount : total;
    },
    0,
  );
  const requestedVisibleReady =
    requestedVisibleTileKeys.length === 0 ||
    requestedVisibleResolvedCount === requestedVisibleTileKeys.length;
  const requestedTilePlanSignature = requestedOrderedTileKeys.join("|");
  const requestedCacheTileSignature = requestedCacheTileKeys.join("|");
  const requestedVisibleTileSignature = requestedVisibleTileKeys.join("|");

  useEffect(() => {
    setPointTileCaches({});
    setDisplayPointView(null);
    setIsPointQueueLoading(false);
    setSavedPointOverlays([]);
  }, [selectedMapId, selectedProvinceId]);

  useEffect(() => {
    setDisplayPointView(null);
  }, [selectedRenderableFolderKey]);

  useEffect(() => {
    requestedPointCacheRef.current = requestedPointCache;
  }, [requestedPointCache]);

  const displayPointState = displayPointView?.state ?? null;
  const displayPointScopeKey = displayPointView?.scopeKey ?? null;
  const displayTileKeys = displayPointView?.tileKeys ?? [];
  const displayTileKeySignature = displayTileKeys.join("|");

  useEffect(() => {
    const keepTilesByState = new Map<string, Set<string>>();

    if (requestedPointScopeKey) {
      keepTilesByState.set(
        requestedPointScopeKey,
        new Set(requestedCacheTileKeys),
      );
    }

    if (displayPointScopeKey) {
      const keepTiles =
        keepTilesByState.get(displayPointScopeKey) ?? new Set<string>();
      for (const tileId of displayTileKeys) {
        keepTiles.add(tileId);
      }
      keepTilesByState.set(displayPointScopeKey, keepTiles);
    }

    setPointTileCaches((current) => {
      const currentKeys = Object.keys(current);
      if (currentKeys.length === 0) {
        return current;
      }

      if (keepTilesByState.size === 0) {
        return {};
      }

      let changed = false;
      const nextCache: PointTileCaches = {};

      for (const [stateKey, stateCache] of Object.entries(current)) {
        const keepTiles = keepTilesByState.get(stateKey);
        if (!keepTiles) {
          changed = true;
          continue;
        }

        const stateEntries = Object.entries(stateCache);
        const filteredEntries = stateEntries.filter(([tileId]) =>
          keepTiles.has(tileId),
        );

        if (filteredEntries.length !== stateEntries.length) {
          changed = true;
        }

        nextCache[stateKey] =
          filteredEntries.length === stateEntries.length
            ? stateCache
            : Object.fromEntries(filteredEntries);
      }

      return changed ? nextCache : current;
    });
  }, [
    displayTileKeys,
    displayPointScopeKey,
    displayTileKeySignature,
    requestedCacheTileKeys,
    requestedCacheTileSignature,
    requestedPointScopeKey,
  ]);

  useEffect(() => {
    if (!requestedPointState || !requestedVisibleReady) {
      return;
    }

    setDisplayPointView((current) => {
      if (
        current &&
        current.scopeKey === requestedPointScopeKey &&
        pointStateEquals(current.state, requestedPointState) &&
        tileKeysEqual(current.tileKeys, requestedVisibleTileKeys)
      ) {
        return current;
      }

      return {
        scopeKey: requestedPointScopeKey!,
        state: requestedPointState,
        tileKeys: requestedVisibleTileKeys,
      };
    });
  }, [
    requestedPointScopeKey,
    requestedPointState,
    requestedVisibleReady,
    requestedVisibleTileKeys,
    requestedVisibleTileSignature,
  ]);

  useEffect(() => {
    if (
      !selectedMapId ||
      !selectedProvinceId ||
      !requestedPointState ||
      !requestedPointScopeKey ||
      !requestedTilePlanSignature ||
      isMapMoving
    ) {
      setIsPointQueueLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    let cursor = 0;
    let activeCount = 0;
    const missingTileKeys = requestedOrderedTileKeys.filter((tileId) => {
      const status = requestedPointCacheRef.current[tileId]?.status;
      return status !== "loaded";
    });

    if (missingTileKeys.length === 0) {
      setIsPointQueueLoading(false);
      return () => controller.abort();
    }

    const upsertTileEntry = (
      tileId: string,
      updater: (
        current: LoadedPointTileEntry | undefined,
      ) => LoadedPointTileEntry,
    ) => {
      setPointTileCaches((current) => {
        const stateKey = requestedPointScopeKey;
        const stateCache = current[stateKey] ?? {};
        return {
          ...current,
          [stateKey]: {
            ...stateCache,
            [tileId]: updater(stateCache[tileId]),
          },
        };
      });
    };

    const loadNext = () => {
      if (cancelled) {
        return;
      }

      while (
        activeCount < POINT_TILE_QUEUE_CONCURRENCY &&
        cursor < missingTileKeys.length
      ) {
        const tileId = missingTileKeys[cursor];
        cursor += 1;
        activeCount += 1;

        upsertTileEntry(
          tileId,
          (current) => current ?? createEmptyTileEntry("loading"),
        );

        const { x, y } = decodeTileKey(tileId);
        const request =
          requestedPointState.mode === "clusters"
            ? fetchPointClusterTile(
                selectedMapId,
                selectedProvinceId,
                requestedPointState.zoom,
                x,
                y,
                selectedRenderableFolderIds,
                controller.signal,
              )
            : fetchPointTile(
                selectedMapId,
                selectedProvinceId,
                requestedPointState.zoom,
                x,
                y,
                selectedRenderableFolderIds,
                controller.signal,
              );

        request
          .then((response) => {
            if (cancelled) {
              return;
            }

            upsertTileEntry(tileId, () => ({
              status: "loaded",
              pointCount: response.meta.pointCount,
              points: "points" in response ? response.points : [],
              clusters: "clusters" in response ? response.clusters : [],
            }));
          })
          .catch((error: unknown) => {
            if (
              cancelled ||
              (error instanceof DOMException && error.name === "AbortError")
            ) {
              return;
            }

            upsertTileEntry(tileId, (current) => ({
              ...(current ?? createEmptyTileEntry("error")),
              status: "error",
            }));
          })
          .finally(() => {
            if (cancelled) {
              return;
            }

            activeCount -= 1;
            if (cursor >= missingTileKeys.length && activeCount === 0) {
              setIsPointQueueLoading(false);
              return;
            }

            loadNext();
          });
      }
    };

    setIsPointQueueLoading(true);
    loadNext();

    return () => {
      cancelled = true;
      controller.abort();
      setIsPointQueueLoading(false);
    };
  }, [
    isMapMoving,
    pointReloadVersion,
    requestedOrderedTileKeys,
    requestedPointScopeKey,
    requestedPointState,
    requestedTilePlanSignature,
    selectedMapId,
    selectedRenderableFolderIds,
    selectedProvinceId,
  ]);

  const displayPointCache = displayPointScopeKey
    ? (pointTileCaches[displayPointScopeKey] ?? {})
    : {};
  const displayTileEntries = useMemo(
    () =>
      displayTileKeys.reduce<LoadedPointTileEntry[]>((entries, tileId) => {
        const entry = displayPointCache[tileId];

        if (entry?.status === "loaded") {
          entries.push(entry);
        }

        return entries;
      }, []),
    [displayPointCache, displayTileKeys],
  );
  const renderedPoints = useMemo(
    () =>
      displayPointState?.mode === "points"
        ? dedupeRenderedPoints(
            displayTileEntries.flatMap((entry) => entry.points),
          )
        : [],
    [displayPointState, displayTileEntries],
  );
  const renderedClusters = useMemo(
    () =>
      displayPointState?.mode === "clusters"
        ? displayTileEntries.flatMap((entry) => entry.clusters)
        : [],
    [displayPointState, displayTileEntries],
  );
  const cachedPointCoverage = useMemo(
    () => requestedCachedPointCount,
    [requestedCachedPointCount],
  );

  const pointLoadProgress: PointLoadProgress | null =
    selectedProvinceId && requestedPointState
      ? {
          mode: requestedPointState.mode,
          zoom: requestedPointState.zoom,
          cachedPoints: requestedCachedPointCount,
          cachedTiles: requestedCachedTileCount,
          loadedTiles: requestedLoadedTileCount,
          totalTiles: requestedOrderedTileKeys.length,
          visibleLoadedTiles: requestedVisibleLoadedCount,
          visibleTiles: requestedVisibleTileKeys.length,
          isLoading: !isMapMoving && isPointQueueLoading,
          isPaused:
            isMapMoving &&
            requestedLoadedTileCount < requestedOrderedTileKeys.length,
        }
      : null;

  const hasFeatureRequestTarget = Boolean(
    selectedMapId && selectedProvinceId && requestedViewportBbox,
  );
  const isProvinceSwitchLoading = Boolean(
    pendingProvinceId &&
    selectedProvinceId &&
    (pendingProvinceId !== resolvedProvinceId ||
      !requestedVisibleReady ||
      featuresQuery.isFetching),
  );
  const isViewportBusy =
    isProvinceSwitchLoading ||
    (hasFeatureRequestTarget &&
      (requestedViewportKey !== (featuresQuery.data?.meta.bbox ?? "") ||
        resolvedProvinceId !== selectedProvinceId ||
        featuresQuery.isFetching)) ||
    Boolean(pointLoadProgress?.isLoading);
  const coordinateReadout = pointerCoordinates ?? {
    lat: mapViewState.latitude,
    lng: mapViewState.longitude,
  };
  const measurementOverlay = useMemo<MeasurementOverlay | null>(() => {
    if (measurement.points.length === 0) {
      return null;
    }

    return {
      isRouting: measurement.isRouting,
      points: measurement.points,
      routeCoordinates: measurement.routeCoordinates,
      routingUnavailable: measurement.routingUnavailable,
    };
  }, [measurement]);

  const handleViewportBoundsChange = useCallback(
    (nextViewport: MapViewportBounds) => {
      setViewportBounds((current) =>
        current?.viewportBbox === nextViewport.viewportBbox &&
        current?.fetchBbox === nextViewport.fetchBbox &&
        Math.abs((current?.zoom ?? 0) - nextViewport.zoom) < 0.001
          ? current
          : nextViewport,
      );
    },
    [],
  );

  const handleProvinceSelect = useCallback(
    (provinceId: string | null) => {
      selectProvince(provinceId);
    },
    [selectProvince],
  );

  const clearProvinceSelection = useCallback(() => {
    setSelectedProvinceId(null);
    setPendingProvinceId(null);
    setRequestedViewportBbox(null);
    setSelectedFeature(null);
  }, []);

  useEffect(() => {
    if (!pendingProvinceId) {
      return;
    }

    if (!selectedProvinceId) {
      setPendingProvinceId(null);
      return;
    }

    if (featuresQuery.isError && !featuresQuery.isFetching) {
      setPendingProvinceId(null);
      return;
    }

    if (
      resolvedProvinceId === pendingProvinceId &&
      !featuresQuery.isFetching &&
      requestedVisibleReady
    ) {
      setPendingProvinceId(null);
    }
  }, [
    featuresQuery.isError,
    featuresQuery.isFetching,
    pendingProvinceId,
    requestedVisibleReady,
    resolvedProvinceId,
    selectedProvinceId,
  ]);
  useEffect(() => {
    if (isDesktop) {
      setIsSidebarOpen(true);
    }
  }, [isDesktop]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        isEditableTarget(event.target) ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === "q") {
        setActiveTool("pan");
        return;
      }

      if (key === "w") {
        setActiveTool("placemark");
        return;
      }

      if (key === "e") {
        setActiveTool("polygon");
        return;
      }

      if (key === "r") {
        setActiveTool("line");
        return;
      }

      if (key === "m") {
        setSelectedFeature(null);
        setActiveTool("measure");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    activeSketchDraftIdRef.current = null;
  }, [activeTool]);

  const handleLogout = useCallback(async () => {
    await logout();
  }, [logout]);

  const handleToolSelect = useCallback((tool: WorkspaceTool) => {
    if (tool === "measure") {
      setSelectedFeature(null);
    }

    setActiveTool(tool);
  }, []);

  const handleClearDrawings = useCallback(() => {
    for (const controller of routePreviewAbortRefs.current.values()) {
      controller.abort();
    }

    measurementAbortRef.current?.abort();
    measurementAbortRef.current = null;
    measurementSequenceRef.current += 1;
    abortFolderProvinceSuggestion();
    routePreviewAbortRefs.current.clear();
    routePreviewSequenceRefs.current.clear();
    activeSketchDraftIdRef.current = null;
    dispatchMeasurement({ type: "clear" });
    setDraftFeatures([]);
    setSelectedFeature(null);
    setPointTileCaches({});
    setDisplayPointView(null);
    setPointReloadVersion((current) => current + 1);
    setClearVersion((current) => current + 1);
    setActiveTool("pan");
  }, [abortFolderProvinceSuggestion]);

  const handleClearMeasurement = useCallback(() => {
    clearMeasurement();
  }, [clearMeasurement]);

  const handleMeasurePointSelect = useCallback(
    (point: LngLat) => {
      if (!selectedMapId || !selectedProvinceId) {
        toast.error("Select a province before measuring.");
        return;
      }

      const startPoint =
        measurement.points.length === 1 && !measurement.isRouting
          ? measurement.points[0]
          : null;

      if (!startPoint) {
        measurementAbortRef.current?.abort();
        measurementAbortRef.current = null;
        dispatchMeasurement({ type: "place-point", point });
        return;
      }

      const points: [LngLat, LngLat] = [startPoint, point];
      measurementAbortRef.current?.abort();
      const controller = new AbortController();
      const sequence = measurementSequenceRef.current + 1;
      measurementSequenceRef.current = sequence;
      measurementAbortRef.current = controller;
      dispatchMeasurement({ type: "route-pending", points });

      void previewRoute(selectedMapId, {
        points,
        signal: controller.signal,
      })
        .then((route) => {
          if (measurementSequenceRef.current !== sequence) {
            return;
          }

          measurementAbortRef.current = null;
          dispatchMeasurement({
            type: "route-success",
            distanceMeters: route.distanceMeters,
            durationSeconds: Number.isFinite(route.durationSeconds)
              ? route.durationSeconds
              : null,
            fallbackUsed: route.fallbackUsed,
            geometry: route.geometry,
            warnings: route.warnings,
          });
        })
        .catch((error) => {
          if (controller.signal.aborted) {
            return;
          }

          if (measurementSequenceRef.current !== sequence) {
            return;
          }

          measurementAbortRef.current = null;
          dispatchMeasurement({
            type: "route-failure",
            distanceMeters: straightLineDistanceMeters(points[0], points[1]),
            error:
              error instanceof Error ? error.message : "Route preview failed.",
            points,
          });
        });
    },
    [
      measurement.isRouting,
      measurement.points,
      selectedMapId,
      selectedProvinceId,
    ],
  );

  const handleUpdateSelectedDrawnFeature = useCallback(async () => {
    if (!selectedMapId || !selectedFeature?.isDrawn) {
      return;
    }

    const kind = draftKindForGeometry(selectedFeature.geometryType);
    if (!kind) {
      toast.error("This drawn feature type cannot be edited yet.");
      return;
    }

    const legendClass =
      legendClasses.find((entry) => entry.id === selectedDrawnLegendClassId) ??
      activeLegendClass;

    if (!legendClass) {
      toast.error("Select a drawing class before updating.");
      return;
    }

    const name = selectedDrawnName.trim() || selectedFeature.name;

    await updateDrawnFeatureMutation.mutateAsync({
      featureId: selectedFeature.id,
      mapId: selectedMapId,
      payload: {
        geometryType:
          selectedFeature.geometryType as UpdateDrawnFeatureRequest["geometryType"],
        name,
        style: legendStyleFor(kind, legendClass),
        rawProperties: {
          source: "drawn",
          legendClassId: legendClass.id,
          legendClassName: legendClass.name,
          legendColor: legendClass.color,
        },
      },
    });
  }, [
    activeLegendClass,
    legendClasses,
    selectedDrawnLegendClassId,
    selectedDrawnName,
    selectedFeature,
    selectedMapId,
    updateDrawnFeatureMutation,
  ]);

  const handleDeleteSelectedDrawnFeature = useCallback(async () => {
    if (!selectedMapId || !selectedFeature?.isDrawn) {
      return;
    }

    const kind = draftKindForGeometry(selectedFeature.geometryType);
    if (!kind) {
      toast.error("This drawn feature type cannot be deleted yet.");
      return;
    }

    await deleteDrawnFeatureMutation.mutateAsync({
      featureId: selectedFeature.id,
      geometryType:
        selectedFeature.geometryType as UpdateDrawnFeatureRequest["geometryType"],
      mapId: selectedMapId,
    });
  }, [deleteDrawnFeatureMutation, selectedFeature, selectedMapId]);

  const handleDraftPointCreate = useCallback(
    (feature: Feature<Geometry>) => {
      if (!activeLegendClass) {
        return;
      }

      draftSequenceRef.current.node += 1;
      const draftId = `node-${draftSequenceRef.current.node}`;
      const draftName = draftLabel("node", draftSequenceRef.current.node);

      setDraftFeatures((current) => [
        ...current,
        {
          id: draftId,
          kind: "node",
          legendClassId: activeLegendClass.id,
          name: draftName,
          feature: applyLegendClassToFeature(
            feature,
            "node",
            draftName,
            activeLegendClass,
          ),
          isComplete: true,
          isEditingName: false,
          isSaved: false,
          isSaving: false,
        },
      ]);
    },
    [activeLegendClass],
  );

  const requestRoutePreview = useCallback(
    (draftId: string, coordinates: [number, number][], isComplete: boolean) => {
      if (!selectedMapId || coordinates.length < 2) {
        return;
      }

      routePreviewAbortRefs.current.get(draftId)?.abort();
      const controller = new AbortController();
      routePreviewAbortRefs.current.set(draftId, controller);
      const sequence = (routePreviewSequenceRefs.current.get(draftId) ?? 0) + 1;
      routePreviewSequenceRefs.current.set(draftId, sequence);

      setDraftFeatures((current) =>
        current.map((draft) =>
          draft.id === draftId
            ? {
                ...draft,
                isComplete: false,
                routeError: undefined,
                isRouting: true,
              }
            : draft,
        ),
      );

      void previewRoute(selectedMapId, {
        points: coordinates,
        signal: controller.signal,
      })
        .then((route) => {
          if (routePreviewSequenceRefs.current.get(draftId) !== sequence) {
            return;
          }

          routePreviewAbortRefs.current.delete(draftId);

          setDraftFeatures((current) =>
            current.map((draft) => {
              if (
                draft.id !== draftId ||
                draft.feature.geometry.type !== "LineString"
              ) {
                return draft;
              }

              const rawProperties =
                draft.feature.properties?.rawProperties &&
                typeof draft.feature.properties.rawProperties === "object"
                  ? draft.feature.properties.rawProperties
                  : {};

              return {
                ...draft,
                feature: {
                  ...draft.feature,
                  geometry: route.geometry,
                  properties: {
                    ...draft.feature.properties,
                    rawProperties: {
                      ...rawProperties,
                      routeProvider: route.provider,
                      routeCosting: route.costing,
                      routeDistanceMeters: route.distanceMeters,
                      routeDurationSeconds: route.durationSeconds,
                      routeFallbackUsed: route.fallbackUsed,
                      routeWarnings: route.warnings,
                      routeSegmentCount: route.segments.length,
                    },
                  },
                },
                isComplete,
                routeSegments: route.segments,
                routeError: undefined,
                isRouting: false,
              };
            }),
          );

          if (isComplete && route.warnings.length > 0) {
            toast.warning("Auto route preview has warning", {
              description: route.warnings[0],
            });
          }
        })
        .catch((error) => {
          if (controller.signal.aborted) {
            return;
          }

          routePreviewAbortRefs.current.delete(draftId);

          setDraftFeatures((current) =>
            current.map((draft) =>
              draft.id === draftId
                ? {
                    ...draft,
                    isComplete: false,
                    routeError:
                      error instanceof Error
                        ? error.message
                        : "Auto route preview failed.",
                    isRouting: false,
                  }
                : draft,
            ),
          );

          if (isComplete) {
            toast.error("Auto route failed", {
              description:
                error instanceof Error
                  ? error.message
                  : "Straight draft remains available.",
            });
          }
        });
    },
    [selectedMapId],
  );

  const handleDraftSketchChange = useCallback(
    (
      tool: DraftSketchTool,
      coordinates: [number, number][],
      isComplete: boolean,
    ) => {
      if (!activeLegendClass) {
        return false;
      }

      const kind: DraftFeatureKind = tool === "line" ? "line" : "polygon";
      const geometryFeature = isComplete
        ? buildCompletedFeature(tool, coordinates)
        : buildInProgressFeature(tool, coordinates);

      if (!geometryFeature) {
        return false;
      }

      const shouldAutoRoute =
        tool === "line" && coordinates.length >= 2 && Boolean(selectedMapId);
      const activeDraftId = activeSketchDraftIdRef.current;
      let draftId = activeDraftId;
      let draftName = "";

      if (!draftId) {
        draftSequenceRef.current[kind] += 1;
        draftId = `${kind}-${draftSequenceRef.current[kind]}`;
        activeSketchDraftIdRef.current = draftId;
        draftName = draftLabel(kind, draftSequenceRef.current[kind]);
      }

      setDraftFeatures((current) => {
        if (activeDraftId) {
          return current.map((draft) =>
            draft.id === activeDraftId
              ? (() => {
                  const draftLegendClass =
                    legendClasses.find(
                      (entry) => entry.id === draft.legendClassId,
                    ) ?? activeLegendClass;

                  return {
                    ...draft,
                    feature: applyLegendClassToFeature(
                      {
                        ...geometryFeature,
                        id: draft.feature.id,
                        properties: {
                          ...geometryFeature.properties,
                          description:
                            typeof draft.feature.properties?.description ===
                            "string"
                              ? draft.feature.properties.description
                              : undefined,
                        },
                      },
                      kind,
                      draft.name,
                      draftLegendClass,
                    ),
                    isComplete: shouldAutoRoute ? false : isComplete,
                    routeError: undefined,
                    routeSegments: undefined,
                    isRouting: shouldAutoRoute,
                  };
                })()
              : draft,
          );
        }

        return [
          ...current,
          {
            id: draftId,
            kind,
            legendClassId: activeLegendClass.id,
            name: draftName,
            feature: applyLegendClassToFeature(
              geometryFeature,
              kind,
              draftName,
              activeLegendClass,
            ),
            isComplete: shouldAutoRoute ? false : isComplete,
            isEditingName: false,
            routeError: undefined,
            isRouting: shouldAutoRoute,
            isSaved: false,
            isSaving: false,
          },
        ];
      });

      if (shouldAutoRoute) {
        requestRoutePreview(draftId, coordinates, isComplete);
      }

      if (isComplete) {
        activeSketchDraftIdRef.current = null;
      }

      return true;
    },
    [activeLegendClass, legendClasses, requestRoutePreview, selectedMapId],
  );

  const handleDraftNameChange = useCallback((draftId: string, name: string) => {
    setDraftFeatures((current) =>
      current.map((draft) =>
        draft.id === draftId
          ? {
              ...draft,
              name,
              feature: {
                ...draft.feature,
                properties: {
                  ...draft.feature.properties,
                  name,
                },
              },
            }
          : draft,
      ),
    );
  }, []);

  const handleStartDraftEditing = useCallback((draftId: string) => {
    setDraftFeatures((current) =>
      current.map((draft) =>
        draft.isSaved || draft.isSaving
          ? draft
          : draft.id === draftId
            ? {
                ...draft,
                isEditingName: true,
              }
            : {
                ...draft,
                isEditingName: false,
              },
      ),
    );
  }, []);

  const handleCommitDraftName = useCallback((draftId: string) => {
    setDraftFeatures((current) =>
      current.map((draft) =>
        draft.id === draftId
          ? {
              ...normalizeDraftRecord(draft),
              isEditingName: false,
            }
          : draft,
      ),
    );
  }, []);

  const handleDeleteDraft = useCallback((draftId: string) => {
    if (activeSketchDraftIdRef.current === draftId) {
      activeSketchDraftIdRef.current = null;
    }

    routePreviewAbortRefs.current.get(draftId)?.abort();
    routePreviewAbortRefs.current.delete(draftId);
    routePreviewSequenceRefs.current.delete(draftId);

    setDraftFeatures((current) =>
      current.filter((draft) => draft.id !== draftId),
    );
  }, []);

  const handleSaveDraft = useCallback(
    async (draftId: string) => {
      const draft = draftFeatures.find((entry) => entry.id === draftId);

      if (!draft || draft.isSaved || draft.isSaving || !draft.isComplete) {
        return;
      }

      if (!selectedMapId) {
        toast.error("Select an imported map before saving drafts.");
        return;
      }

      const normalizedDraft = normalizeDraftRecord(draft);
      const draftForSave = {
        ...normalizedDraft,
        feature: {
          ...normalizedDraft.feature,
          properties: {
            ...normalizedDraft.feature.properties,
            name: normalizedDraft.name,
          },
        },
      };

      setDraftFeatures((current) =>
        current.map((entry) =>
          entry.id === draftId
            ? {
                ...normalizeDraftRecord(entry),
                isSaving: true,
                isEditingName: false,
              }
            : entry,
        ),
      );

      if (draftForSave.feature.geometry.type === "LineString") {
        try {
          const routeGroupId =
            typeof globalThis.crypto?.randomUUID === "function"
              ? globalThis.crypto.randomUUID()
              : `${selectedMapId}:${draftId}:${Date.now()}`;
          const segmentFeatures = segmentizedRouteFeatures(
            draftForSave,
            routeGroupId,
          );

          const createdSegments: Array<{
            geometryType: UpdateDrawnFeatureRequest["geometryType"];
            id: string;
          }> = [];

          try {
            for (const feature of segmentFeatures) {
              const createdFeature = await createDrawnFeature(
                selectedMapId,
                createDrawnFeaturePayload(feature),
              );

              createdSegments.push({
                geometryType: createdFeature.geometry.type,
                id: String(createdFeature.id),
              });
            }
          } catch (error) {
            await Promise.allSettled(
              createdSegments.map((feature) =>
                deleteDrawnFeature(
                  selectedMapId,
                  feature.id,
                  feature.geometryType,
                ),
              ),
            );
            throw error;
          }

          setDraftFeatures((current) =>
            current.filter((entry) => entry.id !== draftId),
          );

          await queryClient.invalidateQueries({
            queryKey: ["map-features", selectedMapId],
          });

          toast.success("Route saved", {
            description:
              segmentFeatures.length > 1
                ? `${segmentFeatures.length} Route Segments are now stored.`
                : "The Route Segment is now stored.",
          });
        } catch (error) {
          setDraftFeatures((current) =>
            current.map((entry) =>
              entry.id === draftId
                ? {
                    ...entry,
                    isSaving: false,
                  }
                : entry,
            ),
          );

          toast.error("Failed to save route", {
            description:
              error instanceof Error ? error.message : "Please try again.",
          });
        }

        return;
      }

      await createDrawnFeatureMutation.mutateAsync({
        draftId,
        mapId: selectedMapId,
        feature: draftForSave.feature,
      });
    },
    [createDrawnFeatureMutation, draftFeatures, queryClient, selectedMapId],
  );

  const handleToggleClassVisibility = useCallback((layerId: string) => {
    setLegendClasses((current) =>
      current.map((layer) =>
        layer.id === layerId ? { ...layer, visible: !layer.visible } : layer,
      ),
    );
  }, []);

  const handleChangeClassColor = useCallback(
    (layerId: string, color: string) => {
      setLegendClasses((current) => {
        const nextClasses = current.map((layer) =>
          layer.id === layerId ? { ...layer, color } : layer,
        );
        const updatedLegendClass = nextClasses.find(
          (layer) => layer.id === layerId,
        );

        if (updatedLegendClass) {
          setDraftFeatures((drafts) =>
            drafts.map((draft) =>
              draft.legendClassId === updatedLegendClass.id
                ? {
                    ...draft,
                    feature: applyLegendClassToFeature(
                      draft.feature,
                      draft.kind,
                      draft.name,
                      updatedLegendClass,
                    ),
                  }
                : draft,
            ),
          );
        }

        return nextClasses;
      });
    },
    [],
  );

  const handleToggleMapFolderChecked = useCallback(
    (node: MapTreeNode, nextChecked: boolean) => {
      if (!selectedMapId) {
        return;
      }

      const affectedCheckIds = collectTreeCheckIds(node);
      const affectedFolderIds = collectNodeIds(node);
      const nextMapState = { ...mapFolderCheckedMap };

      for (const treeId of affectedCheckIds) {
        nextMapState[treeId] = nextChecked;
      }

      const nextSelectedFolderIds = collectRenderableFolderIds(
        mapTreeNodes,
        nextMapState,
      );

      setMapFolderCheckedMaps((current) => {
        return {
          ...current,
          [selectedMapId]: nextMapState,
        };
      });

      if (nextSelectedFolderIds.length === 0 || affectedFolderIds.length === 0) {
        return;
      }

      folderProvinceSuggestionAbortRef.current?.abort();
      const controller = new AbortController();
      const sequence = folderProvinceSuggestionSequenceRef.current + 1;
      folderProvinceSuggestionSequenceRef.current = sequence;
      folderProvinceSuggestionAbortRef.current = controller;

      void suggestMapProvince(
        selectedMapId,
        affectedFolderIds,
        controller.signal,
      )
        .then((suggestedProvince) => {
          if (folderProvinceSuggestionSequenceRef.current !== sequence) {
            return;
          }

          folderProvinceSuggestionAbortRef.current = null;
          if (
            !suggestedProvince ||
            selectedProvinceIdRef.current === suggestedProvince.id
          ) {
            return;
          }

          selectProvince(suggestedProvince.id);
          toast.success("Province selected", {
            description: `Opening ${suggestedProvince.name} for ${node.name}.`,
          });
        })
        .catch((error) => {
          if (controller.signal.aborted) {
            return;
          }

          if (folderProvinceSuggestionSequenceRef.current !== sequence) {
            return;
          }

          folderProvinceSuggestionAbortRef.current = null;
          toast.error("Unable to select province", {
            description:
              error instanceof Error
                ? error.message
                : "Please select one manually.",
          });
        });
    },
    [mapFolderCheckedMap, mapTreeNodes, selectProvince, selectedMapId],
  );

  const handleToggleMapFeatureChecked = useCallback(
    (feature: MapTreeFeature, nextChecked: boolean) => {
      if (!selectedMapId) {
        return;
      }

      setMapFolderCheckedMaps((current) => ({
        ...current,
        [selectedMapId]: {
          ...(current[selectedMapId] ?? mapFolderCheckedMap),
          [featureTreeKey(feature.id)]: nextChecked,
        },
      }));
    },
    [mapFolderCheckedMap, selectedMapId],
  );

  const handleToggleMapFolderExpanded = useCallback(
    (nodeId: string) => {
      if (!selectedMapId) {
        return;
      }

      setMapFolderExpandedMaps((current) => {
        const currentMapState = current[selectedMapId] ?? {};
        return {
          ...current,
          [selectedMapId]: {
            ...currentMapState,
            [nodeId]: !currentMapState[nodeId],
          },
        };
      });
    },
    [selectedMapId],
  );

  const handleZoom = useCallback((delta: number) => {
    setMapViewState((current) => ({
      ...current,
      zoom: Math.min(20, Math.max(2, current.zoom + delta)),
    }));
  }, []);

  const handlePitchToggle = useCallback(() => {
    setMapViewState((current) => ({
      ...current,
      pitch: (current.pitch ?? 0) >= 55 ? 0 : (current.pitch ?? 0) + 20,
    }));
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-100 text-slate-900">
      <AppNavbar
        activeTool={activeTool}
        currentUser={user}
        onSignOut={() => void handleLogout()}
        onClear={handleClearDrawings}
        onToggleSidebar={() => setIsSidebarOpen((current) => !current)}
        onToolSelect={handleToolSelect}
      />

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <LegendSidebar
          activeLegendClassId={activeLegendClassId}
          canImportMaps={canImportMaps}
          dataFolders={mapTreeNodes}
          dataFoldersError={
            mapTreeQuery.isError
              ? mapTreeQuery.error instanceof Error
                ? mapTreeQuery.error.message
                : "Unable to load imported folders."
              : null
          }
          dataFoldersLoading={mapTreeQuery.isLoading}
          draftFeatures={draftFeatures}
          importingFileName={uploadingFileName}
          importPending={uploadMapMutation.isPending}
          isOpen={isSidebarOpen}
          legendClasses={legendClasses}
          mapUploadHistory={mapUploadHistoryQuery.data ?? []}
          mapUploadHistoryError={
            mapUploadHistoryQuery.isError
              ? mapUploadHistoryQuery.error instanceof Error
                ? mapUploadHistoryQuery.error.message
                : "Unable to load upload history."
              : null
          }
          mapUploadHistoryLoading={mapUploadHistoryQuery.isLoading}
          mapFolderCheckedMap={mapFolderCheckedMap}
          mapFolderExpandedMap={mapFolderExpandedMap}
          maps={availableMaps}
          selectedMapId={selectedMapId}
          deletingMapPackageId={
            deleteMapPackageMutation.isPending
              ? (deleteMapPackageMutation.variables ?? null)
              : null
          }
          onChangeDraftName={handleDraftNameChange}
          onChangeClassColor={handleChangeClassColor}
          onCommitDraftName={handleCommitDraftName}
          onDeleteMapPackage={(mapId) =>
            deleteMapPackageMutation.mutate(mapId)
          }
          onDeleteDraft={handleDeleteDraft}
          onImportFile={(file, autoRoute) =>
            uploadMapMutation.mutate({ file, autoRoute })
          }
          onSaveDraft={handleSaveDraft}
          onSelectMap={selectMap}
          onSelectActiveLegendClass={setActiveLegendClassId}
          onStartDraftEditing={handleStartDraftEditing}
          onToggleClassVisibility={handleToggleClassVisibility}
          onToggleMapFolderChecked={handleToggleMapFolderChecked}
          onToggleMapFeatureChecked={handleToggleMapFeatureChecked}
          onToggleMapFolderExpanded={handleToggleMapFolderExpanded}
        />

        <main className="relative min-w-0 flex-1 bg-slate-200">
          {!isSidebarOpen ? (
            <Button
              variant="outline"
              className="absolute left-4 top-4 z-20 rounded-2xl border-slate-200 bg-white/95 text-slate-700 shadow-sm hover:bg-white"
              onClick={() => setIsSidebarOpen(true)}
            >
              <Menu className="size-4" />
              Layers
            </Button>
          ) : null}

          <DeckMapView
            activeTool={activeTool}
            clusterData={renderedClusters}
            clearVersion={clearVersion}
            controlledViewState={mapViewState}
            draftFeatures={draftFeatures}
            featureCollection={visibleFeatureCollection}
            isProvinceLoading={isProvinceSwitchLoading}
            isViewportLoading={isViewportBusy}
            loadingProvinceName={selectedProvince?.properties.name ?? null}
            measurementOverlay={measurementOverlay}
            onDraftPointCreate={handleDraftPointCreate}
            onDraftSketchChange={handleDraftSketchChange}
            onFeatureSelect={setSelectedFeature}
            onMapViewStateChange={setMapViewState}
            onMeasurePointSelect={handleMeasurePointSelect}
            onPointerMove={setPointerCoordinates}
            onStreetViewDrop={
              canUseStreetView ? setStreetViewLocation : undefined
            }
            onProvinceSelect={handleProvinceSelect}
            onViewportBoundsChange={handleViewportBoundsChange}
            pointData={renderedPoints}
            pointLoadProgress={pointLoadProgress}
            pointRenderState={displayPointState}
            provinceCollection={provincesQuery.data ?? null}
            renderedPointCoverage={cachedPointCoverage}
            savedPointOverlays={savedPointOverlays}
            selectedPointId={
              selectedFeature?.geometryType === "Point"
                ? selectedFeature.id
                : null
            }
            selectedProvinceId={selectedProvinceId}
            selectedProvinceName={selectedProvince?.properties.name ?? null}
            showChrome={false}
          />

          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white/45 to-transparent" />

          <div className="absolute left-4 top-4 z-20 w-[min(calc(100vw-32px),260px)] overflow-hidden rounded-2xl border border-white/70 bg-white/88 shadow-[0_18px_42px_-26px_rgba(15,23,42,0.58)] backdrop-blur-xl">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/95" />
            <div className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  Province
                </p>
                <p className="truncate text-[0.95rem] font-semibold tracking-tight text-slate-950">
                  {selectedProvince?.properties.name ?? "Choose a province"}
                </p>
              </div>
              {selectedProvince ? (
                <div className="flex shrink-0 items-center gap-1.5 border-l border-slate-200/80 pl-3">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="outline"
                          size="icon-sm"
                          className="h-8 w-8 rounded-xl border-slate-200/80 bg-white/82 text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.86)] transition-[background-color,border-color,transform,color] duration-200 hover:border-slate-300 hover:bg-white hover:text-slate-950 active:scale-[0.96]"
                          onClick={() => exportKmlMutation.mutate()}
                          disabled={
                            !selectedMapId || exportKmlMutation.isPending
                          }
                          aria-label={
                            exportKmlMutation.isPending
                              ? "Exporting KML"
                              : "Export KML"
                          }
                        />
                      }
                    >
                      <Download className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Export KML</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="outline"
                          size="icon-sm"
                          className="h-8 w-8 rounded-xl border-slate-200/80 bg-white/82 text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.86)] transition-[background-color,border-color,transform,color] duration-200 hover:border-slate-300 hover:bg-white hover:text-slate-950 active:scale-[0.96]"
                          onClick={() => exportCsvMutation.mutate()}
                          disabled={
                            !selectedMapId || exportCsvMutation.isPending
                          }
                          aria-label={
                            exportCsvMutation.isPending
                              ? "Exporting CSV"
                              : "Export CSV"
                          }
                        />
                      }
                    >
                      <FileSpreadsheet className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Export CSV</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="h-8 w-8 rounded-xl text-slate-500 transition-[background-color,transform,color] duration-200 hover:bg-slate-100 hover:text-slate-950 active:scale-[0.96]"
                          onClick={clearProvinceSelection}
                          aria-label="Exit province"
                        />
                      }
                    >
                      <X className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Exit province</TooltipContent>
                  </Tooltip>
                </div>
              ) : null}
            </div>
          </div>

          {activeTool === "measure" ? (
            <div className="absolute bottom-10 left-4 z-20 w-[min(340px,calc(100vw-32px))] rounded-2xl border border-slate-200 bg-white/95 px-4 py-4 shadow-lg backdrop-blur">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                    Measure
                  </p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {!selectedProvince
                      ? "Choose a province"
                      : measurement.points.length === 0
                        ? "Click start point"
                        : measurement.points.length === 1
                          ? "Click destination"
                          : measurement.isRouting
                            ? "Routing..."
                            : "Route measured"}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                  onClick={handleClearMeasurement}
                  aria-label="Clear measurement"
                  disabled={
                    measurement.points.length === 0 && !measurement.isRouting
                  }
                >
                  <X className="size-4" />
                </Button>
              </div>

              {measurement.distanceMeters !== null ? (
                <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                      Distance
                    </span>
                    <span className="text-xl font-semibold tracking-tight text-slate-950">
                      {formatMetricDistance(measurement.distanceMeters)}
                    </span>
                  </div>
                  {formatDuration(measurement.durationSeconds) ? (
                    <div className="mt-2 flex items-baseline justify-between gap-3 text-sm">
                      <span className="font-medium text-slate-500">
                        Duration
                      </span>
                      <span className="font-semibold text-slate-800">
                        {formatDuration(measurement.durationSeconds)}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {measurement.routingUnavailable ? (
                <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                  Routing unavailable. Showing straight-line fallback.
                </p>
              ) : null}

              {measurement.error ? (
                <p className="mt-2 text-xs text-slate-500">
                  {measurement.error}
                </p>
              ) : null}

              {measurement.warnings.length > 0 ? (
                <div className="mt-3 space-y-1">
                  {measurement.warnings.map((warning, index) => (
                    <p
                      key={`measurement-warning-${index}`}
                      className="text-xs font-medium text-amber-700"
                    >
                      {warning}
                    </p>
                  ))}
                </div>
              ) : null}

              <Button
                variant="outline"
                size="sm"
                className="mt-3 w-full rounded-xl border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                onClick={handleClearMeasurement}
                disabled={
                  measurement.points.length === 0 && !measurement.isRouting
                }
              >
                Clear
              </Button>
            </div>
          ) : null}

          {selectedFeature?.isDrawn ? (
            <div className="absolute bottom-10 left-4 z-20 w-[min(360px,calc(100vw-32px))] rounded-2xl border border-slate-200 bg-white/95 px-4 py-4 shadow-lg backdrop-blur">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                    Drawn feature
                  </p>
                  <p className="mt-1 truncate text-sm font-semibold text-slate-900">
                    {selectedFeature.geometryType}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                  onClick={() => setSelectedFeature(null)}
                  aria-label="Close drawn feature editor"
                >
                  X
                </Button>
              </div>

              <div className="mt-3 grid gap-3">
                <Input
                  value={selectedDrawnName}
                  onChange={(event) =>
                    setSelectedDrawnName(event.currentTarget.value)
                  }
                  className="h-10 rounded-xl border-slate-200 bg-white text-slate-900"
                  aria-label="Drawn feature name"
                />

                <select
                  value={selectedDrawnLegendClassId ?? ""}
                  onChange={(event) =>
                    setSelectedDrawnLegendClassId(event.currentTarget.value)
                  }
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 shadow-sm outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                  aria-label="Drawn feature class"
                >
                  {legendClasses.map((layer) => (
                    <option key={`selected-drawn-${layer.id}`} value={layer.id}>
                      {layer.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-4 flex items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl border-rose-200 bg-white text-rose-700 hover:bg-rose-50"
                  onClick={() => void handleDeleteSelectedDrawnFeature()}
                  disabled={deleteDrawnFeatureMutation.isPending}
                >
                  <Trash2 className="size-4" />
                  Delete
                </Button>
                <Button
                  size="sm"
                  className="rounded-xl bg-slate-900 text-white hover:bg-slate-800"
                  onClick={() => void handleUpdateSelectedDrawnFeature()}
                  disabled={updateDrawnFeatureMutation.isPending}
                >
                  <Save className="size-4" />
                  Save
                </Button>
              </div>
            </div>
          ) : null}

          <div className="absolute right-4 top-4 z-20 flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-sm backdrop-blur">
            <Button
              variant="ghost"
              size="icon"
              className="rounded-none text-slate-700 hover:bg-slate-100"
              onClick={() => handleZoom(1)}
              aria-label="Zoom in"
            >
              <Plus className="size-4" />
            </Button>
            <div className="h-px bg-slate-200" />
            <Button
              variant="ghost"
              size="icon"
              className="rounded-none text-slate-700 hover:bg-slate-100"
              onClick={() => handleZoom(-1)}
              aria-label="Zoom out"
            >
              <Minus className="size-4" />
            </Button>
            <div className="h-px bg-slate-200" />
            <Button
              variant="ghost"
              size="icon"
              className="rounded-none text-slate-700 hover:bg-slate-100"
              onClick={() =>
                setMapViewState((current) => ({
                  ...current,
                  bearing: 0,
                }))
              }
              aria-label="Reset bearing"
            >
              <Compass className="size-4" />
            </Button>
            <div className="h-px bg-slate-200" />
            <Button
              variant="ghost"
              size="icon"
              className="rounded-none text-slate-700 hover:bg-slate-100"
              onClick={handlePitchToggle}
              aria-label="Adjust pitch"
            >
              <ArrowUp className="size-4" />
            </Button>
            {canUseStreetView ? (
              <>
                <div className="h-px bg-slate-200" />
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-none text-amber-600 hover:bg-amber-50 hover:text-amber-700"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      "application/x-geospatial-tool",
                      "street-view",
                    );
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => {
                    toast.info("Drag the person onto the map", {
                      description:
                        "Drop it on a road to search for nearby Street View imagery.",
                    });
                  }}
                  aria-label="Drag Street View person"
                  title="Drag Street View person onto the map"
                >
                  <UserRound className="size-4" />
                </Button>
              </>
            ) : null}
          </div>

          {canUseStreetView && streetViewLocation ? (
            <StreetViewPanel
              apiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY}
              location={streetViewLocation}
              onClose={() => setStreetViewLocation(null)}
            />
          ) : null}
        </main>
      </div>

      <footer className="flex h-7 items-center gap-4 border-t border-slate-200 bg-white/95 px-4 text-[11px] text-slate-500 sm:px-6">
        <span className="font-medium text-slate-400">elev: 0m</span>
        <span className="font-medium text-slate-400">
          eye alt: {eyeAltitudeFromZoom(mapViewState.zoom)}
        </span>
        <span className="font-medium text-slate-400">
          lat: {coordinateReadout.lat.toFixed(5)}
        </span>
        <span className="font-medium text-slate-400">
          lon: {coordinateReadout.lng.toFixed(5)}
        </span>
      </footer>
    </div>
  );
}

export default App;
