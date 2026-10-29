import {
  BadGatewayException,
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type Coordinate = [number, number];

type GraphHopperPathDetail = [number, number, string | number | boolean | null];

type GraphHopperPath = {
  distance?: number;
  time?: number;
  points?: {
    type?: string;
    coordinates?: Coordinate[];
  };
  details?: {
    road_class?: GraphHopperPathDetail[];
    toll?: GraphHopperPathDetail[];
  };
};

type GraphHopperRouteResponse = {
  paths?: GraphHopperPath[];
  message?: string;
  hints?: Array<{ message?: string }> | Record<string, unknown>;
};

type GraphHopperRouteAttempt = {
  fallbackUsed: boolean;
  strictAvoidance: boolean;
  value: GraphHopperRouteResponse;
};

export type RoutedLineResult = {
  provider: 'graphhopper';
  costing: 'motor_scooter';
  fallbackUsed: boolean;
  strictAvoidanceApplied: boolean;
  distanceMeters: number;
  durationSeconds: number;
  warnings: string[];
  geometry: {
    type: 'LineString';
    coordinates: Coordinate[];
  };
};

export type RoutedLineSegmentResult = RoutedLineResult & {
  from: Coordinate;
  routeError?: string;
  routeStatus: 'routed' | 'failed';
  segmentIndex: number;
  to: Coordinate;
};

export type RoutedLineWithSegmentsResult = RoutedLineResult & {
  segments: RoutedLineSegmentResult[];
};

const MAX_ROUTE_LOCATIONS = 25;
const HIGHWAY_ROAD_CLASSES = new Set(['MOTORWAY']);
const TOLL_VALUES = new Set<string | boolean>(['ALL', 'HGV', true]);

@Injectable()
export class GraphHopperRoutingService {
  constructor(private readonly configService: ConfigService) {}

  async routeLineSegments(
    points: Coordinate[],
  ): Promise<RoutedLineWithSegmentsResult> {
    const normalizedPoints = this.normalizePoints(points);
    const segments: RoutedLineSegmentResult[] = [];

    for (let index = 0; index < normalizedPoints.length - 1; index += 1) {
      const from = normalizedPoints[index];
      const to = normalizedPoints[index + 1];

      try {
        const route = await this.routeLine([from, to]);
        segments.push({
          ...route,
          from,
          routeStatus: 'routed',
          segmentIndex: index,
          to,
        });
      } catch (error) {
        const routeError =
          error instanceof Error ? error.message : 'Auto route failed.';

        segments.push({
          provider: 'graphhopper',
          costing: 'motor_scooter',
          fallbackUsed: false,
          strictAvoidanceApplied: false,
          distanceMeters: Math.round(this.straightLineDistanceMeters(from, to)),
          durationSeconds: 0,
          warnings: ['Auto route failed; original segment was kept.'],
          geometry: {
            type: 'LineString',
            coordinates: [from, to],
          },
          from,
          routeError,
          routeStatus: 'failed',
          segmentIndex: index,
          to,
        });
      }
    }

    const routeCoordinates = this.joinSegmentCoordinates(segments);
    const routeWarnings = this.joinSegmentWarnings(segments);

    return {
      provider: 'graphhopper',
      costing: 'motor_scooter',
      fallbackUsed: segments.some((segment) => segment.fallbackUsed),
      strictAvoidanceApplied: segments.every(
        (segment) => segment.strictAvoidanceApplied,
      ),
      distanceMeters: Math.round(
        segments.reduce((total, segment) => total + segment.distanceMeters, 0),
      ),
      durationSeconds: Math.round(
        segments.reduce((total, segment) => total + segment.durationSeconds, 0),
      ),
      warnings: routeWarnings,
      geometry: {
        type: 'LineString',
        coordinates: routeCoordinates,
      },
      segments,
    };
  }

  async routeLine(points: Coordinate[]): Promise<RoutedLineResult> {
    const sampledPoints = this.sampleRoutePoints(points);
    const normalizedPoints = this.normalizePoints(sampledPoints);
    const wasSampled = sampledPoints.length < points.length;
    let attempt: GraphHopperRouteAttempt;

    try {
      attempt = await this.fetchRoute(normalizedPoints, true);
    } catch {
      attempt = {
        ...(await this.fetchRoute(normalizedPoints, false)),
        fallbackUsed: true,
      };
    }

    const path = attempt.value.paths?.[0];
    const routeCoordinates = this.readCoordinates(path);
    const warnings = this.warningMessages(attempt.value);

    if (attempt.fallbackUsed) {
      warnings.unshift(
        'Strict no-toll/no-highway route failed; fallback route may use restricted roads.',
      );
    }

    if (this.pathUsesToll(path)) {
      warnings.push('Route uses toll segments.');
    }

    if (this.pathUsesHighway(path)) {
      warnings.push('Route uses highway segments.');
    }

    if (wasSampled) {
      warnings.push(
        `Route input was sampled from ${points.length} to ${sampledPoints.length} points for GraphHopper.`,
      );
    }

    return {
      provider: 'graphhopper',
      costing: 'motor_scooter',
      fallbackUsed: attempt.fallbackUsed,
      strictAvoidanceApplied: attempt.strictAvoidance,
      distanceMeters: Math.round(path?.distance ?? 0),
      durationSeconds: Math.round((path?.time ?? 0) / 1000),
      warnings,
      geometry: {
        type: 'LineString',
        coordinates: routeCoordinates,
      },
    };
  }

  private joinSegmentCoordinates(segments: RoutedLineSegmentResult[]) {
    const coordinates: Coordinate[] = [];

    for (const segment of segments) {
      for (const coordinate of segment.geometry.coordinates) {
        const previous = coordinates[coordinates.length - 1];
        if (
          previous &&
          previous[0] === coordinate[0] &&
          previous[1] === coordinate[1]
        ) {
          continue;
        }

        coordinates.push(coordinate);
      }
    }

    return coordinates;
  }

  private joinSegmentWarnings(segments: RoutedLineSegmentResult[]) {
    const warnings: string[] = [];
    const seen = new Set<string>();

    for (const segment of segments) {
      for (const warning of segment.warnings) {
        const message =
          segments.length > 1
            ? `Segment ${segment.segmentIndex + 1}: ${warning}`
            : warning;
        if (seen.has(message)) {
          continue;
        }

        seen.add(message);
        warnings.push(message);
      }
    }

    return warnings;
  }

  private straightLineDistanceMeters(from: Coordinate, to: Coordinate) {
    const earthRadiusMeters = 6371008.8;
    const degreesToRadians = Math.PI / 180;
    const fromLatitude = from[1] * degreesToRadians;
    const toLatitude = to[1] * degreesToRadians;
    const deltaLatitude = (to[1] - from[1]) * degreesToRadians;
    const deltaLongitude = (to[0] - from[0]) * degreesToRadians;
    const sinLatitude = Math.sin(deltaLatitude / 2);
    const sinLongitude = Math.sin(deltaLongitude / 2);
    const a =
      sinLatitude * sinLatitude +
      Math.cos(fromLatitude) *
        Math.cos(toLatitude) *
        sinLongitude *
        sinLongitude;
    const normalizedA = Math.min(1, Math.max(0, a));

    return (
      earthRadiusMeters *
      2 *
      Math.atan2(Math.sqrt(normalizedA), Math.sqrt(1 - normalizedA))
    );
  }

  private sampleRoutePoints(points: Coordinate[]) {
    if (points.length <= MAX_ROUTE_LOCATIONS) {
      return points;
    }

    const sampled: Coordinate[] = [];
    const lastIndex = points.length - 1;

    for (let index = 0; index < MAX_ROUTE_LOCATIONS; index += 1) {
      const sourceIndex = Math.round(
        (index * lastIndex) / (MAX_ROUTE_LOCATIONS - 1),
      );
      const point = points[sourceIndex];
      const previous = sampled[sampled.length - 1];

      if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) {
        sampled.push(point);
      }
    }

    return sampled;
  }

  private normalizePoints(value: Coordinate[]): Coordinate[] {
    const points = value.map((point, index) => {
      if (!Array.isArray(point) || point.length < 2) {
        throw new BadRequestException(
          `Route point ${index + 1} must contain [longitude, latitude].`,
        );
      }

      const longitude = Number(point[0]);
      const latitude = Number(point[1]);

      if (
        !Number.isFinite(longitude) ||
        longitude < -180 ||
        longitude > 180 ||
        !Number.isFinite(latitude) ||
        latitude < -90 ||
        latitude > 90
      ) {
        throw new BadRequestException(
          `Route point ${index + 1} must contain valid longitude and latitude.`,
        );
      }

      return [
        Number(longitude.toFixed(6)),
        Number(latitude.toFixed(6)),
      ] satisfies Coordinate;
    });

    if (points.length < 2) {
      throw new BadRequestException('Auto route requires at least 2 points.');
    }

    return points;
  }

  private async fetchRoute(
    points: Coordinate[],
    strictAvoidance: boolean,
  ): Promise<GraphHopperRouteAttempt> {
    const graphhopperUrl = this.configService.get<string>('GRAPHHOPPER_URL');
    const timeoutMs =
      this.configService.get<number>('GRAPHHOPPER_TIMEOUT_MS') ?? 15000;

    if (!graphhopperUrl) {
      throw new BadGatewayException('GRAPHHOPPER_URL is not configured.');
    }

    const endpoint = new URL('route', `${graphhopperUrl.replace(/\/+$/, '')}/`);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        this.buildGraphHopperPayload(points, strictAvoidance),
      ),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error) => {
      throw new BadGatewayException(
        error instanceof Error
          ? error.message
          : 'GraphHopper route request failed.',
      );
    });

    const body = (await response
      .json()
      .catch(() => ({}))) as GraphHopperRouteResponse;

    if (!response.ok) {
      throw new BadGatewayException(this.errorMessage(body, response.status));
    }

    if (!body.paths?.length) {
      throw new BadGatewayException(this.errorMessage(body, response.status));
    }

    return {
      fallbackUsed: false,
      strictAvoidance,
      value: body,
    };
  }

  private buildGraphHopperPayload(
    points: Coordinate[],
    strictAvoidance: boolean,
  ) {
    return {
      profile:
        this.configService.get<string>('GRAPHHOPPER_PROFILE') ??
        'motor_scooter',
      points,
      points_encoded: false,
      instructions: false,
      calc_points: true,
      details: ['road_class', 'toll'],
      ...(strictAvoidance
        ? {
            custom_model: {
              priority: [
                {
                  if: 'toll == ALL || toll == HGV',
                  multiply_by: 0,
                },
                {
                  if: 'road_class == MOTORWAY',
                  multiply_by: 0,
                },
              ],
            },
          }
        : {}),
    };
  }

  private readCoordinates(path: GraphHopperPath | undefined) {
    const coordinates = path?.points?.coordinates ?? [];

    if (path?.points?.type !== 'LineString' || coordinates.length < 2) {
      throw new BadGatewayException(
        'GraphHopper returned an empty route shape.',
      );
    }

    return coordinates.map(([longitude, latitude]) => [
      Number(longitude.toFixed(6)),
      Number(latitude.toFixed(6)),
    ]) satisfies Coordinate[];
  }

  private pathUsesToll(path: GraphHopperPath | undefined) {
    return (path?.details?.toll ?? []).some(([, , value]) => {
      if (typeof value === 'string') {
        return TOLL_VALUES.has(value.toUpperCase());
      }

      return typeof value === 'boolean' ? TOLL_VALUES.has(value) : false;
    });
  }

  private pathUsesHighway(path: GraphHopperPath | undefined) {
    return (path?.details?.road_class ?? []).some(([, , value]) =>
      typeof value === 'string'
        ? HIGHWAY_ROAD_CLASSES.has(value.toUpperCase())
        : false,
    );
  }

  private warningMessages(body: GraphHopperRouteResponse) {
    if (!Array.isArray(body.hints)) {
      return [];
    }

    return body.hints
      .map((hint) => hint.message?.trim())
      .filter((message): message is string => Boolean(message));
  }

  private errorMessage(body: GraphHopperRouteResponse, status: number) {
    const hintMessage = Array.isArray(body.hints)
      ? body.hints.find((hint) => hint.message?.trim())?.message?.trim()
      : undefined;

    return (
      body.message?.trim() ||
      hintMessage ||
      `GraphHopper route request failed with status ${status}.`
    );
  }
}
