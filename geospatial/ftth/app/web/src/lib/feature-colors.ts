export const DEFAULT_FEATURE_COLORS: Record<string, string> = {
  pop: "#eab308",
  odc: "#ff0000",
  odp: "#0000ff",
  house: "#6b7280",
  feeder: "#ff0000",
  distribution: "#aa00ff",
};

const PREVIOUS_DEFAULT_FEATURE_COLORS: Record<string, string> = {
  pop: "#eab308",
  odc: "#ef4444",
  odp: "#3b82f6",
  house: "#6b7280",
  feeder: "#ef4444",
  distribution: "#8b5cf6",
};

const LEGACY_DEFAULT_FEATURE_COLORS: Record<string, string> = {
  pop: "#ef4444",
  odc: "#3b82f6",
  odp: "#10b981",
  house: "#6b7280",
  feeder: "#ef4444",
  distribution: "#3b82f6",
};

const isPalette = (colors: Record<string, string>, palette: Record<string, string>) =>
  Object.entries(palette).every(([key, value]) => colors[key]?.toLowerCase() === value);

export function resolveFeatureColors(
  saved: Record<string, string>,
  canEdit: boolean,
): Record<string, string> {
  const normalized = { ...DEFAULT_FEATURE_COLORS, ...saved };
  if (
    canEdit
    && (
      isPalette(normalized, PREVIOUS_DEFAULT_FEATURE_COLORS)
      || isPalette(normalized, LEGACY_DEFAULT_FEATURE_COLORS)
    )
  ) {
    return { ...DEFAULT_FEATURE_COLORS };
  }
  return canEdit ? normalized : { ...DEFAULT_FEATURE_COLORS };
}
