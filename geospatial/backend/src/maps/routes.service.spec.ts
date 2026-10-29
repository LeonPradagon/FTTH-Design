import { GraphHopperRoutingService } from './graphhopper-routing.service';
import { RoutesService } from './routes.service';

type GraphHopperPayloadForTest = {
  custom_model?: {
    priority?: Array<{ if?: string; multiply_by?: number }>;
  };
  details?: string[];
  points_encoded?: boolean;
  profile?: string;
};

describe('RoutesService', () => {
  const routeCoordinates: [number, number][] = [
    [106.8272, -6.1754],
    [106.835, -6.18],
    [106.8456, -6.2088],
  ];

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('falls back when strict toll/highway exclusion fails', async () => {
    const routingService = new GraphHopperRoutingService({
      get: jest.fn((key: string) =>
        key === 'GRAPHHOPPER_URL'
          ? 'http://graphhopper.test'
          : key === 'GRAPHHOPPER_TIMEOUT_MS'
            ? 15000
            : key === 'GRAPHHOPPER_PROFILE'
              ? 'motor_scooter'
              : undefined,
      ),
    } as never);
    const service = new RoutesService({} as never, routingService);
    jest
      .spyOn(
        service as unknown as { assertMapExists: () => Promise<void> },
        'assertMapExists',
      )
      .mockResolvedValue(undefined);

    const fetchMock = jest
      .fn<Promise<Response>, [URL | RequestInfo, RequestInit?]>()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ message: 'No path found' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            paths: [
              {
                points: {
                  type: 'LineString',
                  coordinates: routeCoordinates,
                },
                details: {
                  road_class: [[0, 2, 'MOTORWAY']],
                  toll: [[0, 2, 'NO']],
                },
                distance: 1234.4,
                time: 321400,
              },
            ],
            hints: { 'visited_nodes.sum': 114 },
          }),
      } as Response);
    jest.spyOn(global, 'fetch').mockImplementation(fetchMock);

    const result = await service.preview(
      '00000000-0000-4000-8000-000000000000',
      {
        points: [
          [106.8272, -6.1754],
          [106.8456, -6.2088],
        ],
      },
    );

    expect(result.provider).toBe('graphhopper');
    expect(result.geometry.coordinates).toEqual(routeCoordinates);
    expect(result.distanceMeters).toBe(1234);
    expect(result.durationSeconds).toBe(321);
    expect(result.fallbackUsed).toBe(true);
    expect(result.strictAvoidanceApplied).toBe(false);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      routeStatus: 'routed',
      segmentIndex: 0,
      distanceMeters: 1234,
    });
    expect(result.warnings).toContain('Route uses highway segments.');

    const strictBody = fetchMock.mock.calls[0][1]?.body;
    const fallbackBody = fetchMock.mock.calls[1][1]?.body;

    if (typeof strictBody !== 'string' || typeof fallbackBody !== 'string') {
      throw new Error(
        'Expected GraphHopper requests to use JSON string bodies.',
      );
    }

    const strictRequest = JSON.parse(
      strictBody,
    ) as unknown as GraphHopperPayloadForTest;
    const fallbackRequest = JSON.parse(
      fallbackBody,
    ) as unknown as GraphHopperPayloadForTest;

    expect(strictRequest.profile).toBe('motor_scooter');
    expect(strictRequest.points_encoded).toBe(false);
    expect(strictRequest.details).toEqual(['road_class', 'toll']);
    expect(strictRequest.custom_model?.priority).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          if: 'toll == ALL || toll == HGV',
          multiply_by: 0,
        }),
        expect.objectContaining({
          if: 'road_class == MOTORWAY',
          multiply_by: 0,
        }),
      ]),
    );
    expect(fallbackRequest.custom_model).toBeUndefined();
  });

  it('returns failed route segments without failing the whole preview', async () => {
    const routingService = new GraphHopperRoutingService({
      get: jest.fn((key: string) =>
        key === 'GRAPHHOPPER_URL'
          ? 'http://graphhopper.test'
          : key === 'GRAPHHOPPER_TIMEOUT_MS'
            ? 15000
            : key === 'GRAPHHOPPER_PROFILE'
              ? 'motor_scooter'
              : undefined,
      ),
    } as never);
    const service = new RoutesService({} as never, routingService);
    jest
      .spyOn(
        service as unknown as { assertMapExists: () => Promise<void> },
        'assertMapExists',
      )
      .mockResolvedValue(undefined);

    const fetchMock = jest
      .fn<Promise<Response>, [URL | RequestInfo, RequestInit?]>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            paths: [
              {
                points: {
                  type: 'LineString',
                  coordinates: [
                    [106.8272, -6.1754],
                    [106.835, -6.18],
                  ],
                },
                distance: 1000,
                time: 120000,
              },
            ],
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ message: 'No strict path found' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ message: 'No fallback path found' }),
      } as Response);
    jest.spyOn(global, 'fetch').mockImplementation(fetchMock);

    const result = await service.preview(
      '00000000-0000-4000-8000-000000000000',
      {
        points: [
          [106.8272, -6.1754],
          [106.835, -6.18],
          [106.8456, -6.2088],
        ],
      },
    );

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({
      routeStatus: 'routed',
      segmentIndex: 0,
      distanceMeters: 1000,
    });
    expect(result.segments[1]).toMatchObject({
      routeStatus: 'failed',
      segmentIndex: 1,
      routeError: 'No fallback path found',
      geometry: {
        type: 'LineString',
        coordinates: [
          [106.835, -6.18],
          [106.8456, -6.2088],
        ],
      },
    });
    expect(result.distanceMeters).toBeGreaterThan(1000);
    expect(result.warnings).toContain(
      'Segment 2: Auto route failed; original segment was kept.',
    );
  });
});
