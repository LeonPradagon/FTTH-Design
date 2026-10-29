import { copyFile, rename, unlink } from 'fs/promises';
import {
  moveUploadedFile,
  routeImportedLineFeatures,
  type FinalGeometry,
} from './map-import.service';

jest.mock('fs/promises', () => {
  const actual =
    jest.requireActual<typeof import('fs/promises')>('fs/promises');

  return {
    ...actual,
    copyFile: jest.fn(),
    rename: jest.fn(),
    unlink: jest.fn(),
  };
});

const mockedCopyFile = jest.mocked(copyFile);
const mockedRename = jest.mocked(rename);
const mockedUnlink = jest.mocked(unlink);

describe('moveUploadedFile', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('renames files when source and destination are on the same filesystem', async () => {
    mockedRename.mockResolvedValue(undefined);

    await moveUploadedFile('/tmp/upload.kml', '/app/.data/upload.kml');

    expect(mockedRename).toHaveBeenCalledWith(
      '/tmp/upload.kml',
      '/app/.data/upload.kml',
    );
    expect(mockedCopyFile).not.toHaveBeenCalled();
    expect(mockedUnlink).not.toHaveBeenCalled();
  });

  it('copies and removes the temporary upload when rename crosses devices', async () => {
    const error = Object.assign(new Error('cross-device link not permitted'), {
      code: 'EXDEV',
    });
    mockedRename.mockRejectedValue(error);
    mockedCopyFile.mockResolvedValue(undefined);
    mockedUnlink.mockResolvedValue(undefined);

    await moveUploadedFile('/tmp/upload.kml', '/app/.data/upload.kml');

    expect(mockedCopyFile).toHaveBeenCalledWith(
      '/tmp/upload.kml',
      '/app/.data/upload.kml',
    );
    expect(mockedUnlink).toHaveBeenCalledWith('/tmp/upload.kml');
  });

  it('rethrows non-cross-device rename failures', async () => {
    const error = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    mockedRename.mockRejectedValue(error);

    await expect(
      moveUploadedFile('/tmp/upload.kml', '/app/.data/upload.kml'),
    ).rejects.toThrow('permission denied');
    expect(mockedCopyFile).not.toHaveBeenCalled();
    expect(mockedUnlink).not.toHaveBeenCalled();
  });
});

describe('routeImportedLineFeatures', () => {
  it('splits imported LineString route stops into independent Route Segment features', async () => {
    const geometry: FinalGeometry = {
      geometryType: 'LineString',
      ewkt: 'SRID=4326;LINESTRING(112.6970181372743 -7.572264551967913, 112.6904905779075 -7.569323128893251, 112.6873191057644 -7.58164303441426, 112.6796034400477 -7.584073563486804, 112.6947878376875 -7.589249612366031)',
      originalLineGeometry: {
        type: 'LineString',
        coordinates: [
          [112.697018, -7.572265],
          [112.690491, -7.569323],
          [112.687319, -7.581643],
          [112.679603, -7.584074],
          [112.694788, -7.58925],
        ],
      },
    };
    const router = {
      routeLineSegments: jest.fn((points: [number, number][]) =>
        Promise.resolve({
          provider: 'graphhopper' as const,
          costing: 'motor_scooter' as const,
          fallbackUsed: false,
          strictAvoidanceApplied: true,
          distanceMeters: 4000,
          durationSeconds: 400,
          warnings: [],
          geometry: {
            type: 'LineString' as const,
            coordinates: points,
          },
          segments: points.slice(0, -1).map((from, index) => ({
            provider: 'graphhopper' as const,
            costing: 'motor_scooter' as const,
            fallbackUsed: false,
            strictAvoidanceApplied: true,
            distanceMeters: (index + 1) * 1000,
            durationSeconds: (index + 1) * 100,
            warnings: [],
            geometry: {
              type: 'LineString' as const,
              coordinates: [from, points[index + 1]],
            },
            from,
            routeStatus: 'routed' as const,
            segmentIndex: index,
            to: points[index + 1],
          })),
        }),
      ),
    };

    const features = await routeImportedLineFeatures(geometry, router as never);

    expect(features).toHaveLength(4);
    expect(features.map((feature) => feature.nameSuffix)).toEqual([
      'Segment 1',
      'Segment 2',
      'Segment 3',
      'Segment 4',
    ]);
    expect(
      features.map((feature) => feature.rawProperties.routeDistanceMeters),
    ).toEqual([1000, 2000, 3000, 4000]);
    expect(features[0].geometry?.ewkt).toContain(
      '112.697018 -7.572265, 112.690491 -7.569323',
    );
    expect(features[3].rawProperties).toMatchObject({
      routeSegmentCount: 4,
      routeSegmentIndex: 3,
      routeStatus: 'routed',
    });
  });

  it('keeps source-defined LineString Route Segment features when Auto Routing is off', async () => {
    const geometry: FinalGeometry = {
      geometryType: 'LineString',
      ewkt: 'SRID=4326;LINESTRING(112.697018 -7.572265, 112.690491 -7.569323, 112.687319 -7.581643)',
      originalLineGeometry: {
        type: 'LineString',
        coordinates: [
          [112.697018, -7.572265],
          [112.690491, -7.569323],
          [112.687319, -7.581643],
        ],
      },
    };
    const router = {
      routeLineSegments: jest.fn(),
    };

    const features = await routeImportedLineFeatures(
      geometry,
      router as never,
      false,
    );

    expect(router.routeLineSegments).not.toHaveBeenCalled();
    expect(features).toHaveLength(2);
    expect(features.map((feature) => feature.nameSuffix)).toEqual([
      'Segment 1',
      'Segment 2',
    ]);
    expect(features[0].geometry?.ewkt).toContain(
      '112.697018 -7.572265, 112.690491 -7.569323',
    );
    expect(features[1].geometry?.ewkt).toContain(
      '112.690491 -7.569323, 112.687319 -7.581643',
    );
    expect(features[0].rawProperties).toEqual({
      routeMode: 'import-source-defined',
      routeStatus: 'source',
    });
  });

  it('splits source-defined MultiLineString Route Segment features when Auto Routing is off', async () => {
    const geometry: FinalGeometry = {
      geometryType: 'MultiLineString',
      ewkt: 'SRID=4326;MULTILINESTRING((112.1 -7.1, 112.2 -7.2),(113.1 -8.1, 113.2 -8.2, 113.3 -8.3))',
      originalLineGeometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [112.1, -7.1],
            [112.2, -7.2],
          ],
          [
            [113.1, -8.1],
            [113.2, -8.2],
            [113.3, -8.3],
          ],
        ],
      },
    };
    const router = {
      routeLineSegments: jest.fn(),
    };

    const features = await routeImportedLineFeatures(
      geometry,
      router as never,
      false,
    );

    expect(router.routeLineSegments).not.toHaveBeenCalled();
    expect(features).toHaveLength(3);
    expect(features.map((feature) => feature.nameSuffix)).toEqual([
      'Segment 1',
      'Segment 2',
      'Segment 3',
    ]);
    expect(features.map((feature) => feature.rawProperties)).toEqual([
      {
        routeMode: 'import-source-defined',
        routeStatus: 'source',
      },
      {
        routeMode: 'import-source-defined',
        routeStatus: 'source',
      },
      {
        routeMode: 'import-source-defined',
        routeStatus: 'source',
      },
    ]);
  });
});
