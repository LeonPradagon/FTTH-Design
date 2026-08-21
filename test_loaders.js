import fs from 'fs';
import { parse } from '@loaders.gl/core';
import { KMLWorker } from '@loaders.gl/kml';

const data = fs.readFileSync('dashboard/public/data/imports/1787301955_Boundary & 1 others - 21-08-2026.kml');
parse(data, KMLWorker).then(res => console.log(JSON.stringify(res.features[1].properties, null, 2)));
