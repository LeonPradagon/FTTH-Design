import { createKmlFilename, serializeKmlExport } from './kml-export.serializer';

describe('serializeKmlExport', () => {
  it('preserves imported folder hierarchy and separates drawn features', () => {
    const kml = serializeKmlExport({
      mapName: 'Fiber Map',
      provinceName: 'DKI Jakarta',
      folders: [
        {
          id: 'root',
          parentId: null,
          name: 'Imported Root',
          sortOrder: 0,
        },
        {
          id: 'child',
          parentId: 'root',
          name: 'ODP & Access',
          sortOrder: 1,
        },
      ],
      importedFeatures: [
        {
          id: 'feature-1',
          folderId: 'child',
          name: 'Imported <Point>',
          description: 'Needs escaping & survives',
          sourcePath: 'Imported Root/ODP & Access/Imported Point',
          geometry: {
            type: 'Point',
            coordinates: [106.8272, -6.1754],
          },
          style: {
            pointColor: [255, 0, 0, 255],
          },
        },
      ],
      drawnFeatures: [
        {
          id: 'drawn-1',
          name: 'Drawn Line',
          rawProperties: {
            routeDistanceMeters: 1000,
            routeSegmentIndex: 0,
            source: 'drawn',
            style: { ignored: true },
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [106.8, -6.1],
              [106.9, -6.2],
            ],
          },
          style: {
            lineColor: [0, 128, 255, 255],
            lineWidth: 4,
          },
        },
      ],
    });

    expect(kml).toContain('<name>Fiber Map - DKI Jakarta</name>');
    expect(kml).toContain('<name>Imported Root</name>');
    expect(kml).toContain('<name>ODP &amp; Access</name>');
    expect(kml).toContain('<name>Imported &lt;Point&gt;</name>');
    expect(kml).toContain('Needs escaping &amp; survives');
    expect(kml).toContain('<name>Drawn Features</name>');
    expect(kml).toContain('<name>Drawn Line</name>');
    expect(kml).toContain(
      '<coordinates>106.82720000,-6.17540000</coordinates>',
    );
    expect(kml).toContain(
      '<coordinates>106.80000000,-6.10000000 106.90000000,-6.20000000</coordinates>',
    );
    expect(kml).toContain(
      '<Data name="routeDistanceMeters"><value>1000</value></Data>',
    );
    expect(kml).toContain(
      '<Data name="routeSegmentIndex"><value>0</value></Data>',
    );
    expect(kml).not.toContain('<Data name="style">');
  });

  it('normalizes untrusted style values before writing XML', () => {
    const kml = serializeKmlExport({
      mapName: 'Fiber Map',
      provinceName: 'DKI Jakarta',
      folders: [],
      importedFeatures: [],
      drawnFeatures: [
        {
          id: 'drawn-1',
          name: 'Drawn Line',
          geometry: {
            type: 'LineString',
            coordinates: [
              [106.8, -6.1],
              [106.9, -6.2],
            ],
          },
          style: {
            lineWidth: '1</width><Placemark>Injected</Placemark>' as never,
            iconScale: Number.NaN,
            labelScale: '<bad>' as never,
            lineColor: ['red', 999, -10, 255] as never,
            iconHref: { url: 'https://example.com/icon.png' } as never,
          },
        },
      ],
    });

    expect(kml).not.toContain('<Placemark>Injected</Placemark>');
    expect(kml).not.toContain('<bad>');
    expect(kml).not.toContain('<Icon><href>');
    expect(kml).toContain('<width>2</width>');
    expect(kml).toContain('<scale>1</scale>');
  });

  it('removes XML-invalid control characters from text nodes', () => {
    const kml = serializeKmlExport({
      mapName: 'Fiber\u0001Map',
      provinceName: 'DKI Jakarta',
      folders: [],
      importedFeatures: [],
      drawnFeatures: [
        {
          id: 'drawn-1',
          name: 'Bad\u0002Name',
          description: 'Bad\u0003Description',
          geometry: {
            type: 'Point',
            coordinates: [106.8272, -6.1754],
          },
        },
      ],
    });

    expect(kml).toContain('<name>FiberMap - DKI Jakarta</name>');
    expect(kml).toContain('<name>BadName</name>');
    expect(kml).toContain('<description>BadDescription</description>');
  });
});

describe('createKmlFilename', () => {
  it('creates a safe descriptive filename', () => {
    expect(createKmlFilename('Fiber Map', 'DKI Jakarta')).toBe(
      'fiber-map-dki-jakarta.kml',
    );
  });
});
