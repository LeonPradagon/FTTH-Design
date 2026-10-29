import type { Feature, Geometry } from "geojson";
import type {
  ImportedMapSummary,
  MapTreeFeature,
  MapTreeNode,
  MapUploadHistoryItem,
  PreviewRouteSegment,
  SessionUser,
} from "../../lib/api";

export type WorkspaceTool = "pan" | "placemark" | "line" | "polygon" | "measure";
export type DraftFeatureKind = "node" | "line" | "polygon";

export type DraftFeatureRecord = {
  feature: Feature<Geometry>;
  id: string;
  isComplete: boolean;
  isEditingName: boolean;
  routeError?: string;
  routeSegments?: PreviewRouteSegment[];
  isRouting?: boolean;
  isSaved: boolean;
  isSaving: boolean;
  kind: DraftFeatureKind;
  legendClassId: string;
  name: string;
};

export type LegendClassItem = {
  color: string;
  description: string;
  id: string;
  name: string;
  visible: boolean;
};

export type AppNavbarProps = {
  activeTool: WorkspaceTool;
  currentUser?: SessionUser | null;
  onSignOut: () => void;
  onClear: () => void;
  onToggleSidebar: () => void;
  onToolSelect: (tool: WorkspaceTool) => void;
};

export type LegendSidebarProps = {
  activeLegendClassId: string | null;
  canImportMaps: boolean;
  dataFolders: MapTreeNode[];
  dataFoldersError: string | null;
  dataFoldersLoading: boolean;
  draftFeatures: DraftFeatureRecord[];
  importingFileName: string | null;
  importPending: boolean;
  isOpen: boolean;
  legendClasses: LegendClassItem[];
  mapUploadHistory: MapUploadHistoryItem[];
  mapUploadHistoryError: string | null;
  mapUploadHistoryLoading: boolean;
  mapFolderCheckedMap: Record<string, boolean>;
  mapFolderExpandedMap: Record<string, boolean>;
  maps: ImportedMapSummary[];
  selectedMapId: string | null;
  deletingMapPackageId: string | null;
  onChangeDraftName: (draftId: string, name: string) => void;
  onChangeClassColor: (layerId: string, color: string) => void;
  onCommitDraftName: (draftId: string) => void;
  onDeleteMapPackage: (mapId: string) => void;
  onDeleteDraft: (draftId: string) => void;
  onImportFile: (file: File, autoRoute: boolean) => void;
  onSaveDraft: (draftId: string) => void;
  onSelectMap: (mapId: string) => void;
  onSelectActiveLegendClass: (layerId: string) => void;
  onStartDraftEditing: (draftId: string) => void;
  onToggleClassVisibility: (layerId: string) => void;
  onToggleMapFolderChecked: (node: MapTreeNode, nextChecked: boolean) => void;
  onToggleMapFeatureChecked: (feature: MapTreeFeature, nextChecked: boolean) => void;
  onToggleMapFolderExpanded: (nodeId: string) => void;
};
