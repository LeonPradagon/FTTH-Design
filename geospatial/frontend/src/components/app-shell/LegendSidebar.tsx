import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import {
  Check,
  FileText,
  History,
  LoaderCircle,
  PencilLine,
  Save,
  SwatchBook,
  Trash2,
  Upload,
  UploadCloud,
  Waypoints,
  X,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { VisibilityTree } from "../VisibilityTree";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import type { LegendSidebarProps } from "./types";

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** unitIndex;

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatUploadTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatUploader(name: string | null, email: string | null) {
  if (name && email) {
    return `${name} (${email})`;
  }

  return name || email || "System import";
}

export function LegendSidebar({
  activeLegendClassId,
  canImportMaps,
  dataFolders,
  dataFoldersError,
  dataFoldersLoading,
  draftFeatures,
  importingFileName,
  importPending,
  isOpen,
  legendClasses,
  mapUploadHistory,
  mapUploadHistoryError,
  mapUploadHistoryLoading,
  mapFolderCheckedMap,
  mapFolderExpandedMap,
  maps,
  selectedMapId,
  deletingMapPackageId,
  onChangeDraftName,
  onChangeClassColor,
  onCommitDraftName,
  onDeleteMapPackage,
  onDeleteDraft,
  onImportFile,
  onSaveDraft,
  onSelectMap,
  onSelectActiveLegendClass,
  onStartDraftEditing,
  onToggleClassVisibility,
  onToggleMapFolderChecked,
  onToggleMapFeatureChecked,
  onToggleMapFolderExpanded,
}: LegendSidebarProps) {
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<
    string | null
  >(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [selectedImportFile, setSelectedImportFile] = useState<File | null>(
    null,
  );
  const [autoRouteImportedLines, setAutoRouteImportedLines] = useState(true);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function isKmlFile(file: File) {
    return (
      file.name.toLowerCase().endsWith(".kml") ||
      file.type === "application/vnd.google-earth.kml+xml"
    );
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setSelectedImportFile(event.currentTarget.files?.[0] ?? null);
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function handleRemoveFile() {
    setSelectedImportFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleFileDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDraggingFile(false);
    if (importPending) {
      return;
    }

    const droppedFile = event.dataTransfer.files?.[0];
    if (droppedFile && isKmlFile(droppedFile)) {
      setSelectedImportFile(droppedFile);
    }
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (!importPending) {
      setIsDraggingFile(true);
    }
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDraggingFile(false);
  }

  function resetImportDialog() {
    setSelectedImportFile(null);
    setAutoRouteImportedLines(true);
    setIsDraggingFile(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleImportDialogOpenChange(open: boolean) {
    setImportDialogOpen(open);
    if (!open) {
      resetImportDialog();
    }
  }

  function handleImportSubmit() {
    if (!selectedImportFile) {
      return;
    }

    onImportFile(selectedImportFile, autoRouteImportedLines);
    setImportDialogOpen(false);
    resetImportDialog();
  }

  return (
    <aside
      className={cn(
        "absolute inset-y-0 left-0 z-30 w-[min(380px,calc(100vw-24px))] shrink-0 border-r border-slate-200 bg-white shadow-[0_14px_40px_rgba(15,23,42,0.08)] transition-transform duration-200 lg:static lg:z-0 lg:w-[360px] lg:shadow-none",
        isOpen ? "translate-x-0" : "-translate-x-full lg:hidden",
      )}
    >
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-4 sm:px-4 lg:pt-6">
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="inline-flex size-9 items-center justify-center rounded-xl bg-white text-slate-600 shadow-sm">
                <SwatchBook className="size-4" />
              </div>
              <div className="text-left">
                <p className="text-sm font-semibold text-slate-900">
                  Map Classes
                </p>
              </div>
            </div>

            <div className="space-y-2 px-2 pb-3 sm:px-3">
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      Map Package
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Choose which imported KML tree is active.
                    </p>
                  </div>
                  {canImportMaps ? (
                    <Dialog>
                      <DialogTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0 rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                            aria-label="View upload history"
                            title="Upload history"
                          />
                        }
                      >
                        <History className="size-4" />
                      </DialogTrigger>

                      <DialogContent className="grid max-h-[min(720px,calc(100vh-2rem))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-3xl border border-slate-200 bg-white p-0 shadow-[0_24px_80px_rgba(15,23,42,0.14)] sm:max-w-3xl">
                        <DialogHeader className="border-b border-slate-200 px-5 pb-4 pt-5">
                          <DialogTitle className="text-lg font-semibold text-slate-900">
                            Upload History
                          </DialogTitle>
                          <DialogDescription className="text-sm text-slate-500">
                            Recent KML map package imports and uploader details.
                          </DialogDescription>
                        </DialogHeader>

                        <div className="min-h-0 overflow-y-auto px-5 py-4">
                          {mapUploadHistoryLoading ? (
                            <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                              <LoaderCircle className="size-4 animate-spin" />
                              Loading history
                            </div>
                          ) : mapUploadHistoryError ? (
                            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                              {mapUploadHistoryError}
                            </div>
                          ) : mapUploadHistory.length === 0 ? (
                            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                              No uploads yet.
                            </div>
                          ) : (
                            <div className="space-y-3">
                              {mapUploadHistory.map((entry) => (
                                <div
                                  key={entry.id}
                                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
                                >
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <p className="truncate text-sm font-semibold text-slate-900">
                                        {entry.name}
                                      </p>
                                      <p className="mt-1 truncate text-xs text-slate-500">
                                        {entry.originalFilename} -{" "}
                                        {formatFileSize(entry.fileSizeBytes)}
                                      </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                      <span
                                        className={cn(
                                          "rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize",
                                          entry.importStatus === "imported"
                                            ? "bg-emerald-50 text-emerald-700"
                                            : entry.importStatus === "failed"
                                              ? "bg-rose-50 text-rose-700"
                                              : "bg-sky-50 text-sky-700",
                                        )}
                                      >
                                        {entry.importStatus}
                                      </span>

                                      <AlertDialog
                                        open={deleteConfirmationId === entry.id}
                                        onOpenChange={(open) =>
                                          setDeleteConfirmationId(
                                            open ? entry.id : null,
                                          )
                                        }
                                      >
                                        <AlertDialogTrigger
                                          render={
                                            <Button
                                              variant="ghost"
                                              size="icon-sm"
                                              className="rounded-xl text-slate-400 hover:bg-rose-50 hover:text-rose-700"
                                              aria-label={`Delete ${entry.name}`}
                                              disabled={
                                                deletingMapPackageId ===
                                                entry.id
                                              }
                                            />
                                          }
                                        >
                                          {deletingMapPackageId === entry.id ? (
                                            <LoaderCircle className="size-4 animate-spin" />
                                          ) : (
                                            <Trash2 className="size-4" />
                                          )}
                                        </AlertDialogTrigger>

                                        <AlertDialogContent className="overflow-hidden rounded-3xl border border-rose-100 bg-white p-0 shadow-[0_24px_80px_rgba(127,29,29,0.16)]">
                                          <AlertDialogHeader className="px-6 pb-5 pt-6">
                                            <AlertDialogTitle className="text-lg font-semibold text-slate-900">
                                              Delete Map Package?
                                            </AlertDialogTitle>
                                            <AlertDialogDescription className="text-sm leading-6 text-slate-500">
                                              {entry.name} will be removed with
                                              its imported folders, features,
                                              nodes, and drawn features. This
                                              cannot be undone.
                                            </AlertDialogDescription>
                                          </AlertDialogHeader>

                                          <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-white px-6 pb-6 pt-0">
                                            <AlertDialogCancel className="h-10 rounded-xl border-slate-200 bg-white px-4 text-slate-700 hover:bg-slate-100">
                                              Cancel
                                            </AlertDialogCancel>
                                            <AlertDialogAction
                                              className="h-10 rounded-xl bg-rose-600 px-4 text-white hover:bg-rose-700"
                                              onClick={() => {
                                                onDeleteMapPackage(entry.id);
                                                setDeleteConfirmationId(null);
                                              }}
                                            >
                                              Delete Map Package
                                            </AlertDialogAction>
                                          </AlertDialogFooter>
                                        </AlertDialogContent>
                                      </AlertDialog>
                                    </div>
                                  </div>

                                  <div className="mt-3 grid gap-2 text-xs text-slate-500 sm:grid-cols-2">
                                    <p>
                                      Uploaded by{" "}
                                      <span className="font-medium text-slate-700">
                                        {formatUploader(
                                          entry.uploadedByName,
                                          entry.uploadedByEmail,
                                        )}
                                      </span>
                                    </p>
                                    <p className="sm:text-right">
                                      {formatUploadTime(entry.createdAt)}
                                    </p>
                                  </div>

                                  <div className="mt-3 grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
                                    {[
                                      ["Folders", entry.folderCount],
                                      ["Features", entry.featureCount],
                                      ["Points", entry.pointCount],
                                      ["Lines", entry.lineStringCount],
                                      ["Polygons", entry.polygonCount],
                                      ["Nodes", entry.nodeCount],
                                    ].map(([label, value]) => (
                                      <div
                                        key={label}
                                        className="rounded-xl bg-slate-50 px-2 py-2"
                                      >
                                        <p className="text-sm font-semibold text-slate-900">
                                          {value}
                                        </p>
                                        <p className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-400">
                                          {label}
                                        </p>
                                      </div>
                                    ))}
                                  </div>

                                  {entry.importError ? (
                                    <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">
                                      {entry.importError}
                                    </p>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </DialogContent>
                    </Dialog>
                  ) : null}
                </div>

                <select
                  value={selectedMapId ?? ""}
                  onChange={(event) => onSelectMap(event.currentTarget.value)}
                  disabled={maps.length === 0 || importPending}
                  className="mt-3 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 shadow-sm outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
                  aria-label="Select imported map package"
                >
                  {maps.length === 0 ? (
                    <option value="">No imported maps</option>
                  ) : (
                    maps.map((map) => (
                      <option key={map.id} value={map.id}>
                        {map.name}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white px-3 py-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    Data Folders
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Toggle imported KML folders the same way you would in Google
                    Earth.
                  </p>
                </div>

                <div className="mt-3">
                  {dataFoldersLoading ? (
                    <p className="tree-empty">Loading imported folders...</p>
                  ) : dataFoldersError ? (
                    <p className="tree-empty">{dataFoldersError}</p>
                  ) : (
                    <VisibilityTree
                      nodes={dataFolders}
                      checkedMap={mapFolderCheckedMap}
                      expandedMap={mapFolderExpandedMap}
                      onToggleChecked={onToggleMapFolderChecked}
                      onToggleFeatureChecked={onToggleMapFeatureChecked}
                      onToggleExpanded={onToggleMapFolderExpanded}
                    />
                  )}
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white px-3 py-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    Drawing Class
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    New node, line, and polygon drafts use this legend and
                    color.
                  </p>
                </div>

                <div className="mt-3 grid gap-2">
                  {legendClasses.map((layer) => {
                    const isActive = layer.id === activeLegendClassId;

                    return (
                      <button
                        key={`drawing-class-${layer.id}`}
                        type="button"
                        onClick={() => onSelectActiveLegendClass(layer.id)}
                        className={cn(
                          "flex items-center justify-between rounded-2xl border px-3 py-2 text-left transition",
                          isActive
                            ? "border-sky-300 bg-sky-50 shadow-[inset_0_0_0_1px_rgba(14,165,233,0.12)]"
                            : "border-slate-200 bg-slate-50 hover:border-slate-300 hover:bg-slate-100",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className="size-3 rounded-full border border-white/70 shadow-sm"
                            style={{ backgroundColor: layer.color }}
                          />
                          <span className="truncate text-sm font-medium text-slate-900">
                            {layer.name}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                            isActive
                              ? "bg-sky-100 text-sky-700"
                              : "bg-white text-slate-500",
                          )}
                        >
                          {isActive ? "Active" : "Use"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-slate-900">
                    Drafted Items
                  </p>
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    {draftFeatures.length}
                  </span>
                </div>

                {draftFeatures.length === 0 ? (
                  <p className="mt-3 text-sm text-slate-500">
                    No local drafts yet.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {draftFeatures.map((draft) => {
                      const legendClass =
                        legendClasses.find(
                          (layer) => layer.id === draft.legendClassId,
                        ) ?? null;

                      return (
                        <div
                          key={draft.id}
                          className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3"
                        >
                          <div className="flex items-center gap-2">
                            <Input
                              value={draft.name}
                              autoFocus={
                                draft.isEditingName &&
                                !draft.isSaved &&
                                !draft.isSaving &&
                                !draft.isRouting
                              }
                              readOnly={
                                !draft.isEditingName ||
                                draft.isSaved ||
                                draft.isSaving ||
                                draft.isRouting
                              }
                              onChange={(event) =>
                                onChangeDraftName(
                                  draft.id,
                                  event.currentTarget.value,
                                )
                              }
                              onBlur={() => {
                                if (draft.isEditingName) {
                                  onCommitDraftName(draft.id);
                                }
                              }}
                              onKeyDown={(event) => {
                                if (
                                  event.key === "Enter" ||
                                  event.key === "Escape"
                                ) {
                                  event.preventDefault();
                                  onCommitDraftName(draft.id);
                                }
                              }}
                              className={cn(
                                "h-9 rounded-xl border-slate-200 bg-white text-slate-900 placeholder:text-slate-400",
                                !(
                                  draft.isEditingName &&
                                  !draft.isSaved &&
                                  !draft.isSaving &&
                                  !draft.isRouting
                                ) && "cursor-default",
                              )}
                            />
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40"
                              onMouseDown={(event) => {
                                if (draft.isEditingName) {
                                  event.preventDefault();
                                }
                              }}
                              onClick={() =>
                                draft.isEditingName
                                  ? onCommitDraftName(draft.id)
                                  : onStartDraftEditing(draft.id)
                              }
                              disabled={
                                draft.isSaved ||
                                draft.isSaving ||
                                draft.isRouting
                              }
                              aria-label={
                                draft.isEditingName
                                  ? `Confirm ${draft.name}`
                                  : `Rename ${draft.name}`
                              }
                              title={
                                draft.isEditingName ? "Confirm name" : "Rename"
                              }
                            >
                              {draft.isEditingName ? (
                                <Check className="size-4" />
                              ) : (
                                <PencilLine className="size-4" />
                              )}
                            </Button>
                          </div>

                          <div className="mt-2 flex items-center justify-between gap-3">
                            <div className="flex flex-wrap items-center gap-2">
                              {legendClass ? (
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700">
                                  <span
                                    className="size-2 rounded-full"
                                    style={{
                                      backgroundColor: legendClass.color,
                                    }}
                                  />
                                  {legendClass.name}
                                </span>
                              ) : null}

                              <span
                                className={cn(
                                  "rounded-full border px-2.5 py-1 text-[11px] font-medium",
                                  draft.isRouting
                                    ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                                    : draft.isSaved
                                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                      : draft.routeError
                                        ? "border-rose-200 bg-rose-50 text-rose-700"
                                      : draft.isComplete
                                        ? "border-sky-200 bg-sky-50 text-sky-700"
                                        : "border-amber-200 bg-amber-50 text-amber-700",
                                )}
                              >
                                {draft.isRouting
                                  ? "Routing"
                                  : draft.isSaved
                                    ? "Saved"
                                    : draft.routeError
                                      ? "Route failed"
                                    : draft.isComplete
                                      ? "Ready to save"
                                      : "Drafting"}
                              </span>
                            </div>

                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="rounded-xl text-rose-500 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-40"
                              onClick={() => onDeleteDraft(draft.id)}
                              disabled={draft.isSaving}
                              aria-label={`Delete ${draft.name}`}
                              title="Delete"
                            >
                              <Trash2 className="size-4" />
                            </Button>

                            <Button
                              variant="outline"
                              size="sm"
                              className="rounded-xl border-slate-200 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                              onClick={() => onSaveDraft(draft.id)}
                              disabled={
                                !draft.isComplete ||
                                draft.isSaved ||
                                draft.isSaving ||
                                draft.isRouting
                              }
                            >
                              {draft.isSaving || draft.isRouting ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : (
                                <Save className="size-4" />
                              )}
                              {draft.isRouting
                                ? "Routing"
                                : draft.isSaving
                                  ? "Saving"
                                  : "Save"}
                            </Button>
                          </div>
                          {draft.routeError ? (
                            <p className="mt-2 text-xs leading-5 text-rose-600">
                              {draft.routeError}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-2 px-2 pb-3 sm:px-3">
              {legendClasses.map((layer) => (
                <div
                  key={layer.id}
                  className={cn(
                    "rounded-2xl border bg-white px-3 py-3",
                    layer.id === activeLegendClassId
                      ? "border-sky-200"
                      : "border-slate-200",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className="size-2.5 rounded-full"
                          style={{ backgroundColor: layer.color }}
                        />
                        <p className="truncate text-sm font-semibold text-slate-900">
                          {layer.name}
                        </p>
                      </div>
                      <p className="mt-1 text-sm text-slate-500">
                        {layer.description}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => onToggleClassVisibility(layer.id)}
                      className={cn(
                        "inline-flex rounded-full border px-2.5 py-1 text-[11px] font-medium transition",
                        layer.visible
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-slate-200 bg-slate-50 text-slate-500",
                      )}
                    >
                      {layer.visible ? "Visible" : "Hidden"}
                    </button>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      Color
                    </span>
                    <input
                      type="color"
                      value={layer.color}
                      onChange={(event) =>
                        onChangeClassColor(layer.id, event.currentTarget.value)
                      }
                      className="h-9 w-11 cursor-pointer rounded-xl border border-slate-200 bg-white p-1"
                      aria-label={`Change ${layer.name} color`}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="space-y-3 border-t border-slate-200 px-4 py-4">
          {canImportMaps ? (
            <div className="rounded-2xl border border-slate-200 bg-white px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    Admin Import
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Upload a KML package to add a new map workspace.
                  </p>
                </div>
                <Dialog
                  open={importDialogOpen}
                  onOpenChange={handleImportDialogOpenChange}
                >
                  <DialogTrigger
                    render={
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-xl border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
                        disabled={importPending}
                      />
                    }
                  >
                    {importPending ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <Upload className="size-4" />
                    )}
                    {importPending ? "Importing" : "Upload"}
                  </DialogTrigger>

                  <DialogContent className="overflow-hidden rounded-3xl border border-slate-200 bg-white p-0 shadow-[0_24px_80px_rgba(15,23,42,0.14)] sm:max-w-md">
                    <DialogHeader className="border-b border-slate-200 px-5 pb-4 pt-5">
                      <DialogTitle className="text-lg font-semibold text-slate-900">
                        Import Map Package
                      </DialogTitle>
                      <DialogDescription className="text-sm text-slate-500">
                        Choose a KML file and import settings.
                      </DialogDescription>
                    </DialogHeader>

                    <div className="min-w-0 space-y-4 px-5 py-4">
                      <div>
                        <p className="text-sm font-medium text-slate-900">
                          KML file
                        </p>
                        <input
                          ref={fileInputRef}
                          id="map-package-upload"
                          type="file"
                          accept=".kml,application/vnd.google-earth.kml+xml"
                          className="sr-only"
                          onChange={handleFileChange}
                          disabled={importPending}
                        />

                        {selectedImportFile ? (
                          <div className="mt-2 grid min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3">
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-600">
                              <FileText className="size-5" />
                            </span>
                            <div className="min-w-0">
                              <p
                                className="truncate text-sm font-medium text-slate-900"
                                title={selectedImportFile.name}
                              >
                                {selectedImportFile.name}
                              </p>
                              <p className="text-xs text-slate-500">
                                {formatFileSize(selectedImportFile.size)}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 rounded-lg px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
                                onClick={openFilePicker}
                                disabled={importPending}
                              >
                                Replace
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-8 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                                onClick={handleRemoveFile}
                                disabled={importPending}
                                aria-label="Remove selected file"
                              >
                                <X className="size-4" />
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={openFilePicker}
                            onDrop={handleFileDrop}
                            onDragOver={handleDragOver}
                            onDragLeave={handleDragLeave}
                            disabled={importPending}
                            className={cn(
                              "mt-2 flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-7 text-center transition-colors",
                              "disabled:cursor-not-allowed disabled:opacity-60",
                              isDraggingFile
                                ? "border-sky-400 bg-sky-50"
                                : "border-slate-300 bg-slate-50 hover:border-sky-300 hover:bg-sky-50/60",
                            )}
                          >
                            <span className="flex size-11 items-center justify-center rounded-full bg-white text-sky-600 shadow-sm ring-1 ring-slate-200">
                              <UploadCloud className="size-5" />
                            </span>
                            <span className="text-sm font-medium text-slate-700">
                              <span className="text-sky-600">Click to browse</span>{" "}
                              or drag &amp; drop
                            </span>
                            <span className="text-xs text-slate-400">
                              .kml files only
                            </span>
                          </button>
                        )}
                      </div>

                      <label
                        htmlFor="auto-route-imported-lines"
                        className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3"
                      >
                        <span className="flex min-w-0 items-start gap-3">
                          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-white text-sky-600 ring-1 ring-slate-200">
                            <Waypoints className="size-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-slate-900">
                              Auto route imported lines
                            </span>
                            <span className="mt-0.5 block text-xs text-slate-500">
                              Snap imported paths to the road network for routable
                              directions.
                            </span>
                          </span>
                        </span>
                        <Switch
                          id="auto-route-imported-lines"
                          checked={autoRouteImportedLines}
                          onCheckedChange={setAutoRouteImportedLines}
                          disabled={importPending}
                          aria-label="Auto route imported lines"
                        />
                      </label>
                    </div>

                    <DialogFooter className="mx-0 mb-0 rounded-none border-t border-slate-200 bg-white px-5 py-4">
                      <Button
                        variant="outline"
                        className="h-10 rounded-xl border-slate-200 bg-white px-4 text-slate-700 hover:bg-slate-100"
                        onClick={() => handleImportDialogOpenChange(false)}
                        disabled={importPending}
                      >
                        Cancel
                      </Button>
                      <Button
                        className="h-10 rounded-xl bg-sky-600 px-4 text-white hover:bg-sky-700"
                        onClick={handleImportSubmit}
                        disabled={!selectedImportFile || importPending}
                      >
                        {importPending ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Upload className="size-4" />
                        )}
                        Import
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>

              {importingFileName ? (
                <p className="mt-3 truncate text-xs text-slate-500">
                  {importPending ? "Processing" : "Selected"}:{" "}
                  {importingFileName}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
