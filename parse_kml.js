const fs = require('fs');
const DOMParser = require('xmldom').DOMParser;
const toGeoJSON = require('@mapbox/togeojson');

const kmlText = fs.readFileSync('dashboard/public/data/PO.2025.02.00113.kml', 'utf8');
const doc = new DOMParser().parseFromString(kmlText);
const geoJson = toGeoJSON.kml(doc);

const feature = geoJson.features.find(f => f.properties && f.properties.name === 'W1_MN_EJ.TBM_001');
console.log(JSON.stringify(feature, null, 2));
