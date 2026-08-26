export const DEFAULT_FEATURE_COLORS: Record<string, string> = {
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

export function resolveFeatureColors(
  savedColors: Record<string, string>,
  canEditColors: boolean,
): Record<string, string> {
  if (!canEditColors) return { ...DEFAULT_FEATURE_COLORS };

  const usesLegacyDefaults = Object.entries(LEGACY_DEFAULT_FEATURE_COLORS)
    .every(([key, color]) => savedColors[key]?.toLowerCase() === color);

  return usesLegacyDefaults
    ? { ...DEFAULT_FEATURE_COLORS }
    : { ...DEFAULT_FEATURE_COLORS, ...savedColors };
}
