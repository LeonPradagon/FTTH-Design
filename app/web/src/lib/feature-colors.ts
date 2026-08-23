export const DEFAULT_FEATURE_COLORS: Record<string, string> = {
  pop: "#eab308",
  odc: "#ef4444",
  odp: "#3b82f6",
  house: "#6b7280",
  feeder: "#ef4444",
  distribution: "#8b5cf6",
};

export function resolveFeatureColors(
  saved: Record<string, string>,
  canEdit: boolean,
): Record<string, string> {
  return canEdit
    ? { ...DEFAULT_FEATURE_COLORS, ...saved }
    : { ...DEFAULT_FEATURE_COLORS };
}
