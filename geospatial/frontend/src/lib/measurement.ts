import type { LineString } from "geojson";

export type LngLat = [number, number];

export type MeasurementState = {
  distanceMeters: number | null;
  durationSeconds: number | null;
  error: string | null;
  isRouting: boolean;
  points: LngLat[];
  routeCoordinates: LngLat[];
  routingUnavailable: boolean;
  warnings: string[];
};

export type MeasurementAction =
  | { type: "clear" }
  | { type: "place-point"; point: LngLat }
  | { type: "route-pending"; points: [LngLat, LngLat] }
  | {
      type: "route-success";
      distanceMeters: number;
      durationSeconds: number | null;
      fallbackUsed: boolean;
      geometry: LineString;
      warnings: string[];
    }
  | {
      type: "route-failure";
      distanceMeters: number;
      error: string;
      points: [LngLat, LngLat];
    };

export const initialMeasurementState: MeasurementState = {
  distanceMeters: null,
  durationSeconds: null,
  error: null,
  isRouting: false,
  points: [],
  routeCoordinates: [],
  routingUnavailable: false,
  warnings: [],
};

export function measurementReducer(
  state: MeasurementState,
  action: MeasurementAction,
): MeasurementState {
  switch (action.type) {
    case "clear":
      return initialMeasurementState;
    case "place-point":
      if (state.points.length === 1 && !state.isRouting) {
        return state;
      }

      return {
        ...initialMeasurementState,
        points: [action.point],
        routeCoordinates: [action.point],
      };
    case "route-pending":
      return {
        ...initialMeasurementState,
        isRouting: true,
        points: action.points,
        routeCoordinates: action.points,
      };
    case "route-success": {
      const routeCoordinates = normalizeLineStringCoordinates(action.geometry);

      return {
        distanceMeters: action.distanceMeters,
        durationSeconds: action.durationSeconds,
        error: null,
        isRouting: false,
        points: state.points.slice(0, 2),
        routeCoordinates:
          routeCoordinates.length >= 2
            ? routeCoordinates
            : state.points.slice(0, 2),
        routingUnavailable: action.fallbackUsed,
        warnings: action.warnings,
      };
    }
    case "route-failure":
      return {
        distanceMeters: action.distanceMeters,
        durationSeconds: null,
        error: action.error,
        isRouting: false,
        points: action.points,
        routeCoordinates: action.points,
        routingUnavailable: true,
        warnings: [],
      };
    default:
      return state;
  }
}

export function normalizeLineStringCoordinates(geometry: LineString): LngLat[] {
  return geometry.coordinates
    .map(
      (coordinate) => [Number(coordinate[0]), Number(coordinate[1])] as LngLat,
    )
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
}

export function straightLineDistanceMeters(start: LngLat, end: LngLat) {
  const earthRadiusMeters = 6371008.8;
  const startLat = degreesToRadians(start[1]);
  const endLat = degreesToRadians(end[1]);
  const deltaLat = degreesToRadians(end[1] - start[1]);
  const deltaLng = degreesToRadians(end[0] - start[0]);
  const halfChord =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(deltaLng / 2) ** 2;

  return (
    2 *
    earthRadiusMeters *
    Math.atan2(Math.sqrt(halfChord), Math.sqrt(1 - halfChord))
  );
}

export function formatMetricDistance(meters: number) {
  if (!Number.isFinite(meters)) {
    return "Unavailable";
  }

  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }

  return `${(meters / 1000).toLocaleString(undefined, {
    maximumFractionDigits: meters < 10000 ? 2 : 1,
    minimumFractionDigits: meters < 10000 ? 2 : 1,
  })} km`;
}

export function formatDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) {
    return null;
  }

  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${totalMinutes} min`;
  }

  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}
