import { createCsvFilename, serializeCsvExport } from './csv-export.serializer';

describe('serializeCsvExport', () => {
  it('serializes imported and drawn features with folder paths and coordinates', () => {
    const csv = serializeCsvExport({
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
          name: 'Imported Point',
          description: 'Needs, escaping',
          sourcePath: 'Imported Root/ODP & Access/Imported Point',
          geometry: {
            type: 'Point',
            coordinates: [106.8272, -6.1754],
          },
        },
      ],
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
        },
      ],
    });

    expect(csv.split('\r\n')[0]).toBe(
      'source,id,folder_id,folder_path,name,description,geometry_type,longitude,latitude,coordinates,source_path',
    );
    expect(csv).toContain(
      'imported,feature-1,child,Imported Root/ODP & Access,Imported Point,"Needs, escaping",Point,106.8272,-6.1754,"[106.8272,-6.1754]",Imported Root/ODP & Access/Imported Point',
    );
    expect(csv).toContain(
      'drawn,drawn-1,,,Drawn Line,,LineString,,,"[[106.8,-6.1],[106.9,-6.2]]",',
    );
  });

  it('escapes quotes, line breaks, and spreadsheet formulas', () => {
    const csv = serializeCsvExport({
      mapName: 'Fiber Map',
      provinceName: 'DKI Jakarta',
      folders: [],
      importedFeatures: [],
      drawnFeatures: [
        {
          id: 'drawn-1',
          name: '=HYPERLINK("https://example.com")',
          description: 'Line 1\nLine "2"',
          geometry: {
            type: 'Point',
            coordinates: [106.8272, -6.1754],
          },
        },
        {
          id: 'drawn-2',
          name: '\t=SUM(1,1)',
          description: ' =SUM(1,1)',
          sourcePath: '\r@IMPORTXML("https://example.com")',
          geometry: {
            type: 'Point',
            coordinates: [106.8273, -6.1755],
          },
        },
        {
          id: 'drawn-3',
          name: '\n+SUM(1,1)',
          description: '-SUM(1,1)',
          geometry: {
            type: 'Point',
            coordinates: [106.8274, -6.1756],
          },
        },
      ],
    });

    expect(csv).toContain(
      'drawn,drawn-1,,,"\'=HYPERLINK(""https://example.com"")","Line 1\nLine ""2""",Point,106.8272,-6.1754,"[106.8272,-6.1754]",',
    );
    expect(csv).toContain(
      'drawn,drawn-2,,,"\'\t=SUM(1,1)","\' =SUM(1,1)",Point,106.8273,-6.1755,"[106.8273,-6.1755]","\'\r@IMPORTXML(""https://example.com"")"',
    );
    expect(csv).toContain(
      'drawn,drawn-3,,,"\'\n+SUM(1,1)","\'-SUM(1,1)",Point,106.8274,-6.1756,"[106.8274,-6.1756]",',
    );
  });
});

describe('createCsvFilename', () => {
  it('creates a safe descriptive filename', () => {
    expect(createCsvFilename('Fiber Map', 'DKI Jakarta')).toBe(
      'fiber-map-dki-jakarta.csv',
    );
  });
});
