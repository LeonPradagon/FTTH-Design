const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, rm, utimes, writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash, createHmac } = require('node:crypto');
const test = require('node:test');
const JSZip = require('jszip');
const { PgDialect } = require('drizzle-orm/pg-core');
const { BadRequestException, HttpException, NotFoundException } = require('@nestjs/common');
const { ApiExceptionFilter } = require('../dist/src/api-exception.filter.js');
const { ProxyAuthGuard } = require('../dist/src/auth/proxy-auth.guard.js');
const { GenerationController, latestBatchRows, summarizeBatchJobs } = require('../dist/src/generation/generation.controller.js');
const { ProjectsController } = require('../dist/src/projects/projects.controller.js');
const { AuditController } = require('../dist/src/audit/audit.controller.js');
const { VersionsController } = require('../dist/src/versions/versions.controller.js');
const { FilesController } = require('../dist/src/files/files.controller.js');
const { GenerationRateLimiter } = require('../dist/src/auth/generation-rate-limiter.js');
const { StorageService } = require('../dist/src/storage/storage.service.js');
const { downloadOsmPbf } = require('../dist/src/scripts/download-osm-pbf.js');
const { projects } = require('../dist/src/db/schema.js');
const { validateDesignUpload } = require('../dist/src/files/upload-validation.js');
const { integerParameter } = require('../dist/src/http/integer-parameter.js');
const { datasetSourceTimestamp, flexStyle, importWorkerCount } = require('../dist/src/scripts/import-osm-pbf.js');
const { addEdge, boundaryCentroid, buildCsv, capacitatedClusters, classifyCustomPoints, customMappingGroup, designStats, localFallbackEnabled, localOsmPopName, localPopSearchArea, localRoadWindow, normalizeCachedState, normalizeFeatureColors, osmRequestTimeoutSeconds, outputOdpLabel, parseNativeOsmXml, parseOverpassElements, roundHalfEven, readKml, rebalanceOdpsByRoadConnectivity, requireCompleteDistributionTree, requireDistributionConnectivity, route, strategicPop, walkAlongRoad, GeneratorService } = require('../dist/src/generation/generator.service.js');

const sample = (name) => resolve(__dirname, '../../../samples/kml', name);

test('KML parsing matches the reference implementation fixture counts', async () => {
  const boundary = await readKml(await readFile(sample('boundary.kml')), 'boundary.kml');
  assert.equal(boundary.filter((item) => item.polygon).length, 1);
  assert.equal(boundary.filter((item) => item.point).length, 0);

  const combined = await readKml(await readFile(sample('PO.2025.02.00113.kml')), 'PO.2025.02.00113.kml');
  assert.equal(combined.length, 149);
  assert.equal(combined.filter((item) => item.polygon).length, 1);
  assert.equal(combined.filter((item) => item.point).length, 75);
});

test('KML parsing finds point geometry nested in MultiGeometry like reference implementation', async () => {
  const xml = Buffer.from('<kml><Document><Placemark><name>OLT</name><MultiGeometry><Point><coordinates>106.25,-6.25,0</coordinates></Point></MultiGeometry></Placemark></Document></kml>');
  assert.deepEqual(await readKml(xml, 'combined.kml'), [{ name: 'OLT', point: [106.25, -6.25], context: '', description: '', folderContext: '' }]);
});

test('upload validation accepts KML and rejects invalid inputs like reference implementation', async () => {
  assert.equal(await validateDesignUpload({ originalname: 'boundary.kml', buffer: Buffer.from('<kml></kml>') }, 1024), 'boundary.kml');
  await assert.rejects(validateDesignUpload({ originalname: 'boundary.txt', buffer: Buffer.from('x') }, 1024), (error) => {
    assert.equal(error.getStatus(), 400);
    assert.deepEqual(error.getResponse(), { success: false, error: { code: 'INVALID_FILE', message: 'File harus berformat KML atau KMZ.' } });
    return true;
  });
  await assert.rejects(validateDesignUpload({ originalname: 'broken.kmz', buffer: Buffer.from('not a zip') }, 1024), (error) => error.getResponse().error.code === 'INVALID_FILE');
  await assert.rejects(validateDesignUpload({ originalname: 'large.kml', buffer: Buffer.alloc(1025, 0x61) }, 1024), (error) => error.getStatus() === 413);

  const zip = new JSZip();
  zip.file('doc.kml', '<kml></kml>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  assert.equal(await validateDesignUpload({ originalname: 'archive.kmz', buffer: bytes }, 1024), 'archive.kmz');
  assert.deepEqual(await readKml(bytes, 'archive.kmz'), []);
});

test('required multipart files return previous API validation errors', async () => {
  const files = new FilesController({}, { consume: async () => {} });
  const req = { user: { id: 'owner', role: 'engineer' }, body: {} };
  await assert.rejects(files.upload(undefined, req), (error) => error.getStatus() === 422 && error.getResponse().detail[0].loc.join('/') === 'body/file');
  const generation = new GenerationController({}, {}, {}, {}, {});
  generation.generationUser = async () => req.user;
  await assert.rejects(generation.batch([], req), (error) => error.getStatus() === 422 && error.getResponse().detail[0].loc.join('/') === 'body/files');
  await assert.rejects(generation.custom({}, req), (error) => error.getStatus() === 422 && error.getResponse().detail[0].loc.join('/') === 'body/customFile');
});

test('KML upload content type follows the filename extension like reference implementation', async () => {
  let uploaded;
  const controller = new FilesController({ async upload(...args) { uploaded = args; } }, { consume() {} });
  await controller.upload({ originalname: '../../__Site Plan.kml', mimetype: 'text/html', buffer: Buffer.from('<kml>site</kml>') }, { user: { id: 'test-user', role: 'engineer' } });
  assert.equal(uploaded[2], 'application/vnd.google-earth.kml+xml');
  assert.match(uploaded[3], /Site-Plan\.kml$/);
  const failed = new FilesController({ async upload() { throw new Error('private storage failure'); } }, { consume() {} });
  await assert.rejects(failed.upload({ originalname: 'design.kml', buffer: Buffer.from('<kml></kml>') }, { user: { id: 'test-user', role: 'engineer' } }), (error) => {
    assert.equal(error.getStatus(), 500);
    assert.equal(error.getResponse().message, 'Failed to upload file');
    return true;
  });
});

test('nested data keys download through Express wildcard and unauthorized keys return 404', async () => {
  const keys = [];
  const controller = new FilesController({ async download(key) {
    keys.push(key);
    return { body: Buffer.from('kmz'), contentType: 'application/vnd.google-earth.kmz' };
  } }, {});
  const request = { user: { id: 'owner', role: 'engineer' } };
  const headers = {};
  await controller.downloadData(['imports', 'old', 'design.kmz'], request, { setHeader: (key, value) => { headers[key] = value; } });
  assert.deepEqual(keys, ['imports/old/design.kmz']);
  assert.equal(headers['Content-Type'], 'application/vnd.google-earth.kmz');
  await assert.rejects(controller.downloadData(['other', 'design.kmz'], request, { setHeader() {} }), (error) => error.getStatus() === 404);
  await assert.rejects(controller.downloadData(['imports', '..', 'secret'], request, { setHeader() {} }), (error) => error.getStatus() === 404);
  assert.equal(keys.length, 1);
  const unavailable = new Error('storage unavailable');
  const attempted = [];
  const broken = new FilesController({ async download(key) { attempted.push(key); throw unavailable; } }, {});
  await assert.rejects(broken.downloadUserFile('design.kmz', request, { setHeader() {} }), (error) => error === unavailable);
  assert.equal(attempted.length, 1);
  const legacy = new FilesController({ async download(key) {
    if (key.startsWith('users/')) throw new NotFoundException('File not found');
    throw unavailable;
  } }, {});
  await assert.rejects(legacy.downloadUserFile('design.kmz', request, { setHeader() {} }), (error) => error === unavailable);
});

test('user file downloads fall back to the legacy raw account namespace', async () => {
  const keys = [];
  const storage = { async download(key) {
    keys.push(key);
    if (key.startsWith('users/')) throw new NotFoundException('File not found');
    return { body: Buffer.from('legacy'), contentType: 'application/vnd.google-earth.kmz', contentLength: 6, contentDisposition: 'inline; filename="old.kmz"' };
  } };
  const files = new FilesController(storage, {});
  const headers = {};
  const result = await files.downloadUserFile('old.kmz', { user: { id: 'legacy-user', role: 'engineer' } }, { setHeader: (name, value) => { headers[name] = value; } });
  assert.equal(keys.length, 2);
  assert.equal(keys[1], 'legacy-user/old.kmz');
  assert.equal(headers['Content-Type'], 'application/vnd.google-earth.kmz');
  assert.equal(headers['Content-Length'], 6);
  assert.ok(result);
});

test('proxy authentication rejects appended or malformed signatures', () => {
  const previous = process.env.BACKEND_PROXY_SECRET;
  process.env.BACKEND_PROXY_SECRET = 'parity-secret';
  try {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = `owner|${timestamp}|engineer|owner@example.com`;
    const signature = createHmac('sha256', 'parity-secret').update(payload).digest('hex');
    const guard = new ProxyAuthGuard();
    const verify = (value) => {
      const request = { headers: { 'x-proxy-auth': value } };
      guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) });
      return request.user;
    };
    assert.deepEqual(verify(`${payload}|${signature}`), { id: 'owner', role: 'engineer', email: 'owner@example.com' });
    const pipedEmailPayload = `owner|${timestamp}|engineer|a|b@example.com`;
    const pipedEmailSignature = createHmac('sha256', 'parity-secret').update(pipedEmailPayload).digest('hex');
    assert.deepEqual(verify(`${pipedEmailPayload}|${pipedEmailSignature}`), { id: 'owner', role: 'engineer', email: 'a|b@example.com' });
    const referenceImplementationIntegerPayload = `owner| +${timestamp} |engineer|owner@example.com`;
    const referenceImplementationIntegerSignature = createHmac('sha256', 'parity-secret').update(referenceImplementationIntegerPayload).digest('hex');
    assert.deepEqual(verify(`${referenceImplementationIntegerPayload}|${referenceImplementationIntegerSignature}`), { id: 'owner', role: 'engineer', email: 'owner@example.com' });
    assert.throws(() => verify(`${payload}|${signature}|extra`), (error) => error.getStatus() === 401);
    assert.throws(() => verify(`${payload}|${signature}zz`), (error) => error.getStatus() === 401);
    assert.throws(() => verify(`${payload}|${signature.toUpperCase()}`), (error) => error.getStatus() === 401);
  } finally {
    if (previous === undefined) delete process.env.BACKEND_PROXY_SECRET;
    else process.env.BACKEND_PROXY_SECRET = previous;
  }
});

test('S3 bucket creation includes the configured non-default region like reference implementation', async () => {
  const previous = { region: process.env.STORAGE_REGION, bucket: process.env.STORAGE_BUCKET, driver: process.env.STORAGE_DRIVER };
  process.env.STORAGE_REGION = 'eu-west-1';
  process.env.STORAGE_BUCKET = 'test-bucket';
  delete process.env.STORAGE_DRIVER;
  try {
    const service = new StorageService(), commands = [];
    service.client = { async send(command) { commands.push(command); if (command.constructor.name === 'HeadBucketCommand') throw { $metadata: { httpStatusCode: 404 } }; return {}; } };
    await service.onModuleInit();
    assert.equal(commands[1].input.Bucket, 'test-bucket');
    assert.equal(commands[1].input.CreateBucketConfiguration.LocationConstraint, 'eu-west-1');
  } finally {
    for (const [key, value] of Object.entries({ STORAGE_REGION: previous.region, STORAGE_BUCKET: previous.bucket, STORAGE_DRIVER: previous.driver })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('object storage deletion removes content and HTTP metadata like reference implementation', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ftth-storage-delete-'));
  const previous = { driver: process.env.STORAGE_DRIVER, root: process.env.STORAGE_LOCAL_ROOT };
  try {
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_ROOT = root;
    const storage = new StorageService();
    await storage.onModuleInit();
    await storage.upload('imports/job-1/map.kml', Buffer.from('map'), 'application/vnd.google-earth.kml+xml', 'map.kml');
    assert.equal((await storage.download('imports/job-1/map.kml')).contentLength, 3);
    await storage.delete('imports/job-1/map.kml');
    await assert.rejects(storage.download('imports/job-1/map.kml'), (error) => error.getStatus() === 404);
    await assert.rejects(storage.delete('../outside'), (error) => error.getStatus() === 404);
  } finally {
    if (previous.driver === undefined) delete process.env.STORAGE_DRIVER; else process.env.STORAGE_DRIVER = previous.driver;
    if (previous.root === undefined) delete process.env.STORAGE_LOCAL_ROOT; else process.env.STORAGE_LOCAL_ROOT = previous.root;
    await rm(root, { recursive: true, force: true });
  }
});

test('generation options enforce reference implementation GenerationConfig bounds', () => {
  const generator = new GeneratorService({});
  const defaults = generator.validateOptions({});
  assert.deepEqual([
    defaults.odp_capacity, defaults.odc_capacity,
    defaults.min_odp_cluster_size, defaults.min_odc_cluster_size,
    defaults.max_odp_radius_m, defaults.max_odc_radius_m,
    defaults.max_feeder_length_m, defaults.max_distribution_length_m,
    defaults.snapping_distance_m, defaults.routing_strategy,
  ], [10, 4, 1, 1, 150, 500, 2000, 500, 100, 'shortest']);
  assert.equal(generator.validateOptions({ odp_capacity: 16 }).odp_capacity, 16);
  assert.equal(defaults.include_homepass, true);
  assert.equal(defaults.force_refresh_osm, false);
  assert.equal(generator.validateOptions({ include_homepass: 'false', force_refresh_osm: 'off' }).include_homepass, false);
  assert.equal(generator.validateOptions({ include_homepass: 'on', force_refresh_osm: 1 }).force_refresh_osm, true);
  assert.throws(() => generator.validateOptions({ include_homepass: 'maybe' }), (error) => error.getStatus() === 400);
  assert.throws(() => generator.validateOptions({ force_refresh_osm: null }), (error) => error.getStatus() === 400);
  assert.throws(() => generator.validateOptions({ odp_capacity: null }), (error) => error.getStatus() === 400);
  assert.throws(() => generator.validateOptions({ odp_capacity: '' }), (error) => error.getStatus() === 400);
  assert.throws(() => generator.validateOptions({ max_odp_radius_m: true }), (error) => error.getStatus() === 400);
  assert.throws(() => generator.validateOptions({ odp_capacity: 65 }), (error) => error.getStatus() === 400);
  assert.throws(() => generator.validateOptions({ min_odp_cluster_size: 11 }), (error) => error.getStatus() === 400);
  assert.throws(() => generator.validateOptions({ max_odp_radius_m: 9 }), (error) => error.getStatus() === 400);
  assert.throws(() => generator.validateOptions({ routing_strategy: 'fastest' }), (error) => error.getStatus() === 400);
});

test('generation form JSON errors and non-object colors follow reference implementation responses', () => {
  const controller = new GenerationController({}, {}, new GeneratorService({}), {}, {});
  assert.deepEqual(controller.parseOptions({ feature_colors: '[]' }).feature_colors, {});
  assert.equal(Object.hasOwn(controller.parseOptions({ config: '{"unknown_referenceImplementation_ignored_field":1}' }), 'unknown_referenceImplementation_ignored_field'), false);
  for (const config of ['{broken', '[]', '{"include_homepass":null}', '{"odp_capacity":0}']) {
    assert.throws(() => controller.parseOptions({ config }), (error) => {
      assert.equal(error.getStatus(), 400);
      assert.equal(error.getResponse().error.code, 'INVALID_FILE');
      assert.equal(error.getResponse().error.details.raw, config);
      return true;
    });
  }
  assert.throws(() => controller.parseOptions({ config: '{"include_homepass":null}', mode: 'CORE' }), (error) => error.getResponse().error.code === 'INVALID_FILE');
  assert.throws(() => controller.parseOptions({ feature_colors: '{broken' }), (error) => error.getResponse().error.code === 'INVALID_FILE');
});

test('feature color normalization matches reference implementation defaults, legacy palettes, and invalid values', () => {
  assert.deepEqual(normalizeFeatureColors({ odc: '#EF4444', odp: 'invalid' }), {
    pop: '#eab308', odc: '#ef4444', odp: '#0000ff', house: '#6b7280', feeder: '#ff0000', distribution: '#aa00ff',
  });
  assert.deepEqual(normalizeFeatureColors({
    pop: '#eab308', odc: '#ef4444', odp: '#3b82f6', house: '#6b7280', feeder: '#ef4444', distribution: '#8b5cf6',
  }), {
    pop: '#eab308', odc: '#ff0000', odp: '#0000ff', house: '#6b7280', feeder: '#ff0000', distribution: '#aa00ff',
  });
});

test('reference implementation version 4 cache preserves its network geometry and homepass assignments in Nest', async () => {
  const referenceImplementationState = {
    version: 4,
    pop: { name: 'POP Mojokerto', lat: -7.45, lon: 112.43 },
    odcs: [{ id: 'ODC-001', lat: -7.451, lon: 112.431, odps: [{ id: 'ODP-001', lat: -7.452, lon: 112.432, houses: [[-7.453, 112.433]], upstream_id: 'ODC-001' }] }],
    feeder_segments: [{ from_label: 'POP Mojokerto', to_label: 'ODC-001', coords: [[-7.45, 112.43], [-7.451, 112.431]] }],
    distribution_segments: { 'ODP-001': { source_id: 'ODC-001', target_id: 'ODP-001', coords: [[-7.451, 112.431], [-7.452, 112.432]], length_m: 157, connected: true } },
    boundary: { type: 'Polygon', coordinates: [[[112.42, -7.46], [112.44, -7.46], [112.44, -7.44], [112.42, -7.44], [112.42, -7.46]]] },
  };
  const cached = normalizeCachedState(referenceImplementationState);
  assert.deepEqual(cached.pop, [112.43, -7.45]);
  assert.deepEqual(cached.cables.map(({ type, coords }) => [type, coords]), [
    ['feeder', [[112.43, -7.45], [112.431, -7.451]]],
    ['distribution', [[112.431, -7.451], [112.432, -7.452]]],
  ]);
  const result = await new GeneratorService({}).fromCache(cached, {}, 'homepass');
  assert.equal(result.state.customers.length, 1);
  assert.equal(result.state.cables.filter((cable) => cable.type === 'homepass').length, 1);
  assert.deepEqual(result.state.cables.find((cable) => cable.type === 'distribution').coords, [[112.431, -7.451], [112.432, -7.452]]);
  assert.deepEqual(result.state.boundaries, cached.boundaries);
  const outputZip = await JSZip.loadAsync(result.kmz), outputKml = await outputZip.file('doc.kml').async('string');
  assert.match(outputKml, /<name>POP Mojokerto-ODC-001<\/name>/);
  assert.doesNotMatch(outputKml, /<LineString><name>/);
  assert.equal((await outputZip.file('files/ftth-house.png').async('nodebuffer')).readUInt32BE(16), 96);

  const coords = [cached.pop, cached.odcs[0].at, cached.odps[0].at];
  const key = ([lon, lat]) => `${lon.toFixed(7)},${lat.toFixed(7)}`;
  const graph = new Map(coords.map((at) => [key(at), { id: key(at), at, edges: [] }]));
  for (let index = 1; index < coords.length; index++) {
    const from = graph.get(key(coords[index - 1])), to = graph.get(key(coords[index]));
    from.edges.push({ to: to.id, weight: 150, highway: 'residential', coords: [from.at, to.at], oneway: false });
    to.edges.push({ to: from.id, weight: 150, highway: 'residential', coords: [to.at, from.at], oneway: false });
  }
  const regenerate = new GeneratorService({});
  let requestedBoundary;
  regenerate.fetchOsm = async (boundaries) => { requestedBoundary = boundaries[0]; return { elements: [] }; };
  regenerate.buildRoadGraph = async () => graph;
  const regenerated = await regenerate.fromCache(cached, {}, 'regenerate');
  assert.equal(requestedBoundary.outer[0][0], cached.pop[0] - 0.015);
  assert.equal(regenerated.state.roads.length, 2);
  assert.equal(regenerated.state.cables.filter((cable) => cable.type === 'feeder').length, 1);
  assert.equal(regenerated.state.cables.filter((cable) => cable.type === 'distribution').length, 1);
  const incomplete = normalizeCachedState({ ...referenceImplementationState, distribution_segments: { 'ODP-001': { ...referenceImplementationState.distribution_segments['ODP-001'], connected: false } } });
  assert.equal(incomplete.networkComplete, false);
  const repairedHomepass = await regenerate.fromCache(incomplete, {}, 'homepass');
  assert.equal(repairedHomepass.state.cables.filter((cable) => cable.type === 'feeder').length, 1);
  assert.equal(repairedHomepass.state.cables.filter((cable) => cable.type === 'distribution').length, 1);
  assert.equal(repairedHomepass.state.cables.filter((cable) => cable.type === 'homepass').length, 1);
});

test('Nest resolves reference implementation cache under the default project scope without masking a corrupt project cache', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ftth-parity-'));
  const scoped = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);
  const controller = new GenerationController({}, {}, {});
  controller.cacheRoot = root;
  const state = { version: 4, pop: { lat: 0, lon: 0 }, odcs: [], feeder_segments: [], distribution_segments: {} };
  const defaultDir = resolve(root, scoped('user'), scoped('default-project'), scoped('batch'), scoped('item'));
  await mkdir(defaultDir, { recursive: true });
  await writeFile(resolve(defaultDir, 'design_state.json'), JSON.stringify(state));
  const resolved = await controller.resolveCacheFile('user', 'project', 'batch', 'item');
  assert.equal(resolved.path, resolve(defaultDir, 'design_state.json'));
  assert.equal(resolved.state.legacyCache, true);
  const projectDir = resolve(root, scoped('user'), scoped('project'), scoped('batch'), scoped('item'));
  await mkdir(projectDir, { recursive: true });
  await writeFile(resolve(projectDir, 'design_state.json'), '{');
  await assert.rejects(controller.resolveCacheFile('user', 'project', 'batch', 'item'), /rusak atau tidak didukung/);
  await rm(root, { recursive: true, force: true });
});

test('project pagination honors reference implementation limits above 100', async () => {
  let offset, limit;
  const query = {
    where() { return this; }, orderBy() { return this; },
    offset(value) { offset = value; return this; },
    async limit(value) { limit = value; return []; },
  };
  const controller = new ProjectsController({ select: () => ({ from: () => query }) });
  await controller.list({ user: { id: 'user-1', role: 'engineer' } }, '25', '250');
  assert.equal(offset, 25);
  assert.equal(limit, 250);
});

test('integer query and path parameters return previous API-style validation errors', () => {
  assert.equal(integerParameter('0', 'query', 'limit'), 0);
  assert.equal(integerParameter('250', 'query', 'limit'), 250);
  assert.throws(() => integerParameter('1.5', 'query', 'skip'), (error) => {
    assert.equal(error.getStatus(), 422);
    assert.deepEqual(error.getResponse().detail[0].loc, ['query', 'skip']);
    return true;
  });
  assert.throws(() => integerParameter(undefined, 'query', 'v1'), (error) => {
    assert.equal(error.getStatus(), 422);
    assert.deepEqual(error.getResponse().detail[0].loc, ['query', 'v1']);
    return true;
  });
});

test('version export validates artifact type before looking up the version like reference implementation', async () => {
  const db = { select: () => ({ from: (table) => ({ where: () => ({ async limit() { return table === projects ? [{ id: 'project-1', userId: 'user-1' }] : []; } }) }) }) };
  const controller = new VersionsController(db, {});
  await assert.rejects(controller.export('project-1', '999', 'pdf', { user: { id: 'user-1', role: 'engineer' } }, { setHeader() {} }), (error) => {
    assert.equal(error.getStatus(), 404);
    assert.equal(error.getResponse().error.code, 'ARTIFACT_NOT_FOUND');
    return true;
  });
});

test('audit authorization failures preserve reference implementation error envelopes', async () => {
  const db = { select: () => ({ from: () => ({ where: () => ({ async limit() { return []; } }) }) }) };
  const controller = new AuditController(db);
  await assert.rejects(controller.projectAudit('missing', { user: { id: 'user-1', role: 'engineer' } }), (error) => {
    assert.equal(error.getStatus(), 404);
    assert.deepEqual(error.getResponse(), { success: false, error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found or access denied' } });
    return true;
  });
  await assert.rejects(controller.accountAudit({ user: { id: 'user-1', role: 'engineer' } }), (error) => {
    assert.equal(error.getStatus(), 403);
    assert.deepEqual(error.getResponse(), { success: false, error: { code: 'UNAUTHORIZED', message: 'Admin access required' } });
    return true;
  });
});

test('upload and generation share reference implementation fixed-window rate limits and Retry-After', async () => {
  const oldLimit = process.env.GENERATION_RATE_LIMIT, oldWindow = process.env.GENERATION_RATE_WINDOW_SECONDS;
  process.env.GENERATION_RATE_LIMIT = '1';
  process.env.GENERATION_RATE_WINDOW_SECONDS = '60';
  try {
    let count = 0;
    const limiter = new GenerationRateLimiter({ async query(statement) {
      if (statement.startsWith('\n        INSERT INTO generation_rate_limit')) return { rows: [{ count: ++count }] };
      return { rows: [] };
    } });
    const generation = new GenerationController({}, {}, {}, limiter), files = new FilesController({}, limiter);
    const headers = {}, req = { user: { id: 'shared-user', role: 'engineer' }, res: { setHeader(name, value) { headers[name] = value; } } };
    await generation.generationUser(req);
    await assert.rejects(files.requireGeneration(req), (error) => error.getStatus() === 429);
    assert.ok(Number(headers['Retry-After']) > 0);
  } finally {
    if (oldLimit === undefined) delete process.env.GENERATION_RATE_LIMIT; else process.env.GENERATION_RATE_LIMIT = oldLimit;
    if (oldWindow === undefined) delete process.env.GENERATION_RATE_WINDOW_SECONDS; else process.env.GENERATION_RATE_WINDOW_SECONDS = oldWindow;
  }
});

test('job cancellation does not consume the reference implementation generation rate limit', async () => {
  const controller = new GenerationController({}, {}, {}, { async consume() { throw new Error('should not be called'); } });
  const activeJob = new AbortController();
  controller.abortControllers.set('job-1', activeJob);
  controller.jobState = async () => ({ user_id: 'owner', done: false, status: 'RUNNING' });
  let update;
  controller.update = async (_jobId, value) => { update = value; };
  const result = await controller.cancel('job-1', { user: { id: 'owner', role: 'engineer' } });
  assert.deepEqual(result, { success: true, data: { job_id: 'job-1', status: 'CANCELED' } });
  assert.equal(update.status, 'CANCELED');
  assert.equal(activeJob.signal.aborted, true);
});

test('cancel aborts active generation and preserves the CANCELED terminal status', async () => {
  let locked = false, status = 'QUEUED', signal, uploaded = 0, enterGenerator;
  const entered = new Promise((resolve) => { enterGenerator = resolve; });
  const pool = { async connect() {
    return {
      async query(statement) {
        if (statement.includes('pg_try_advisory_lock')) { locked = true; return { rows: [{ locked: true }] }; }
        if (statement.includes('pg_advisory_unlock')) { locked = false; return { rows: [{ pg_advisory_unlock: true }] }; }
        throw new Error('Unexpected database command');
      },
      release() {},
    };
  } };
  const db = { update() { return { set(value) { return { where() { return { async returning() {
    if (value.status === 'RUNNING' && status === 'QUEUED') { status = 'RUNNING'; return [{ id: 'cancel-job' }]; }
    return [];
  } }; } }; } }; } };
  const generator = { async generateCustom(_bytes, _name, _options, _checkpoint, signalValue) {
    signal = signalValue; enterGenerator();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    throw signal.reason;
  } };
  const controller = new GenerationController(db, { async upload() { uploaded++; } }, generator, {}, pool);
  controller.jobState = async () => ({ user_id: 'owner', done: false, status });
  controller.update = async (_id, value) => { status = value.status ?? status; };
  const running = controller.run('cancel-job', { id: 'owner', role: 'engineer' }, {
    operation: 'custom', custom: { buffer: Buffer.from('<kml/>'), originalname: 'custom.kml' }, options: {},
  });
  await entered;
  await controller.cancel('cancel-job', { user: { id: 'owner', role: 'engineer' } });
  await running;
  assert.equal(signal.aborted, true);
  assert.equal(status, 'CANCELED');
  assert.equal(uploaded, 0);
  assert.equal(locked, false);
});

test('generation job advisory lock prevents two Nest instances executing the same job', async () => {
  let locked = false, status = 'QUEUED', executions = 0, enterGenerator, finishGenerator;
  const entered = new Promise((resolve) => { enterGenerator = resolve; });
  const gate = new Promise((resolve) => { finishGenerator = resolve; });
  const pool = { async connect() {
    return {
      async query(statement) {
        if (statement.includes('pg_try_advisory_lock')) {
          if (locked) return { rows: [{ locked: false }] };
          locked = true; return { rows: [{ locked: true }] };
        }
        if (statement.includes('pg_advisory_unlock')) { locked = false; return { rows: [{ pg_advisory_unlock: true }] }; }
        throw new Error('Unexpected database command');
      },
      release() {},
    };
  } };
  const db = {
    update() {
      return {
        set(value) {
          return {
            where() {
              return {
                async returning() {
                  if (value.status === 'RUNNING' && status === 'QUEUED') { status = 'RUNNING'; return [{ id: 'job-1' }]; }
                  return [];
                },
              };
            },
          };
        },
      };
    },
  };
  const result = { kmz: Buffer.from('kmz'), csv: Buffer.from('csv'), state: { odcs: [], odps: [], customers: [], cables: [] }, stats: {}, validation: {}, metadata: {} };
  const controller = new GenerationController(db, { async upload() {} }, { async generateCustom() { executions++; enterGenerator(); await gate; return result; } }, {}, pool);
  controller.cacheRoot = await mkdtemp(resolve(tmpdir(), 'ftth-job-lock-'));
  controller.update = async (_id, value) => { if (value.status) status = value.status; };
  controller.recordVersion = async () => {};
  const user = { id: 'owner', role: 'engineer' }, input = { operation: 'custom', custom: { buffer: Buffer.from('<kml/>'), originalname: 'custom.kml' }, options: {}, kmzName: 'design.kmz', csvName: 'design.csv' };
  try {
    const first = controller.run('job-1', user, input);
    await entered;
    await controller.run('job-1', user, input);
    assert.equal(executions, 1);
    finishGenerator();
    await first;
    assert.equal(status, 'COMPLETED');
    assert.equal(locked, false);
  } finally {
    finishGenerator();
    await rm(controller.cacheRoot, { recursive: true, force: true });
  }
});

test('stale jobs are recovered only after the PostgreSQL execution lock is free', async () => {
  let workerLockHeld = true, requeued = 0;
  const pool = { async connect() {
    return {
      async query(statement) {
        if (statement.includes('pg_try_advisory_lock')) {
          if (workerLockHeld) return { rows: [{ locked: false }] };
          workerLockHeld = true; return { rows: [{ locked: true }] };
        }
        if (statement.includes('pg_advisory_unlock')) { workerLockHeld = false; return { rows: [{ pg_advisory_unlock: true }] }; }
        throw new Error('Unexpected database command');
      },
      release() {},
    };
  } };
  const db = {
    select() { return { from() { return { where() { return { async limit() { return [{ id: 'stale-job' }]; } }; } }; } }; },
    update() { return { set(value) { return { async where() { if (value.status === 'QUEUED') requeued++; } }; } }; },
  };
  const controller = new GenerationController(db, {}, {}, {}, pool);
  await controller.recoverStaleJobs();
  assert.equal(requeued, 0);
  workerLockHeld = false;
  await controller.recoverStaleJobs();
  assert.equal(requeued, 1);
  assert.equal(workerLockHeld, false);
});

test('generation progress stream authorizes before subscribing and emits a terminal state once', async () => {
  const controller = new GenerationController({}, {}, {});
  controller.jobState = async () => ({ user_id: 'owner', stage: 'COMPLETED', message: 'done', percent: 100, done: true });
  await assert.rejects(controller.progressStream('job-1', { user: { id: 'other' } }), (error) => error.getStatus() === 403);
  const stream = await controller.progressStream('job-1', { user: { id: 'owner' } });
  const events = [];
  const subscription = stream.subscribe((event) => events.push(event.data));
  await new Promise((resolve) => setTimeout(resolve, 10));
  subscription.unsubscribe();
  assert.deepEqual(events, [{ user_id: 'owner', stage: 'COMPLETED', message: 'done', percent: 100, done: true }]);
});

test('capacitated clustering matches reference implementation cluster membership and sizing', () => {
  const points = Array.from({ length: 25 }, (_, index) => [index, index]);
  const normalize = (clusters) => clusters.map((cluster) => [...cluster].sort((a, b) => a - b));
  assert.deepEqual(normalize(capacitatedClusters(points, 10)), [[15, 16, 17, 18, 19, 20, 21, 22, 23, 24], [5, 6, 7, 8, 9, 10, 11, 12, 13, 14], [0, 1, 2, 3, 4]]);
  assert.deepEqual(normalize(capacitatedClusters(points.slice(0, 11), 10, 5)), [[5, 6, 7, 8, 9, 10], [0, 1, 2, 3, 4]]);
  assert.deepEqual(capacitatedClusters(Array.from({ length: 25 }, () => [0, 0]), 4), [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15], [16, 17, 18, 19], [20, 21, 22, 23], [24]]);
  assert.deepEqual(capacitatedClusters(Array.from({ length: 33 }, (_, index) => [index % 2, 0]), 5), [[1, 3, 5, 7, 9], [11, 13, 15, 17, 19], [21, 23, 25, 27, 29], [31, 0, 2, 4, 6], [8, 10, 12, 14, 16], [18, 20, 22, 24, 26], [28, 30, 32]]);
  assert.deepEqual(capacitatedClusters(Array.from({ length: 40 }, (_, index) => [(index * 31) % 40, (index * 17) % 40]), 10), [
    [7, 21, 2, 16, 28, 30, 11, 35, 25, 37],
    [39, 13, 4, 8, 34, 20, 22, 3, 17, 29],
    [12, 26, 38, 31, 33, 0, 24, 15, 19, 10],
    [1, 27, 6, 32, 36, 18, 5, 23, 9, 14],
  ]);
  assert.throws(() => capacitatedClusters(points.slice(0, 4), 10, 5), (error) => error.getStatus() === 400);
});

test('road assignment costs use reference implementation half-to-even rounding', () => {
  assert.equal(roundHalfEven(2.5), 2);
  assert.equal(roundHalfEven(3.5), 4);
  assert.equal(roundHalfEven(3.5000001), 4);
  assert.equal(roundHalfEven(-2.5), -2);
});

test('road rebalancing keeps feasible global assignments when other ODPs need recovery ODCs', () => {
  const positions = [[0, 0], [0.01, 0], [0.02, 0], [0.04, 0]];
  const graph = new Map(positions.map((at, index) => [at.join(','), { id: at.join(','), at, edges: [] }]));
  const nodes = [...graph.values()];
  for (let index = 1; index < nodes.length; index++) {
    const left = nodes[index - 1], right = nodes[index], weight = Math.abs(right.at[0] - left.at[0]) * 111_000;
    left.edges.push({ to: right.id, weight, highway: 'residential', coords: [left.at, right.at], oneway: false });
    right.edges.push({ to: left.id, weight, highway: 'residential', coords: [right.at, left.at], oneway: false });
  }
  const odps = [
    { label: 'ODP-1', at: [0.001, 0], members: [] },
    { label: 'ODP-2', at: [0.019, 0], members: [] },
    { label: 'ODP-3', at: [0.04, 0], members: [] },
  ];
  const odcs = [
    { label: 'ODC-A', at: positions[0], members: ['ODP-2'] },
    { label: 'ODC-B', at: positions[1], members: ['ODP-1'] },
    { label: 'ODC-C', at: positions[2], members: ['ODP-3'] },
  ];
  rebalanceOdpsByRoadConnectivity(graph, odcs, odps, 500, 1, new Map());
  assert.equal(odcs.find((odc) => odc.members.includes('ODP-1')).label, 'ODC-A');
  assert.equal(odcs.find((odc) => odc.members.includes('ODP-2')).label, 'ODC-C');
  assert.equal(odcs.filter((odc) => odc.label.startsWith('ODC-RECOVERY-')).length, 1);
});

test('road assignment keeps reference implementation ODC-grouped ODP order for equal-cost ties', () => {
  const graph = new Map();
  addEdge(graph, [0, 0], [1, 0], 'residential', 'shortest', false, 100);
  const odps = [
    { label: 'ODP-001', at: [0.5, 0], members: [] },
    { label: 'ODP-002', at: [0.5, 0], members: [] },
  ];
  const odcs = [
    { label: 'ODC-A', at: [0.5, 0], members: ['ODP-002'] },
    { label: 'ODC-B', at: [0.5, 0], members: ['ODP-001'] },
  ];
  rebalanceOdpsByRoadConnectivity(graph, odcs, odps, 500, 1, new Map());
  assert.deepEqual(odcs.map(({ label, members }) => [label, members]), [
    ['ODC-A', ['ODP-001']], ['ODC-B', ['ODP-002']],
  ]);
});

test('road rebalancing creates a recovery ODC when every existing route exceeds the reference implementation limit', () => {
  const from = [0, 0], to = [0.01, 0];
  const graph = new Map([
    [from.join(','), { id: from.join(','), at: from, edges: [{ to: to.join(','), weight: 1112, highway: 'residential', coords: [from, to], oneway: false }] }],
    [to.join(','), { id: to.join(','), at: to, edges: [{ to: from.join(','), weight: 1112, highway: 'residential', coords: [to, from], oneway: false }] }],
  ]);
  const odp = { label: 'ODP-STRANDED', at: to, members: [] };
  const odcs = [{ label: 'ODC-001', at: from, members: [odp.label] }];
  rebalanceOdpsByRoadConnectivity(graph, odcs, [odp], 500, 1, new Map());
  const recovery = odcs.find((odc) => odc.label.startsWith('ODC-RECOVERY-'));
  assert.ok(recovery);
  assert.deepEqual(recovery.members, [odp.label]);
  assert.deepEqual(odcs[0].members, []);
  assert.ok(recovery.at.some((coordinate, index) => coordinate !== odp.at[index]));
});

test('batch status keeps one latest retry per item and matches reference implementation aggregate counts', () => {
  const rows = latestBatchRows([
    { id: 'old-failed', itemId: 'item-1', status: 'FAILED', createdAt: new Date('2026-01-01T00:00:00Z') },
    { id: 'completed', itemId: 'item-2', status: 'COMPLETED', createdAt: new Date('2026-01-01T00:01:00Z') },
    { id: 'retry-queued', itemId: 'item-1', status: 'QUEUED', createdAt: new Date('2026-01-01T00:02:00Z') },
    { id: 'skipped', itemId: 'item-3', status: 'SKIPPED', createdAt: new Date('2026-01-01T00:03:00Z') },
  ]);
  assert.deepEqual(rows.map((row) => row.id), ['skipped', 'retry-queued', 'completed']);
  assert.deepEqual(summarizeBatchJobs(rows), { total: 3, completed: 1, failed: 1, status: 'RUNNING' });
  assert.deepEqual(summarizeBatchJobs(rows.map((row) => row.id === 'retry-queued' ? { ...row, status: 'CANCELED' } : row)), { total: 3, completed: 1, failed: 2, status: 'COMPLETED' });
});

test('batch retry preserves the item metadata and reference implementation output filenames', async () => {
  const old = {
    id: 'old-job', userId: 'user-1', projectId: 'project-1', status: 'FAILED', itemId: 'item-1',
    result: {
      input_paths: { boundary: '/cache/boundary.kml', pop: '/cache/pop.kml' },
      options: { include_homepass: false }, batch_item: { design_name: 'area-a', boundary_name: 'area-a.kml' },
      kmz_url: '/api/files/FTTH_area-a_core.kmz', csv_url: '/api/files/FTTH_area-a_core.csv',
    },
  };
  const query = { where() { return this; }, orderBy() { return this; }, async limit() { return [old]; } };
  const controller = new GenerationController({ select: () => ({ from: () => query }) }, {}, {});
  controller.generationUser = () => ({ id: 'user-1' });
  let queued;
  controller.enqueue = async (_user, input, batchId, itemId) => { queued = { input, batchId, itemId }; return 'retry-job'; };
  const response = await controller.retryBatch('batch-1', 'item-1', {});
  assert.equal(response.data.job_id, 'retry-job');
  assert.equal(queued.batchId, 'batch-1');
  assert.equal(queued.itemId, 'item-1');
  assert.equal(queued.input.kmzName, 'FTTH_area-a_core.kmz');
  assert.equal(queued.input.csvName, 'FTTH_area-a_core.csv');
  assert.deepEqual(queued.input.batchItem, { design_name: 'area-a', boundary_name: 'area-a.kml' });
  assert.equal(queued.input.persistedInput.kmzName, 'FTTH_area-a_core.kmz');
});

test('custom ODC/ODP mapping groups follow reference implementation labels and preserve leading zeroes', () => {
  assert.equal(customMappingGroup('ODC004.ODP003', 'odp'), '004');
  assert.equal(customMappingGroup('ODP 17/01', 'odp'), '17');
  assert.equal(customMappingGroup('ODC 17', 'odc'), '17');
  assert.equal(customMappingGroup('17/01', 'odp'), undefined);
  assert.equal(outputOdpLabel('ODC004.ODP003', 1, 1), 'ODC004.ODP003');
  assert.equal(outputOdpLabel('ODP-001', 2, 4), 'ODC002.ODP004');
});

test('custom KML point roles follow reference implementation placemark, description, folder, and POP fallback order', () => {
  const at = [106, -6];
  const points = classifyCustomPoints([
    { name: 'ODC-01', point: at, folderContext: 'OLT Sites' },
    { name: 'ODP-01', point: at, folderContext: 'ODC-01' },
    { name: 'SENTRAL-02', point: at },
    { name: 'House 1', point: at, description: 'HC', folderContext: 'POP area' },
  ]);
  assert.equal(points.odcs.length, 1);
  assert.equal(points.odps.length, 1);
  assert.equal(points.customers.length, 1);
  assert.equal(points.pop.label, 'ODC-01');

  const fallback = classifyCustomPoints([{ name: 'SENTRAL-02', point: at }]);
  assert.equal(fallback.pop.label, 'SENTRAL-02');
});

test('custom generation uses reference implementation defaults and buffered road coverage', async () => {
  const generator = new GeneratorService({});
  let strategy, queried, refresh;
  generator.fetchOsm = async (rings, forceRefresh) => { queried = rings[0].outer; refresh = forceRefresh; return { elements: [], metadata: {} }; };
  generator.buildRoadGraph = async (_elements, value) => {
    strategy = value;
    const a = { id: 'a', at: [106, -6], edges: [] }, b = { id: 'b', at: [106.003, -6], edges: [] };
    a.edges.push({ to: 'b', weight: 334, highway: 'residential', coords: [a.at, b.at], oneway: false });
    b.edges.push({ to: 'a', weight: 334, highway: 'residential', coords: [b.at, a.at], oneway: false });
    return new Map([[a.id, a], [b.id, b]]);
  };
  const kml = Buffer.from('<kml><Document><Placemark><name>OLT</name><Point><coordinates>106,-6,0</coordinates></Point></Placemark><Placemark><name>ODC 1</name><Point><coordinates>106.001,-6,0</coordinates></Point></Placemark><Placemark><name>ODP 1/1</name><Point><coordinates>106.002,-6,0</coordinates></Point></Placemark><Placemark><name>HC 1</name><Point><coordinates>106.0021,-6,0</coordinates></Point></Placemark></Document></kml>');
  const result = await generator.generateCustom(kml, 'custom.kml', {
    routing_strategy: 'shortest', max_distribution_length_m: 50, odp_capacity: 2,
    odc_capacity: 2, include_homepass: false, force_refresh_osm: true,
  });
  assert.equal(strategy, 'priority_road');
  assert.deepEqual(queried[0], [105.985, -6.015]);
  assert.deepEqual(queried[2], [106.0171, -5.985]);
  assert.equal(refresh, false);
  assert.equal(result.state.cables.filter((cable) => cable.type === 'homepass').length, 1);
  const output = await JSZip.loadAsync(result.kmz);
  const kmlOutput = await output.file('doc.kml').async('string');
  assert.match(kmlOutput, /Splitter: 1:10/);
  assert.match(kmlOutput, /Splitter: 1:4/);
});

test('custom generation assigns ODPs before snapping like reference implementation', async () => {
  const generator = new GeneratorService({});
  generator.fetchOsm = async () => ({
    elements: [{ type: 'way', id: 1, tags: { highway: 'residential' }, geometry: [[106, -6], [106.006, -6]] }],
    metadata: { source: 'fixture' },
  });
  const kml = Buffer.from('<kml><Document><Placemark><name>OLT</name><Point><coordinates>106,-6,0</coordinates></Point></Placemark><Placemark><name>ODC 1</name><Point><coordinates>106,-6,0</coordinates></Point></Placemark><Placemark><name>ODC 2</name><Point><coordinates>106.010,-6,0</coordinates></Point></Placemark><Placemark><name>ODP-A</name><Point><coordinates>106.0044,-6,0</coordinates></Point></Placemark><Placemark><name>ODP-B</name><Point><coordinates>106.0052,-6,0</coordinates></Point></Placemark></Document></kml>');
  const result = await generator.generateCustom(kml, 'custom.kml', {});
  assert.deepEqual(result.state.odcs.map((odc) => [odc.label, odc.members]), [['ODC-001', ['ODP-A']], ['ODC-002', ['ODP-B']]]);
  const zip = await JSZip.loadAsync(result.kmz), output = await zip.file('doc.kml').async('string');
  const coordinates = (name) => {
    const mark = [...output.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)].map((match) => match[1]).find((body) => body.includes(`<name>${name}</name>`));
    return [...(mark ?? '').matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/g)].map((match) => match[1].trim().split(/\s+/).map((point) => point.split(',').slice(0, 2).map(Number)));
  };
  assert.deepEqual(coordinates('OLT-ODC-001-ODC-002'), [[
    [106, -6], [106, -6], [106, -6], [106, -6], [106, -6], [106.006, -6], [106.006, -6],
  ]]);
  assert.deepEqual(coordinates('Distribution Route'), [
    [[106, -6], [106, -6], [106.0044, -6], [106.0044, -6]],
    [[106.006, -6], [106.006, -6], [106.0052, -6], [106.0052, -6]],
  ]);
});

test('road snapping matches reference implementation edge selection at a shared-node tie', async () => {
  const generator = new GeneratorService({});
  generator.fetchOsm = async () => ({ elements: [
    { type: 'way', id: 1, tags: { highway: 'residential' }, geometry: [[7.4202779, 43.7371818], [7.4203277, 43.7371604]] },
    { type: 'way', id: 2, tags: { highway: 'residential' }, geometry: [[7.4203277, 43.7371604], [7.420362, 43.7371353]] },
  ], metadata: { source: 'fixture' } });
  const kml = Buffer.from('<kml><Document><Placemark><name>OLT</name><Point><coordinates>7.42016,43.73708,0</coordinates></Point></Placemark><Placemark><name>ODC 1</name><Point><coordinates>7.4203978,43.73721925,0</coordinates></Point></Placemark><Placemark><name>ODP 1/1</name><Point><coordinates>7.4203978,43.73721925,0</coordinates></Point></Placemark><Placemark><name>HC 1</name><Point><coordinates>7.4203978,43.73721925,0</coordinates></Point></Placemark></Document></kml>');
  const result = await generator.generateCustom(kml, 'snap-tie.kml', {});
  const [lon, lat] = result.state.odcs[0].at;
  assert.ok(Math.abs(lon - 7.420345306542207) < 1e-12);
  assert.ok(Math.abs(lat - 43.73714751591226) < 1e-12);
});

test('multipart boundaries use the PostGIS union before generation', async () => {
  const merged = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]] };
  const generator = new GeneratorService({ execute: async () => ({ rows: [{ geometry: JSON.stringify(merged) }] }) });
  const result = await generator.unionBoundaries([
    { outer: [[0, 0], [1, 0], [1, 1], [0, 0]], holes: [] },
    { outer: [[1, 0], [2, 0], [2, 1], [1, 0]], holes: [] },
  ]);
  assert.deepEqual(result, [{ outer: merged.coordinates[0], holes: [] }]);
});

test('OSM dataset timestamps match reference implementation direct import and updater paths', () => {
  const modified = new Date('2025-01-01T00:00:00Z');
  assert.equal(datasetSourceTimestamp({ source_timestamp: '2025-02-01T00:00:00Z', downloaded_at: '2025-03-01T00:00:00Z' }, modified).toISOString(), '2025-02-01T00:00:00.000Z');
  assert.equal(datasetSourceTimestamp({ downloaded_at: '2025-03-01T00:00:00Z' }, modified), modified);
  assert.equal(datasetSourceTimestamp({ downloaded_at: '2025-03-01T00:00:00Z' }, modified, true).toISOString(), '2025-03-01T00:00:00.000Z');
  assert.equal(datasetSourceTimestamp({ source_timestamp: 'invalid' }, modified), modified);
  assert.equal(datasetSourceTimestamp({}, modified), modified);
});

test('PBF download timeout resets when data keeps arriving like reference implementation socket timeout', async () => {
  const originalFetch = global.fetch;
  const root = await mkdtemp(resolve(tmpdir(), 'ftth-pbf-download-'));
  let timer, streamController;
  global.fetch = async (_url, { signal }) => {
    const body = new ReadableStream({
      start(controller) {
        streamController = controller;
        let index = 0;
        const send = () => {
          if (index === 5) { controller.close(); return; }
          controller.enqueue(Buffer.from('ab'[index % 2]));
          index++;
          timer = setTimeout(send, 25);
        };
        send();
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          controller.error(new Error('request timed out'));
        }, { once: true });
      },
    });
    return new Response(body);
  };
  try {
    const output = resolve(root, 'region.osm.pbf');
    await downloadOsmPbf('https://example.test/region.osm.pbf', output, 0.06);
    assert.equal((await readFile(output)).toString(), 'ababa');
  } finally {
    global.fetch = originalFetch;
    clearTimeout(timer);
    await rm(root, { recursive: true, force: true });
  }
});

test('PBF importer worker count follows reference implementation integer parsing and osm2pgsql bounds', () => {
  assert.equal(importWorkerCount(undefined), 1);
  assert.equal(importWorkerCount(' 2 '), 2);
  assert.equal(importWorkerCount('1_5'), 15);
  assert.equal(importWorkerCount('0'), 1);
  assert.equal(importWorkerCount('-3'), 1);
  assert.equal(importWorkerCount('2.5'), 1);
  assert.equal(importWorkerCount('invalid'), 1);
  assert.equal(importWorkerCount('100'), 32);
});

test('PBF importer matches reference OSM importer POI filtering and captures multipolygon buildings', () => {
  assert.match(flexStyle, /function osm2pgsql\.process_relation\(object\)[\s\S]*?object:as_multipolygon\(\)[\s\S]*?buildings:insert/);
  assert.doesNotMatch(flexStyle, /building_nodes/);
  assert.match(flexStyle, /building_members:insert\(\{ way_id = member\.ref \}\)/);
  assert.doesNotMatch(flexStyle, /return 'main_road'/);
  assert.match(flexStyle, /if tags\.railway or tags\.building == 'train_station' then return 'station' end/);
  assert.match(flexStyle, /if tags\.office or tags\.building == 'office' then return 'office' end/);
  assert.match(flexStyle, /if poi_kind\(tags\) then/);
  assert.match(flexStyle, /oneway = tags\.oneway == 'yes'.*tags\.oneway == '-1'/);
  assert.doesNotMatch(flexStyle, /tags\.junction == 'roundabout'/);
  assert.match(flexStyle, /ipairs\(\{'motorcar', 'motor_vehicle', 'vehicle', 'access'\}\)/);
  assert.match(flexStyle, /value:gmatch\('\[\^;\]\+'\)/);
  assert.match(flexStyle, /drive\[tags\.highway\] and tags\.area ~= 'yes' and has_driving_access\(tags\)/);
  assert.match(flexStyle, /emergency_access_point=true, bridge=true/);
});

test('auto OSM source uses online providers instead of requiring a local PBF dataset', async () => {
  const names = ['OSM_SOURCE_MODE', 'OSM_ONLINE_MAX_AREA_KM2', 'OSM_ONLINE_MAX_TILES', 'OSM_TILE_SIZE_DEG'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const generator = new GeneratorService({});
  let localCalls = 0;
  generator.fetchNativeOsm = async () => ({ elements: [
    { type: 'way', id: 1, tags: { building: 'yes' } },
    { type: 'node', id: 2, tags: { railway: 'station' } },
  ], metadata: { source: 'osm_native' } });
  generator.fetchLocal = async () => { localCalls++; return { elements: [], metadata: { source: 'osm_local' } }; };
  process.env.OSM_SOURCE_MODE = 'auto';
  process.env.OSM_ONLINE_MAX_AREA_KM2 = 'invalid';
  process.env.OSM_ONLINE_MAX_TILES = '100';
  process.env.OSM_TILE_SIZE_DEG = '0.15';
  try {
    const result = await generator.fetchOsm([{ outer: [[0, 0], [0.15, 0], [0.15, 0.02], [0, 0.02], [0, 0]], holes: [] }]);
    assert.equal(result.metadata.source, 'osm_native');
    assert.equal(localCalls, 0);
  } finally {
    for (const name of names) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name];
  }
});

test('auto OSM source does not query PostGIS before online providers for large boundaries', async () => {
  const names = ['OSM_SOURCE_MODE', 'OSM_ONLINE_MAX_AREA_KM2', 'OSM_ONLINE_MAX_TILES', 'OSM_NATIVE_URL', 'OSM_NATIVE_RETRIES', 'OSM_CACHE_MAX_AGE_SECONDS'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = global.fetch;
  const requests = [];
  process.env.OSM_SOURCE_MODE = 'auto';
  process.env.OSM_ONLINE_MAX_AREA_KM2 = '0.1';
  process.env.OSM_ONLINE_MAX_TILES = '1';
  process.env.OSM_NATIVE_URL = 'https://native.test/api/0.6/map';
  process.env.OSM_NATIVE_RETRIES = '1';
  process.env.OSM_CACHE_MAX_AGE_SECONDS = '0';
  global.fetch = async (url) => {
    requests.push(String(url));
    return new Response('<osm version="0.6"><node id="1" lat="-6" lon="106"><tag k="building" v="yes"/></node><node id="2" lat="-6.001" lon="106.001"><tag k="railway" v="station"/></node></osm>', { status: 200 });
  };
  try {
    const generator = new GeneratorService({});
    const order = [];
    generator.fetchLocal = async () => { order.push('local'); throw new Error('no active local dataset'); };
    const fetchNative = generator.fetchNativeOsm.bind(generator);
    generator.fetchNativeOsm = async (...args) => { order.push('online'); return fetchNative(...args); };
    const result = await generator.fetchOsm([{ outer: [[106, -6], [106.01, -6], [106.01, -5.99], [106, -5.99], [106, -6]], holes: [] }]);
    assert.deepEqual(order, ['online']);
    assert.equal(result.metadata.source, 'osm_native');
    assert.ok(requests.length > 0);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('auto OSM source uses online providers without querying PostGIS when buildings are required', async () => {
  const names = ['OSM_SOURCE_MODE', 'OSM_ONLINE_MAX_AREA_KM2', 'OSM_ONLINE_MAX_TILES'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.OSM_SOURCE_MODE = 'auto';
  process.env.OSM_ONLINE_MAX_AREA_KM2 = '0.1';
  process.env.OSM_ONLINE_MAX_TILES = '1';
  try {
    const generator = new GeneratorService({});
    let localCalls = 0, onlineCalls = 0;
    generator.fetchLocal = async () => { localCalls++; return { elements: [], metadata: { source: 'osm_postgis' } }; };
    generator.fetchNativeOsm = async () => {
      onlineCalls++;
      return { elements: [{ tags: { building: 'yes' } }, { tags: { railway: 'station' } }], metadata: { source: 'osm_native' } };
    };
    const result = await generator.fetchOsm([{ outer: [[106, -6], [106.01, -6], [106.01, -5.99], [106, -5.99], [106, -6]], holes: [] }], false, undefined, undefined, undefined, true);
    assert.equal(localCalls, 0);
    assert.equal(onlineCalls, 1);
    assert.equal(result.metadata.source, 'osm_native');
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('auto CORE cache signature uses online OSM without requiring a local dataset', async () => {
  const names = ['OSM_SOURCE_MODE', 'OSM_ONLINE_MAX_AREA_KM2', 'OSM_ONLINE_MAX_TILES'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.OSM_SOURCE_MODE = 'auto';
  process.env.OSM_ONLINE_MAX_AREA_KM2 = '0.1';
  process.env.OSM_ONLINE_MAX_TILES = '1';
  try {
    const generator = new GeneratorService({ async execute() { throw new Error('auto mode must not query local datasets'); } });
    assert.equal(await generator.coreSourceSignature(await readFile(sample('boundary.kml')), 'boundary.kml'), 'osm_online');
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('auto CORE cache signature falls back to online when no local dataset covers the boundary', async () => {
  const names = ['OSM_SOURCE_MODE', 'OSM_ONLINE_MAX_AREA_KM2', 'OSM_ONLINE_MAX_TILES'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.OSM_SOURCE_MODE = 'auto';
  process.env.OSM_ONLINE_MAX_AREA_KM2 = '0.1';
  process.env.OSM_ONLINE_MAX_TILES = '1';
  try {
    let query = 0;
    const generator = new GeneratorService({ async execute() {
      query++;
      return { rows: query === 1 ? [] : [] };
    } });
    assert.equal(await generator.coreSourceSignature(await readFile(sample('boundary.kml')), 'boundary.kml'), 'osm_online');
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('OSM source thresholds accept reference implementation numeric underscores', () => {
  const names = ['OSM_SOURCE_MODE', 'OSM_ONLINE_MAX_AREA_KM2', 'OSM_ONLINE_MAX_TILES'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.OSM_SOURCE_MODE = 'auto';
  process.env.OSM_ONLINE_MAX_AREA_KM2 = '3_0';
  process.env.OSM_ONLINE_MAX_TILES = '1_0';
  try {
    const decision = new GeneratorService({}).sourceDecision([
      { outer: [[106, -6], [106.1, -6], [106.1, -5.98], [106, -5.98], [106, -6]], holes: [] },
    ]);
    assert.equal(decision.local, false);
  } finally {
    for (const name of names) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name];
  }
});

test('online OSM roads become two-way while local PostGIS preserves one-way tags like reference implementation', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ftth-road-direction-'));
  const previous = process.env.ROAD_GRAPH_CACHE_ROOT;
  process.env.ROAD_GRAPH_CACHE_ROOT = root;
  const generator = new GeneratorService({});
  const elements = [{ type: 'way', id: 99, tags: { highway: 'residential', oneway: 'yes' }, geometry: [[106, -6], [106.001, -6]] }];
  const hasEdge = (graph, from, to) => graph.get(`${from[0].toFixed(7)},${from[1].toFixed(7)}`)?.edges.some((edge) => edge.to === `${to[0].toFixed(7)},${to[1].toFixed(7)}`) ?? false;
  try {
    const online = await generator.buildRoadGraph(elements, 'shortest', [], false);
    const local = await generator.buildRoadGraph(elements, 'shortest', [], true);
    assert.equal(hasEdge(online, [106.001, -6], [106, -6]), true);
    assert.equal(hasEdge(local, [106.001, -6], [106, -6]), false);
    assert.equal(hasEdge(local, [106, -6], [106.001, -6]), true);
  } finally {
    if (previous === undefined) delete process.env.ROAD_GRAPH_CACHE_ROOT;
    else process.env.ROAD_GRAPH_CACHE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('online OSM fallback flag uses the same accepted values as reference implementation', () => {
  for (const value of ['1', 'true', 'yes', 'on', ' TRUE ']) assert.equal(localFallbackEnabled(value), true, value);
  for (const value of ['0', 'false', 'no', 'off', '', 'unexpected']) assert.equal(localFallbackEnabled(value), false, value);
  assert.equal(localFallbackEnabled(undefined), true);
});

test('OSM request timeout uses reference implementation integer parsing and lower bound', () => {
  assert.equal(osmRequestTimeoutSeconds(undefined), 15);
  assert.equal(osmRequestTimeoutSeconds(' 20 '), 20);
  assert.equal(osmRequestTimeoutSeconds('1_5'), 15);
  assert.equal(osmRequestTimeoutSeconds('0'), 1);
  assert.equal(osmRequestTimeoutSeconds('-3'), 1);
  assert.equal(osmRequestTimeoutSeconds('2.5'), 15);
  assert.equal(osmRequestTimeoutSeconds('invalid'), 15);
});

test('strategic POP preserves reference implementation OSM feature names and fallback labels', () => {
  const center = [106, -6];
  assert.deepEqual(strategicPop([
    { type: 'node', lon: 106.1, lat: -6.1, tags: { highway: 'primary', name: 'Jalan Utama Baru' } },
    { type: 'node', lon: 106.2, lat: -6.2, tags: { railway: 'station', name: 'Stasiun Kota' } },
  ], center), { name: 'Stasiun Kota', at: [106.2, -6.2] });
  assert.deepEqual(strategicPop([
    { type: 'node', lon: 106.1, lat: -6.1, tags: { office: 'yes' } },
  ], center), { name: 'Kantor POP', at: [106.1, -6.1] });
});

test('local PostGIS POP fallback labels match reference implementation', () => {
  assert.equal(localOsmPopName('station', null), 'POP OSM lokal (station)');
  assert.equal(localOsmPopName('office', ''), 'POP OSM lokal (office)');
  assert.equal(localOsmPopName('main_road', 'Jalan Asia Afrika'), 'Jalan Asia Afrika');
  assert.equal(localOsmPopName('node jalan', null), 'POP OSM lokal (node jalan)');
});

test('local PostGIS POP falls back to the boundary centroid when POI lookup fails', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ftth-local-pop-fallback-'));
  const previous = { cache: process.env.LOCAL_OSM_CACHE_ROOT, age: process.env.OSM_CACHE_MAX_AGE_SECONDS };
  process.env.LOCAL_OSM_CACHE_ROOT = root;
  process.env.OSM_CACHE_MAX_AGE_SECONDS = '0';
  const boundary = { outer: [[106, -6], [106.01, -6], [106.01, -5.99], [106, -5.99], [106, -6]], holes: [] };
  const generator = new GeneratorService({ execute: async (statement) => {
    const query = new PgDialect().sqlToQuery(statement).sql;
    if (query.includes('FROM osm_data.dataset')) return { rows: [{ dataset_id: 'fixture', source_timestamp: null, covers: true }] };
    if (query.includes('SELECT osm_id FROM osm_data.building')) return { rows: [] };
    if (query.includes('FROM osm_data.road_edge')) return { rows: [] };
    if (query.includes('FROM osm_data.poi')) throw new Error('POI table unavailable');
    return { rows: [] };
  } });
  try {
    const result = await generator.fetchLocal([boundary], undefined, true);
    assert.deepEqual(result.popCandidate, { name: 'Auto POP (Titik Tengah)', at: boundaryCentroid([boundary]) });
  } finally {
    previous.cache === undefined ? delete process.env.LOCAL_OSM_CACHE_ROOT : process.env.LOCAL_OSM_CACHE_ROOT = previous.cache;
    previous.age === undefined ? delete process.env.OSM_CACHE_MAX_AGE_SECONDS : process.env.OSM_CACHE_MAX_AGE_SECONDS = previous.age;
    await rm(root, { recursive: true, force: true });
  }
});

test('PostGIS building point lookup preserves each building index', async () => {
  const boundary = { outer: [[116, -8.6], [116.2, -8.6], [116.2, -8.4], [116, -8.4], [116, -8.6]], holes: [] };
  let returnedIndices;
  const generator = new GeneratorService({ execute: async (statement) => {
    const query = new PgDialect().sqlToQuery(statement);
    if (query.sql.includes('jsonb_to_recordset')) {
      assert.match(query.sql, /ST_AsGeoJSON\(CASE[\s\S]*?END, 15\)/);
      const inputs = JSON.parse(query.params.find((value) => typeof value === 'string' && value.startsWith('[{"idx"')));
      returnedIndices = inputs.map((input) => input.idx);
      return { rows: inputs.map(({ idx }) => ({ idx, geometry: JSON.stringify({ type: 'Point', coordinates: [116 + idx / 100, -8.575] }) })) };
    }
    return { rows: [] };
  } });
  const elements = [0, 1].map((id) => ({ id, tags: { building: 'yes' }, geometry: [[116.01, -8.58], [116.02, -8.58], [116.02, -8.57], [116.01, -8.57], [116.01, -8.58]] }));
  const points = await generator.postgisBuildingPoints(elements, [boundary]);
  assert.deepEqual(returnedIndices, [0, 1]);
  assert.deepEqual([...points], [[0, [116, -8.575]], [1, [116.01, -8.575]]]);
});

test('strategic POP recognizes building=office without an office tag like reference implementation', () => {
  const candidate = strategicPop([
    { type: 'way', id: 7, tags: { building: 'office' }, geometry: [[106, -6], [106.002, -6], [106.002, -5.998], [106, -5.998], [106, -6]] },
  ], [106.001, -5.999]);
  assert.equal(candidate.name, 'Kantor POP');
  assert.ok(Math.abs(candidate.at[0] - 106.001) < 1e-9);
  assert.ok(Math.abs(candidate.at[1] + 5.999) < 1e-9);
});

test('strategic POP uses the length centroid for linear office features like reference implementation', () => {
  const candidate = strategicPop([
    { type: 'way', id: 8, tags: { office: 'yes' }, geometry: [[106, -6], [106.001, -6], [106.003, -6]] },
  ], [106, -6]);
  assert.ok(Math.abs(candidate.at[0] - 106.0015) < 1e-9);
  assert.equal(candidate.at[1], -6);
});

test('strategic POP fallback uses the area-weighted centroid of every boundary component', () => {
  assert.deepEqual(boundaryCentroid([
    { outer: [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], holes: [] },
    { outer: [[10, 0], [13, 0], [13, 1], [10, 1], [10, 0]], holes: [] },
  ]), [8.75, 0.5]);
});

test('Native OSM is tried first and parses tagged buildings and road ways', async () => {
  const xml = '<osm><node id="1" lon="106" lat="-6"/><node id="2" lon="106.001" lat="-6"/><node id="3" lon="106.001" lat="-5.999"/><node id="4" lon="106" lat="-5.999"/><way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/><tag k="building" v="yes"/><tag k="name" v="Rumah"/></way><way id="20"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way></osm>';
  const originalFetch = global.fetch, previous = Object.fromEntries(['OSM_SOURCE_MODE', 'OSM_NATIVE_URL', 'OSM_NATIVE_RETRIES', 'OSM_CACHE_MAX_AGE_SECONDS'].map((key) => [key, process.env[key]]));
  const requests = [];
  process.env.OSM_SOURCE_MODE = 'online';
  process.env.OSM_NATIVE_URL = 'http://native.test/api/0.6/map';
  process.env.OSM_CACHE_MAX_AGE_SECONDS = '0';
  global.fetch = async (url) => { requests.push(String(url)); return String(url).includes('native.test') ? new Response(xml, { status: 200 }) : Promise.reject(new Error('Overpass should not be tried when Native OSM succeeds')); };
  try {
    const elements = parseNativeOsmXml(xml);
    assert.equal(elements.find((item) => item.id === '10').tags.building, 'yes');
    const generator = new GeneratorService({});
    const result = await generator.fetchOsm([
      { outer: [[106, -6], [106.01, -6], [106.01, -5.99], [106, -5.99], [106, -6]], holes: [] },
    ], false, [106.001, -5.999]);
    assert.equal(result.metadata.source, 'osm_native');
    assert.equal(requests.length, 1);
    assert.match(requests[0], /^http:\/\/native\.test/);
    assert.ok(result.elements.some((item) => item.tags?.building === 'yes'));
    assert.ok(result.elements.some((item) => item.tags?.highway === 'residential'));
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('empty Native OSM tiles are retried instead of becoming permanent checkpoints', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ftth-empty-osm-checkpoint-'));
  const previousFetch = global.fetch;
  const env = { cache: process.env.OSM_CACHE_ROOT, age: process.env.OSM_CACHE_MAX_AGE_SECONDS, url: process.env.OSM_NATIVE_URL };
  let requests = 0;
  try {
    process.env.OSM_CACHE_ROOT = root;
    process.env.OSM_CACHE_MAX_AGE_SECONDS = '3600';
    process.env.OSM_NATIVE_URL = 'https://native-osm.test/api/0.6/map';
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => ++requests === 1 ? '<osm version="0.6"></osm>' : '<osm version="0.6"><node id="1" lat="-6" lon="106"><tag k="building" v="yes"/></node></osm>',
    });
    const generator = new GeneratorService({});
    const rings = [{ outer: [[106, -6], [106.01, -6], [106.01, -5.99], [106, -5.99], [106, -6]], holes: [] }];
    const checkpointDir = resolve(root, 'checkpoints');
    await assert.rejects(generator.fetchNativeOsm(rings, false, checkpointDir), /Native OSM tidak mengembalikan fitur/);
    const result = await generator.fetchNativeOsm(rings, false, checkpointDir);
    assert.equal(requests, 2);
    assert.equal(result.elements[0].tags.building, 'yes');
  } finally {
    global.fetch = previousFetch;
    for (const [key, value] of [['OSM_CACHE_ROOT', env.cache], ['OSM_CACHE_MAX_AGE_SECONDS', env.age], ['OSM_NATIVE_URL', env.url]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('small auto OSM boundaries use a fresh local tile cache before making online requests', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ftth-osm-local-tile-cache-'));
  const names = ['OSM_SOURCE_MODE', 'OSM_ONLINE_MAX_AREA_KM2', 'OSM_ONLINE_MAX_TILES', 'OSM_CACHE_ROOT', 'OSM_CACHE_MAX_AGE_SECONDS'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = global.fetch;
  const rings = [{ outer: [[106, -6], [106.01, -6], [106.01, -5.99], [106, -5.99], [106, -6]], holes: [] }];
  const pop = [106.005, -5.995];
  let requests = 0, localDatabaseCalls = 0;
  try {
    process.env.OSM_SOURCE_MODE = 'auto';
    process.env.OSM_ONLINE_MAX_AREA_KM2 = '25';
    process.env.OSM_ONLINE_MAX_TILES = '4';
    process.env.OSM_CACHE_ROOT = root;
    process.env.OSM_CACHE_MAX_AGE_SECONDS = '3600';
    const key = [105.998, -6.002, 106.052, -5.948].map((value) => value.toFixed(6)).join(',');
    const tileId = createHash('sha256').update(`osm-native-tile-v1:${key}`).digest('hex');
    const elements = parseNativeOsmXml('<osm><node id="1" lon="106.001" lat="-5.999"><tag k="building" v="yes"/></node><node id="2" lon="106.002" lat="-5.998"><tag k="railway" v="station"/></node></osm>');
    await writeFile(resolve(root, `${tileId}.json`), JSON.stringify({ savedAt: Date.now(), elements }));
    global.fetch = async () => { requests++; throw new Error('fresh online request should not run'); };
    const generator = new GeneratorService({});
    generator.fetchLocal = async () => { localDatabaseCalls++; throw new Error('small area should use tile cache'); };
    const result = await generator.fetchOsm(rings, false, pop);
    assert.equal(result.metadata.source, 'osm_native');
    assert.equal(result.elements.length, 2);
    assert.equal(requests, 0);
    assert.equal(localDatabaseCalls, 0);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});

test('Overpass remains the fallback when Native OSM is unavailable', async () => {
  const originalFetch = global.fetch, previous = Object.fromEntries(['OSM_SOURCE_MODE', 'OSM_NATIVE_URL', 'OSM_NATIVE_RETRIES', 'OSM_CACHE_MAX_AGE_SECONDS'].map((key) => [key, process.env[key]]));
  const requests = [];
  process.env.OSM_SOURCE_MODE = 'online';
  process.env.OSM_NATIVE_URL = 'http://native.test/api/0.6/map';
  process.env.OSM_NATIVE_RETRIES = '1';
  process.env.OSM_CACHE_MAX_AGE_SECONDS = '0';
  global.fetch = async (url) => {
    requests.push(String(url));
    return String(url).includes('native.test')
      ? new Response('', { status: 503 })
      : new Response(JSON.stringify({ elements: [{ type: 'node', id: 1, lon: 106.001, lat: -5.999, tags: { building: 'yes' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const generator = new GeneratorService({});
    const result = await generator.fetchOsm([
      { outer: [[106, -6], [106.01, -6], [106.01, -5.99], [106, -5.99], [106, -6]], holes: [] },
    ], false, [106.001, -5.999]);
    assert.equal(result.metadata.source, 'osm_online');
    assert.match(requests[0], /^http:\/\/native\.test/);
    assert.ok(requests.some((url) => url.includes('overpass')));
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('Overpass multipolygon buildings join member ways and preserve inner rings', () => {
  const element = parseOverpassElements([{
    type: 'relation', id: 20, tags: { type: 'multipolygon', building: 'yes' }, members: [
      { type: 'way', ref: 201, role: 'outer', geometry: [{ lon: 106, lat: -6 }, { lon: 106.004, lat: -6 }] },
      { type: 'way', ref: 202, role: 'outer', geometry: [{ lon: 106.004, lat: -6 }, { lon: 106.004, lat: -5.996 }] },
      { type: 'way', ref: 203, role: 'outer', geometry: [{ lon: 106.004, lat: -5.996 }, { lon: 106, lat: -5.996 }, { lon: 106, lat: -6 }] },
      { type: 'way', ref: 204, role: 'inner', geometry: [{ lon: 106.001, lat: -5.999 }, { lon: 106.002, lat: -5.999 }, { lon: 106.002, lat: -5.998 }, { lon: 106.001, lat: -5.998 }, { lon: 106.001, lat: -5.999 }] },
    ],
  }])[0];
  assert.equal(element.type, 'relation');
  assert.equal(element.polygons[0].outer.length, 5);
  assert.equal(element.polygons[0].holes.length, 1);
});

test('Nest falls back to Overpass when Native OSM has roads but no buildings', async () => {
  const generator = new GeneratorService({});
  generator.sourceDecision = () => ({ mode: 'auto', tileSize: 0.05, local: false });
  generator.fetchNativeOsm = async () => ({ elements: [{ type: 'way', id: 1, tags: { highway: 'primary' }, geometry: [[106, -6], [106.01, -6]] }] });
  const originalFetch = global.fetch;
  const previousCacheRoot = process.env.OSM_CACHE_ROOT;
  const cacheRoot = await mkdtemp(resolve(tmpdir(), 'ftth-overpass-fallback-'));
  process.env.OSM_CACHE_ROOT = cacheRoot;
  let requestBody = '';
  global.fetch = async (_url, options) => {
    requestBody = String(options.body);
    return { ok: true, json: async () => ({ elements: [{ type: 'relation', id: 20, tags: { building: 'yes', type: 'multipolygon' }, members: [{ type: 'way', ref: 21, role: 'outer', geometry: [{ lon: 106, lat: -6 }, { lon: 106.01, lat: -6 }, { lon: 106.01, lat: -5.99 }, { lon: 106, lat: -5.99 }, { lon: 106, lat: -6 }] }] }] }) };
  };
  try {
    const result = await generator.fetchOsm([{ outer: [[106, -6], [106.01, -6], [106.01, -5.99], [106, -5.99], [106, -6]], holes: [] }]);
    assert.match(decodeURIComponent(requestBody), /relation\(poly:/);
    assert.equal(result.elements.some((item) => item.type === 'relation' && item.tags.building), true);
  } finally {
    global.fetch = originalFetch;
    if (previousCacheRoot === undefined) delete process.env.OSM_CACHE_ROOT;
    else process.env.OSM_CACHE_ROOT = previousCacheRoot;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('automatic generation does not require local PostGIS when online OSM returns no buildings', async () => {
  const generator = new GeneratorService({});
  generator.sourceDecision = () => ({ mode: 'auto', tileSize: 0.05, local: false });
  generator.fetchNativeOsm = async () => ({ elements: [{ type: 'way', id: 1, tags: { highway: 'primary' }, geometry: [[106, -6], [106.01, -6]] }] });
  const originalFetch = global.fetch;
  const names = ['OSM_CACHE_ROOT', 'OSM_CACHE_MAX_AGE_SECONDS', 'OSM_LOCAL_FALLBACK_ON_ONLINE_FAILURE'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const cacheRoot = await mkdtemp(resolve(tmpdir(), 'ftth-empty-online-fallback-'));
  process.env.OSM_CACHE_ROOT = cacheRoot;
  process.env.OSM_CACHE_MAX_AGE_SECONDS = '0';
  process.env.OSM_LOCAL_FALLBACK_ON_ONLINE_FAILURE = 'true';
  let localCalls = 0;
  generator.fetchLocal = async () => {
    localCalls++;
    return { elements: [{ type: 'way', id: 2, tags: { highway: 'residential' }, geometry: [[106, -6], [106.01, -6]] }], metadata: { source: 'osm_postgis' } };
  };
  global.fetch = async () => ({ ok: true, json: async () => ({ elements: [] }) });
  try {
    await assert.rejects(generator.fetchOsm([{ outer: [[106, -6], [106.01, -6], [106.01, -5.99], [106, -5.99], [106, -6]], holes: [] }], false, [106.001, -5.999], undefined, undefined, true), (error) => error.getResponse().error.code === 'OSM_UNAVAILABLE');
    assert.equal(localCalls, 0);
  } finally {
    global.fetch = originalFetch;
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('PostGIS local routing uses imported length_m for road edge weights', async () => {
  const generator = new GeneratorService({});
  const cacheRoot = await mkdtemp(resolve(tmpdir(), 'ftth-postgis-edge-length-'));
  const previous = { root: process.env.ROAD_GRAPH_CACHE_ROOT, age: process.env.OSM_CACHE_MAX_AGE_SECONDS };
  process.env.ROAD_GRAPH_CACHE_ROOT = cacheRoot;
  process.env.OSM_CACHE_MAX_AGE_SECONDS = '0';
  try {
    const graph = await generator.buildRoadGraph([
      { id: 'local-edge', tags: { highway: 'residential', length_m: 1234.5 }, geometry: [[106, -6], [106.01, -6]] },
      { id: 'zero-length-edge', tags: { highway: 'residential', length_m: 0 }, geometry: [[106.02, -6], [106.03, -6]] },
    ], 'shortest', [], true);
    const weights = [...graph.values()].flatMap((node) => node.edges).map((edge) => edge.weight);
    assert.ok(weights.includes(1234.5));
    assert.ok(weights.includes(0.01));
    const curved = await generator.buildRoadGraph([
      { id: 'curved-local-edge', tags: { highway: 'residential', length_m: 300, source_node: '10', target_node: '11', edge_index: 0 }, geometry: [[106.1, -6], [106.101, -6.001], [106.103, -6]] },
    ], 'shortest', [], true);
    const directedWeights = [...curved.values()].flatMap((node) => node.edges.map((edge) => edge.weight));
    assert.equal(directedWeights.length, 2);
    assert.ok(Math.abs(directedWeights.reduce((sum, weight) => sum + weight, 0) - 300) < 1e-9);
  } finally {
    if (previous.root === undefined) delete process.env.ROAD_GRAPH_CACHE_ROOT;
    else process.env.ROAD_GRAPH_CACHE_ROOT = previous.root;
    if (previous.age === undefined) delete process.env.OSM_CACHE_MAX_AGE_SECONDS;
    else process.env.OSM_CACHE_MAX_AGE_SECONDS = previous.age;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('PostGIS local routing preserves topology instead of joining at shape vertices', async () => {
  const generator = new GeneratorService({});
  const graph = await generator.buildRoadGraph([
    { id: 'road-a', tags: { highway: 'residential', length_m: 200, source_node: '10', target_node: '11', edge_index: 0 }, geometry: [[106.2, -6], [106.201, -6], [106.202, -6]] },
    { id: 'road-b', tags: { highway: 'residential', length_m: 100, source_node: '20', target_node: '21', edge_index: 0 }, geometry: [[106.201, -6], [106.201, -5.999]] },
  ], 'shortest', [], true);
  assert.equal(graph.size, 5);
  assert.equal(graph.get('osm-edge:road-a:0:1').edges.some((edge) => edge.to === 'osm-node:20'), false);
  assert.equal(graph.get('osm-node:20').at[0], 106.201);
});

test('PostGIS local road window matches the reference implementation convex-hull and 0.002-degree query', () => {
  const dialect = new PgDialect();
  const boundary = 'MULTIPOLYGON(((106 -6,106.01 -6,106.01 -5.99,106 -5.99,106 -6)))';
  const withPop = dialect.sqlToQuery(localRoadWindow(boundary, [106.02, -6.01]));
  assert.match(withPop.sql, /ST_Expand\(ST_ConvexHull\(ST_Collect\(/);
  assert.ok(withPop.sql.includes('ST_SetSRID(ST_MakePoint($2,$3),4326))),0.002)'));
  assert.deepEqual(withPop.params, [boundary, 106.02, -6.01]);
  const withoutPop = dialect.sqlToQuery(localRoadWindow(boundary));
  assert.match(withoutPop.sql, /ST_Expand\(ST_ConvexHull\(ST_GeomFromText\(\$1,4326\)\),0\.002\)/);
  assert.deepEqual(withoutPop.params, [boundary]);
});

test('PostGIS local POP search matches the reference implementation buffered-boundary geometry', () => {
  const boundary = 'MULTIPOLYGON(((106 -6,106.01 -6,106.01 -5.99,106 -5.99,106 -6)))';
  const searchArea = new PgDialect().sqlToQuery(localPopSearchArea(boundary));
  assert.equal(searchArea.sql, "ST_Buffer(ST_GeomFromText($1,4326),0.01,'quad_segs=16')");
  assert.deepEqual(searchArea.params, [boundary]);
});

test('road routing keeps reference implementation multi-value highway edges and uses the best allowed priority', async () => {
  const generator = new GeneratorService({});
  const cacheRoot = await mkdtemp(resolve(tmpdir(), 'ftth-multi-highway-'));
  const previous = { root: process.env.ROAD_GRAPH_CACHE_ROOT, age: process.env.OSM_CACHE_MAX_AGE_SECONDS };
  process.env.ROAD_GRAPH_CACHE_ROOT = cacheRoot;
  process.env.OSM_CACHE_MAX_AGE_SECONDS = '0';
  try {
    const geometry = [[106, -6], [106.01, -6]];
    const graphFor = (highway) => generator.buildRoadGraph([{ id: JSON.stringify(highway), tags: { highway }, geometry }], 'priority_road');
    const weights = async (highway) => [...(await graphFor(highway)).values()].flatMap((node) => node.edges).map((edge) => edge.weight);
    const primary = await weights('primary');
    assert.deepEqual(await weights(['residential', 'primary']), primary);
    assert.deepEqual(await weights('["residential","primary"]'), primary);
    assert.deepEqual(await weights('footway'), []);
  } finally {
    if (previous.root === undefined) delete process.env.ROAD_GRAPH_CACHE_ROOT;
    else process.env.ROAD_GRAPH_CACHE_ROOT = previous.root;
    if (previous.age === undefined) delete process.env.OSM_CACHE_MAX_AGE_SECONDS;
    else process.env.OSM_CACHE_MAX_AGE_SECONDS = previous.age;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('auto POP checks Overpass for stations and offices missing from Native OSM', async () => {
  const generator = new GeneratorService({});
  generator.sourceDecision = () => ({ mode: 'auto', tileSize: 0.05, local: false });
  generator.fetchNativeOsm = async () => ({ elements: [{ type: 'way', id: 2, tags: { building: 'yes' }, geometry: [[106, -6], [106.001, -6], [106.001, -5.999], [106, -5.999], [106, -6]] }] });
  const originalFetch = global.fetch;
  const previousCacheRoot = process.env.OSM_CACHE_ROOT;
  const cacheRoot = await mkdtemp(resolve(tmpdir(), 'ftth-auto-pop-'));
  process.env.OSM_CACHE_ROOT = cacheRoot;
  let requestBody = '';
  global.fetch = async (_url, options) => {
    requestBody = String(options.body);
    return { ok: true, json: async () => ({ elements: [{ type: 'node', id: 3, lon: 106.002, lat: -5.998, tags: { railway: 'station', name: 'Stasiun Relasi' } }] }) };
  };
  try {
    const result = await generator.fetchOsm([{ outer: [[106, -6], [106.01, -6], [106.01, -5.99], [106, -5.99], [106, -6]], holes: [] }]);
    assert.match(decodeURIComponent(requestBody), /\[railway=station\]/);
    assert.deepEqual(result.popCandidate, { name: 'Stasiun Relasi', at: [106.002, -5.998] });
  } finally {
    global.fetch = originalFetch;
    if (previousCacheRoot === undefined) delete process.env.OSM_CACHE_ROOT;
    else process.env.OSM_CACHE_ROOT = previousCacheRoot;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('CSV rows match reference implementation numeric formatting, lengths, and feeder IDs', () => {
  const csv = buildCsv(
    { label: 'OLT', at: [106, -6] },
    [{ label: 'ODC-001', at: [106.001, -6.001], members: ['ODP-001'] }],
    [{ label: 'ODP-001', at: [106.002, -6.002], members: ['HOUSE-01'] }],
    [{ label: 'HOUSE-01', at: [106.003, -6.003] }],
    [
      { type: 'distribution', source: 'ODC-001', target: 'ODP-001', coords: [], length: 12 },
      { type: 'homepass', source: 'ODP-001', target: 'HOUSE-01', coords: [], length: 0 },
      { type: 'feeder', source: 'POP', target: 'ODC-001', coords: [], length: 156.82 },
    ],
  ).toString();
  assert.equal(csv, [
    'Tipe,Nama,Kuantitas/Panjang,Satuan,Latitude,Longitude',
    'POP / Server OLT,OLT,1,pcs,-6.0,106.0',
    'ODC,ODC 01,1,pcs,-6.001,106.001',
    'Join Closure,JOIN CLOSURE ODC 01,1,pcs,-6.001,106.001',
    'ODP,01/01,1,pcs,-6.002,106.002',
    'Kabel Distribusi,ODC 01 -> 01/01,12.0,m,,',
    'Homepass (Titik Rumah),01/01-01,1,pcs,-6.003,106.003',
    'Kabel Drop,01/01 -> 01/01-01,188.19,m,,',
    'Kabel Feeder,OLT -> ODC-001,156.82,m,,',
    '',
  ].join('\r\n'));
  const rounded = (length) => buildCsv(
    { label: 'OLT', at: [106, -6] },
    [{ label: 'ODC-001', at: [106.001, -6.001], members: ['ODP-001'] }],
    [{ label: 'ODP-001', at: [106.002, -6.002], members: [] }], [],
    [{ type: 'distribution', source: 'ODC-001', target: 'ODP-001', coords: [], length }],
  ).toString();
  assert.ok(rounded(2.125).includes('Kabel Distribusi,ODC 01 -> 01/01,2.12,m,,\r\n'));
  assert.ok(rounded(2.675).includes('Kabel Distribusi,ODC 01 -> 01/01,2.67,m,,\r\n'));
  const reordered = buildCsv(
    { label: 'OLT', at: [106, -6] },
    [{ label: 'ODC-001', at: [106, -6], members: ['ODP-002', 'ODP-001'] }],
    [
      { label: 'ODP-001', at: [106.001, -6], members: [] },
      { label: 'ODP-002', at: [106.002, -6], members: [] },
    ],
    [],
    [],
  ).toString();
  assert.ok(reordered.indexOf('ODP,01/01,1,pcs,-6.0,106.002') < reordered.indexOf('ODP,01/02,1,pcs,-6.0,106.001'));
});

test('design length stats round total kilometers like reference implementation', () => {
  const stats = designStats([], [], [], [
    { type: 'feeder', source: 'POP', target: 'ODC-001', coords: [], length: 1005 },
    { type: 'distribution', source: 'ODC-001', target: 'ODP-001', coords: [], length: 1005 },
  ]);
  assert.equal(stats.feeder_length_km, 1);
  assert.equal(stats.distribution_length_km, 1);
});

test('Nest generation supports the reference implementation CLI manual-house and straight-line path', async () => {
  const generator = new GeneratorService({});
  generator.fetchOsm = async () => { throw new Error('manual houses with no-road mode must not query OSM'); };
  const boundary = Buffer.from('<kml><Document><Placemark><name>Boundary</name><Polygon><outerBoundaryIs><LinearRing><coordinates>106.0,-6.0 106.01,-6.0 106.01,-5.99 106.0,-5.99 106.0,-6.0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>');
  const pop = Buffer.from('<kml><Document><Placemark><name>OLT</name><Point><coordinates>106.001,-5.999,0</coordinates></Point></Placemark></Document></kml>');
  const result = await generator.generate(boundary, 'boundary.kml', pop, 'pop.kml', {
    no_road_feeder: true, target_homepass: 2, odp_capacity: 1, odc_capacity: 1,
    include_homepass: true,
    manual_houses: [
      { label: 'HOUSE-1', at: [106.002, -5.998] },
      { label: 'HOUSE-2', at: [106.003, -5.998] },
      { label: 'HOUSE-3', at: [106.009, -5.991] },
    ],
  });
  assert.equal(result.state.customers.length, 2);
  assert.deepEqual(result.state.customers.map((house) => house.label), ['HOUSE-1', 'HOUSE-2']);
  assert.equal(result.state.odcs.length, 2);
  assert.deepEqual(result.state.odcs.map((odc) => odc.at), [[106.002, -5.998], [106.003, -5.998]]);
  assert.deepEqual(result.state.odps.map((odp) => odp.members), [['HOUSE-1'], ['HOUSE-2']]);
  const [firstOdc, secondOdc] = result.state.odcs;
  const earthDistance = (a, b) => {
    const rad = (value) => value * Math.PI / 180;
    const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };
  assert.ok(earthDistance(firstOdc.at, secondOdc.at) >= 40);
  assert.equal(result.state.cables.filter((cable) => cable.type === 'feeder').length, 2);
  assert.equal(result.state.cables.filter((cable) => cable.type === 'distribution').length, 2);
  assert.equal(result.state.cables.filter((cable) => cable.type === 'homepass').length, 2);
  assert.equal(result.state.roads.length, 0);
  assert.ok(result.kmz.length > 0);
  const kmz = await JSZip.loadAsync(result.kmz);
  const kml = await kmz.file('doc.kml').async('string');
  assert.match(kml, /<name>BOUNDARY<\/name>/);
  assert.match(kml, /<PolyStyle><color>46ff0000<\/color><\/PolyStyle>/);
  const cliResult = await generator.generate(boundary, 'boundary.kml', pop, 'pop.kml', {
    no_road_feeder: true, manual_houses: [{ label: 'HOUSE-1', at: [106.002, -5.998] }], include_boundary: false,
  });
  const cliKmz = await JSZip.loadAsync(cliResult.kmz);
  assert.doesNotMatch(await cliKmz.file('doc.kml').async('string'), /<name>BOUNDARY<\/name>/);
  assert.match(kml, /<name>OLT-ODC-001-ODC-002/);
  const houseIcon = await kmz.file('files/ftth-house.png').async('nodebuffer');
  assert.equal(houseIcon.readUInt32BE(16), 96);
  assert.deepEqual(Object.keys(kmz.files).filter((name) => name.endsWith('/')), []);
  assert.ok(result.csv.length > 0);
  assert.equal(result.state.pop_label, 'OLT');
  assert.match(result.csv.toString(), /POP \/ Server OLT,OLT,1,pcs/);
  const fallback = await generator.generate(boundary, 'boundary.kml', pop, 'pop.kml', {
    manual_houses: [{ label: 'HOUSE-1', at: [106.002, -5.998] }],
    allow_road_fallback: true,
  });
  assert.equal(fallback.state.roads.length, 0);
  assert.equal(fallback.state.cables.filter((cable) => cable.type === 'feeder').length, 1);
  await assert.rejects(generator.generate(boundary, 'boundary.kml', pop, 'pop.kml', {
    manual_houses: [{ label: 'HOUSE-1', at: [106.002, -5.998] }],
  }), /manual houses with no-road mode must not query OSM/);
  generator.fetchOsm = async () => ({ elements: [], metadata: { source: 'test' } });
  const noRoads = await generator.generate(boundary, 'boundary.kml', pop, 'pop.kml', {
    manual_houses: [{ label: 'HOUSE-1', at: [106.002, -5.998] }], allow_road_fallback: true,
  });
  assert.equal(noRoads.state.roads.length, 0);
  await assert.rejects(generator.generate(boundary, 'boundary.kml', pop, 'pop.kml', {
    no_road_feeder: true, manual_houses: [],
  }), (error) => error.getStatus() === 404 && error.getResponse().error.code === 'NO_CUSTOMER_FOUND');
  const distantPop = Buffer.from('<kml><Document><Placemark><name>OLT</name><Point><coordinates>106.05,-5.999,0</coordinates></Point></Placemark></Document></kml>');
  await assert.rejects(generator.generate(boundary, 'boundary.kml', distantPop, 'pop.kml', {
    no_road_feeder: true, manual_houses: [{ label: 'HOUSE-1', at: [106.002, -5.998] }],
  }), (error) => error.getStatus() === 400 && error.getResponse().error.code === 'POP_TOO_FAR' && error.getResponse().error.details.limit_m === 3000);
});

test('Surabaya manual-input KMZ matches Python reference feature names and geometry', async () => {
  const generator = new GeneratorService({});
  const boundary = Buffer.from('<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Surabaya Boundary</name><Polygon><outerBoundaryIs><LinearRing><coordinates>112.7,-7.25,0 112.71,-7.25,0 112.71,-7.24,0 112.7,-7.24,0 112.7,-7.25,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>');
  const pop = Buffer.from('<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>OLT Surabaya</name><Point><coordinates>112.705,-7.245,0</coordinates></Point></Placemark></Document></kml>');
  const houses = [[112.701, -7.249], [112.702, -7.248], [112.703, -7.247], [112.704, -7.246], [112.706, -7.244], [112.709, -7.241]];
  const result = await generator.generate(boundary, 'boundary.kml', pop, 'pop.kml', {
    no_road_feeder: true, odp_capacity: 2, odc_capacity: 2, include_homepass: true, include_boundary: false,
    manual_houses: houses.map((at, index) => ({ label: `HC-${index + 1}`, at })),
  });
  const zip = await JSZip.loadAsync(result.kmz), kml = await zip.file('doc.kml').async('string');
  const features = [...kml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)].map(([, body]) => ({
    name: body.match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? '',
    coordinates: [...body.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/g)].map(([, coordinates]) => coordinates.trim()),
  }));
  const pythonReference = [
    ['OLT001', ['112.705,-7.245,0.0']],
    ['ODC001', ['112.70249999999999,-7.2475000000000005,0.0']],
    ['ODC002', ['112.70750000000001,-7.2425,0.0']],
    ['ODC001.ODP001', ['112.7015,-7.2485,0.0']],
    ['ODC001.ODP002', ['112.70349999999999,-7.2465,0.0']],
    ['ODC002.ODP001', ['112.70750000000001,-7.2425,0.0']],
    ['ODC001.ODP001-01', ['112.702,-7.248,0.0']],
    ['ODC001.ODP001-02', ['112.701,-7.249,0.0']],
    ['ODC001.ODP002-01', ['112.704,-7.246,0.0']],
    ['ODC001.ODP002-02', ['112.703,-7.247,0.0']],
    ['ODC002.ODP001-01', ['112.709,-7.241,0.0']],
    ['ODC002.ODP001-02', ['112.706,-7.244,0.0']],
    ['OLT Surabaya-ODC-001-ODC-002', ['112.705,-7.245,0.0 112.70249999999999,-7.2475000000000005,0.0 112.70750000000001,-7.2425,0.0']],
    ['Distribution Route', ['112.70249999999999,-7.2475000000000005,0.0 112.7015,-7.2485,0.0', '112.70249999999999,-7.2475000000000005,0.0 112.70349999999999,-7.2465,0.0', '112.70750000000001,-7.2425,0.0 112.70750000000001,-7.2425,0.0']],
    ['Drop Route', ['112.7015,-7.2485,0.0 112.702,-7.248,0.0', '112.7015,-7.2485,0.0 112.701,-7.249,0.0', '112.70349999999999,-7.2465,0.0 112.704,-7.246,0.0', '112.70349999999999,-7.2465,0.0 112.703,-7.247,0.0', '112.70750000000001,-7.2425,0.0 112.709,-7.241,0.0', '112.70750000000001,-7.2425,0.0 112.706,-7.244,0.0']],
  ].map(([name, coordinates]) => ({ name, coordinates }));
  assert.deepEqual(features, pythonReference);
});

test('manual houses on outer and hole boundaries follow reference implementation polygon covers semantics', async () => {
  const generator = new GeneratorService({});
  generator.fetchOsm = async () => { throw new Error('manual houses with no-road mode must not query OSM'); };
  const boundary = Buffer.from('<kml><Document><Placemark><name>Boundary</name><Polygon><outerBoundaryIs><LinearRing><coordinates>106,-6 106.01,-6 106.01,-5.99 106,-5.99 106,-6</coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>106.004,-5.996 106.006,-5.996 106.006,-5.994 106.004,-5.994 106.004,-5.996</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark></Document></kml>');
  const pop = Buffer.from('<kml><Document><Placemark><name>OLT</name><Point><coordinates>106.001,-5.999,0</coordinates></Point></Placemark></Document></kml>');
  const result = await generator.generate(boundary, 'boundary.kml', pop, 'pop.kml', {
    no_road_feeder: true, odp_capacity: 1, odc_capacity: 2,
    manual_houses: [
      { label: 'OUTER-EDGE', at: [106, -5.995] },
      { label: 'HOLE-EDGE', at: [106.004, -5.995] },
      { label: 'INSIDE-HOLE', at: [106.005, -5.995] },
    ],
  });
  assert.deepEqual(result.state.customers.map((house) => house.label), ['OUTER-EDGE', 'HOLE-EDGE']);
});

test('straight-line ODC spacing matches reference implementation Earth radius and coordinates', async () => {
  const generator = new GeneratorService({});
  const boundary = Buffer.from('<kml><Document><Placemark><name>Boundary</name><Polygon><outerBoundaryIs><LinearRing><coordinates>105.99,-6.01 106.01,-6.01 106.01,-5.99 105.99,-5.99 105.99,-6.01</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>');
  const pop = Buffer.from('<kml><Document><Placemark><name>OLT</name><Point><coordinates>106,-6,0</coordinates></Point></Placemark></Document></kml>');
  const result = await generator.generate(boundary, 'boundary.kml', pop, 'pop.kml', {
    no_road_feeder: true, odp_capacity: 1, odc_capacity: 1,
    manual_houses: [
      { label: 'HOUSE-1', at: [106, -6] },
      { label: 'HOUSE-2', at: [106, -6] },
    ],
  });
  assert.ok(result.state.odcs.some((odc) => Math.abs(odc.at[1] - -6.0002652197212445) < 1e-12 && Math.abs(odc.at[0] - 106.00024436793956) < 1e-12));
});

test('cached CORE export preserves KMZ, CSV, statistics, and validation', async () => {
  const generator = new GeneratorService({});
  const boundary = Buffer.from('<kml><Document><Placemark><name>Boundary</name><Polygon><outerBoundaryIs><LinearRing><coordinates>106,-6 106.01,-6 106.01,-5.99 106,-5.99 106,-6</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>');
  const pop = Buffer.from('<kml><Document><Placemark><name>OLT</name><Point><coordinates>106.001,-5.999,0</coordinates></Point></Placemark></Document></kml>');
  const options = { no_road_feeder: true, include_homepass: false, manual_houses: [{ label: 'HOUSE-1', at: [106.002, -5.998] }] };
  const generated = await generator.generate(boundary, 'boundary.kml', pop, 'pop.kml', options);
  const reused = await generator.reuseCore(generated.state, options);
  const generatedZip = await JSZip.loadAsync(generated.kmz), reusedZip = await JSZip.loadAsync(reused.kmz);
  assert.equal(await reusedZip.file('doc.kml').async('string'), await generatedZip.file('doc.kml').async('string'));
  assert.equal(reused.csv.toString(), generated.csv.toString());
  assert.deepEqual(reused.stats, generated.stats);
  assert.deepEqual(reused.validation, generated.validation);
});

test('manual-house routing follows the reference implementation road fixture geometry', async () => {
  const generator = new GeneratorService({});
  generator.fetchOsm = async () => ({
    elements: [{ type: 'way', id: 1, tags: { highway: 'residential' }, geometry: [112.746, 112.748, 112.75, 112.752, 112.754].map((lon) => [lon, -7.25]) }],
    metadata: { source: 'fixture' },
  });
  const boundary = Buffer.from('<kml><Document><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>112.74,-7.26 112.76,-7.26 112.76,-7.24 112.74,-7.24 112.74,-7.26</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>');
  const pop = Buffer.from('<kml><Document><Placemark><name>POP/OLT</name><Point><coordinates>112.75,-7.25,0</coordinates></Point></Placemark></Document></kml>');
  const houses = [112.747, 112.7471, 112.749, 112.7491, 112.751, 112.7511, 112.753, 112.7531]
    .map((lon, index) => ({ label: `HC-${index + 1}`, at: [lon, -7.2501] }));
  const result = await generator.generate(boundary, 'boundary.kml', pop, 'pop.kml', {
    manual_houses: houses, odp_capacity: 2, odc_capacity: 2, include_homepass: true,
  });
  assert.deepEqual(result.state.odcs.map((odc) => odc.at), [[112.74805, -7.25], [112.75205, -7.25]]);
  assert.deepEqual(result.state.odps.map((odp) => odp.at), [112.74705, 112.74905, 112.75104999999999, 112.75305].map((lon) => [lon, -7.25]));
  const kmz = await JSZip.loadAsync(result.kmz);
  const kml = await kmz.file('doc.kml').async('string');
  const names = [...kml.matchAll(/<Placemark><name>([^<]+)<\/name>/g)].map((match) => match[1]).filter((name) => name !== 'Boundary');
  assert.deepEqual(names, [
    'OLT001', 'ODC001', 'ODC002',
    'ODC001.ODP001', 'ODC001.ODP002', 'ODC002.ODP001', 'ODC002.ODP002',
    'ODC001.ODP001-01', 'ODC001.ODP001-02', 'ODC001.ODP002-01', 'ODC001.ODP002-02',
    'ODC002.ODP001-01', 'ODC002.ODP001-02', 'ODC002.ODP002-01', 'ODC002.ODP002-02',
    'POP/OLT-ODC-001-ODC-002', 'Distribution Route', 'Drop Route',
  ]);
});

test('generation SSE sends a separate heartbeat while progress is unchanged', async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let tick, cleared = false;
  global.setInterval = (callback, interval) => {
    assert.equal(interval, 15000);
    tick = callback;
    return { unref() {} };
  };
  global.clearInterval = () => { cleared = true; };
  try {
    const controller = new GenerationController({}, {}, {}, {}, {});
    controller.jobState = async () => ({ user_id: 'owner', stage: 'RUNNING', percent: 20, done: false });
    const headers = {};
    const stream = await controller.progressStream('job', { user: { id: 'owner' } }, { setHeader: (name, value) => { headers[name] = value; } });
    assert.deepEqual(headers, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const events = [];
    const subscription = stream.subscribe((event) => events.push(event));
    await new Promise(setImmediate);
    tick();
    assert.deepEqual(events.at(-1), { type: 'heartbeat', data: '' });
    subscription.unsubscribe();
    assert.equal(cleared, true);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

test('batch merges disconnected boundary files into one reference implementation-style core job', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ftth-batch-parity-'));
  try {
    const controller = new GenerationController({}, {}, { validateOptions: (options) => options }, {}, {});
    controller.cacheRoot = root;
    controller.generationUser = async () => ({ id: 'owner' });
    controller.requireProject = async () => {};
    let queued;
    controller.enqueue = async (_user, input) => { queued = input; return 'job-1'; };
    const boundary = (name, west, east) => ({ originalname: name, buffer: Buffer.from(`<kml><Document><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${west},-7.26 ${east},-7.26 ${east},-7.24 ${west},-7.24 ${west},-7.26</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`) });
    const pop = { originalname: 'POP.kml', buffer: Buffer.from('<kml><Document><Placemark><name>POP</name><Point><coordinates>112.75,-7.25,0</coordinates></Point></Placemark></Document></kml>') };
    const files = [boundary('boundary-a.kml', 112.74, 112.75), boundary('boundary-b.kml', 112.75, 112.76), pop];
    const response = await controller.batch(files, { body: { project_id: 'project', config: '{}' } });
    assert.equal(response.data.total, 1);
    assert.equal(queued.options.include_homepass, false);
    const marks = await readKml(await readFile(queued.inputPaths.boundary), 'boundary.kml');
    assert.equal(marks.filter((mark) => mark.polygon).length, 2);
    await controller.batch(files, { body: { project_id: 'project', force_refresh: 'on' } });
    assert.equal(queued.options.force_refresh_osm, true);
    await assert.rejects(controller.batch(files, { body: { project_id: 'project', force_refresh: 'maybe' } }), (error) => {
      assert.equal(error.getStatus(), 422);
      assert.equal(error.getResponse().detail[0].type, 'bool_parsing');
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('new generation removes only stale temporary inputs like the reference implementation cleanup', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ftth-input-cleanup-'));
  try {
    const controller = new GenerationController({}, {}, {}, {}, {});
    controller.cacheRoot = root;
    const upload = (name) => ({ originalname: name, buffer: Buffer.from('kml') });
    const old = await controller.persistInputs('owner', 'project', 'old-batch', 'old-item', upload('old.kml'));
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(old.boundary, past, past);
    const current = await controller.persistInputs('owner', 'project', 'new-batch', 'new-item', upload('current.kml'));
    await assert.rejects(readFile(old.boundary), { code: 'ENOENT' });
    assert.equal((await readFile(current.boundary)).toString(), 'kml');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Homepass and Regenerate retain the frontend job ID for SSE', async () => {
  const controller = new GenerationController({}, {}, { validateOptions: (options) => options }, {}, {});
  controller.generationUser = async () => ({ id: 'owner' });
  controller.requireProject = async () => {};
  controller.resolveCacheFile = async () => ({ path: '/tmp/network.json' });
  const queued = [];
  controller.enqueue = async (_user, input) => { queued.push(input); return input.jobId; };
  const request = { body: { project_id: 'project', job_id: 'frontend-job-1' } };
  const homepass = await controller.homepass(request);
  const regenerate = await controller.regenerate(request);
  assert.deepEqual(queued.map((input) => [input.operation, input.jobId]), [['homepass', 'frontend-job-1'], ['regenerate', 'frontend-job-1']]);
  assert.equal(homepass.data.job_id, request.body.job_id);
  assert.equal(regenerate.data.job_id, request.body.job_id);
});

test('Homepass and Regenerate rebuild from saved batch inputs when the network cache is missing', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ftth-cache-recovery-'));
  try {
    const boundary = resolve(root, 'boundary.kml'), pop = resolve(root, 'pop.kml');
    await writeFile(boundary, '<kml/>'); await writeFile(pop, '<kml/>');
    const row = { result: { input_paths: { boundary, boundaryName: 'boundary.kml', pop, popName: 'pop.kml' } } };
    const query = { where() { return this; }, orderBy() { return this; }, async limit() { return [row]; } };
    const controller = new GenerationController({ select: () => ({ from: () => query }) }, {}, {}, {}, {});
    controller.generationUser = async () => ({ id: 'owner' });
    controller.requireProject = async () => {};
    controller.resolveCacheFile = async () => { throw new BadRequestException('Cache Network Core belum tersedia. Jalankan Generate Design terlebih dahulu.'); };
    controller.parseOptions = () => ({});
    const queued = [];
    controller.enqueue = async (_user, input) => { queued.push(input); return input.jobId; };
    for (const operation of ['homepass', 'regenerate']) {
      await controller.cachedOperation({ body: { project_id: 'project', batch_id: 'batch', item_id: 'item', job_id: `job-${operation}` } }, operation);
    }
    assert.deepEqual(queued.map(({ operation, rebuildFromInputs, inputPaths }) => [operation, rebuildFromInputs, inputPaths.boundary]), [
      ['homepass', true, boundary], ['regenerate', true, boundary],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only core generation creates a design version like the reference implementation worker', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ftth-version-parity-'));
  try {
    const result = { kmz: Buffer.from('kmz'), csv: Buffer.from('csv'), state: {}, stats: {}, validation: {} };
    const db = { update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: 'job' }] }) }) }) };
    const controller = new GenerationController(db, { upload: async () => {} }, {
      generate: async () => result, fromCache: async () => result,
    }, {}, {});
    controller.cacheRoot = root;
    controller.withJobLock = async () => ({});
    controller.releaseJobLock = async () => {};
    controller.update = async (_jobId, patch) => { if (patch.status === 'FAILED') throw new Error(patch.message); };
    const recorded = [];
    controller.recordVersion = async (_projectId, _user, _result, _options, kmzName) => { recorded.push(kmzName); };
    const cachePath = resolve(root, 'network.json');
    await writeFile(cachePath, '{}');
    const user = { id: 'owner' };
    for (const operation of ['homepass', 'regenerate']) {
      await controller.run(`job-${operation}`, user, { operation, cachePath, projectId: 'project', options: {}, kmzName: `${operation}.kmz`, csvName: `${operation}.csv` });
    }
    assert.deepEqual(recorded, []);
    await controller.run('job-core', user, { projectId: 'project', boundary: { buffer: Buffer.from('<kml/>'), originalname: 'boundary.kml' }, pop: { buffer: Buffer.from('<kml/>'), originalname: 'pop.kml' }, options: {}, kmzName: 'core.kmz', csvName: 'core.csv' });
    assert.deepEqual(recorded, ['core.kmz']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('identical Nest CORE jobs reuse the validated network cache', async () => {
  const previousRoot = process.env.USER_CACHE_ROOT;
  const root = await mkdtemp(resolve(tmpdir(), 'ftth-core-cache-'));
  process.env.USER_CACHE_ROOT = root;
  const inputDir = resolve(root, 'input');
  await mkdir(inputDir, { recursive: true });
  const boundary = Buffer.from('boundary input'), pop = Buffer.from('pop input');
  const boundaryPath = resolve(inputDir, 'boundary.kml'), popPath = resolve(inputDir, 'pop.kml');
  await writeFile(boundaryPath, boundary); await writeFile(popPath, pop);
  let generated = 0, reused = 0;
  const result = { kmz: Buffer.from('kmz'), csv: Buffer.from('csv'), state: { pop: [106, -6], pop_label: 'OLT', odcs: [], odps: [], customers: [], cables: [], roads: [] }, stats: {}, validation: {}, metadata: { source: 'osm_online' } };
  const generator = {
    async coreSourceSignature() { return 'osm_online'; },
    async generate() { generated++; return result; },
    async reuseCore(state) { reused++; assert.deepEqual(state, result.state); return result; },
  };
  const db = { update() { return { set() { return { where() { return { returning: async () => [{ id: 'claimed' }], then: (resolve) => resolve(undefined) }; } }; } }; } };
  const controller = new GenerationController(db, { async upload() {} }, generator, {}, {});
  controller.withJobLock = async () => ({});
  controller.releaseJobLock = async () => {};
  const input = { inputPaths: { boundary: boundaryPath, boundaryName: 'boundary.kml', pop: popPath, popName: 'pop.kml' }, options: { include_homepass: false, force_refresh_osm: false, odp_capacity: 10, feature_colors: { pop: '#eab308' } } };
  try {
    await controller.run('job-one', { id: 'owner', role: 'engineer' }, input);
    await controller.run('job-two', { id: 'owner', role: 'engineer' }, input);
    await controller.run('job-three', { id: 'owner', role: 'engineer' }, { ...input, options: { ...input.options, odp_capacity: 9 } });
    assert.equal(generated, 2);
    assert.equal(reused, 1);
  } finally {
    if (previousRoot === undefined) delete process.env.USER_CACHE_ROOT; else process.env.USER_CACHE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('project creation keeps previous API required fields and exact name value', async () => {
  const inserted = [];
  const db = { transaction: async (run) => run({ insert: () => ({ values: (value) => {
    inserted.push(value);
    return { returning: async () => [{ ...value }] };
  } }) }) };
  const controller = new ProjectsController(db);
  const req = { user: { id: 'owner', role: 'engineer' } };
  await assert.rejects(controller.create({ name: 'X', layers: [], filters: {} }, req), (error) => {
    assert.equal(error.getStatus(), 422);
    assert.deepEqual(error.getResponse().detail.map((item) => item.loc), [['body', 'feature_colors']]);
    return true;
  });
  await assert.rejects(controller.create({ name: 'X', layers: {}, filters: [], feature_colors: {} }, req), (error) => {
    assert.equal(error.getStatus(), 422);
    assert.deepEqual(error.getResponse().detail.map((item) => item.type), ['list_type', 'dict_type']);
    return true;
  });
  await controller.create({ name: ' X ', layers: [], filters: {}, feature_colors: {} }, req);
  assert.equal(inserted[0].name, ' X ');
});

test('project updates reject invalid field types with a validation response', async () => {
  const controller = new ProjectsController({});
  const req = { user: { id: 'owner', role: 'engineer' } };
  await assert.rejects(controller.update('project', { layers: 'not a list', generation_config: [] }, req), (error) => {
    assert.equal(error.getStatus(), 422);
    assert.deepEqual(error.getResponse().detail.map((item) => item.type), ['list_type', 'dict_type']);
    return true;
  });
});

test('project list keeps viewer visibility and owner-scoped admin visibility', async () => {
  const whereValues = [];
  const query = {
    where(value) { whereValues.push(value); return this; }, orderBy() { return this; },
    offset() { return this; }, async limit() { return []; },
  };
  const controller = new ProjectsController({ select: () => ({ from: () => query }) });
  await controller.list({ user: { id: 'viewer-1', role: 'viewer' } });
  await controller.list({ user: { id: 'admin-2', role: 'admin' } });
  assert.equal(whereValues[0], undefined);
  assert.deepEqual(new PgDialect().sqlToQuery(whereValues[1]).params, ['admin-2']);
});

test('project access and deletion stay owner-scoped for administrators', async () => {
  const foreign = { id: 'project-1', name: 'Private', userId: 'admin-1' };
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [foreign] }) }) }) };
  const controller = new ProjectsController(db);
  await assert.rejects(controller.get('project-1', { user: { id: 'admin-2', role: 'admin' } }), (error) => error.getStatus() === 403);
  await assert.rejects(controller.remove('project-1', { user: { id: 'admin-2', role: 'admin' } }), (error) => error.getStatus() === 403);
  await assert.rejects(controller.remove('project-1', { user: { id: 'engineer-1', role: 'engineer' } }), (error) => error.getStatus() === 403);
});

test('project creation stores generation config compatibly and hides its legacy filter key', async () => {
  const config = { odc_capacity: 8, max_distribution_length_m: 750 };
  let inserted, audit;
  const db = { transaction: async (run) => run({ insert: () => ({ values: (value) => {
    if (value.action === 'CREATE_PROJECT') { audit = value; return Promise.resolve(); }
    inserted = value;
    return { returning: async () => [{ ...value }] };
  } }) }) };
  const result = await new ProjectsController(db).create({ name: 'Design', layers: [], filters: {}, feature_colors: {}, generation_config: config }, { user: { id: 'engineer-1', role: 'engineer' } });
  assert.deepEqual(inserted.filters.__generation_config__, config);
  assert.deepEqual(inserted.generation_config, config);
  assert.deepEqual(result.data.filters, {});
  assert.deepEqual(result.data.generation_config, config);
  assert.equal(audit.action, 'CREATE_PROJECT');
});

test('project update audits the previous and saved values', async () => {
  const old = { id: 'project-1', name: 'Old name', layers: [], filters: {}, feature_colors: {}, generation_config: {}, userId: 'engineer-1', created_at: new Date(0), updated_at: new Date(0) };
  let audit;
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [old] }) }) }),
    transaction: async (run) => run({
      update: () => ({ set: (value) => ({ where: () => ({ returning: async () => [{ ...old, ...value, name: 'New name' }] }) }) }),
      insert: () => ({ values: async (value) => { audit = value; } }),
    }),
  };
  await new ProjectsController(db).update('project-1', { name: 'New name' }, { user: { id: 'engineer-1', role: 'engineer' } });
  assert.equal(audit.action, 'UPDATE_PROJECT');
  assert.equal(audit.details.old.name, 'Old name');
  assert.equal(audit.details.new.name, 'New name');
});

test('viewers cannot mutate versions and engineers cannot delete them', async () => {
  const controller = new VersionsController({}, {});
  await assert.rejects(controller.remove('project-1', '1', { user: { id: 'viewer-1', role: 'viewer' } }), (error) => error.getStatus() === 403);
  await assert.rejects(controller.duplicate('project-1', '1', { user: { id: 'viewer-1', role: 'viewer' } }), (error) => error.getStatus() === 403);
  await assert.rejects(controller.rollback('project-1', '1', { user: { id: 'viewer-1', role: 'viewer' } }), (error) => error.getStatus() === 403);
  await assert.rejects(controller.remove('project-1', '1', { user: { id: 'engineer-1', role: 'engineer' } }), (error) => error.getStatus() === 403);
});

test('administrators cannot list versions for another owner’s project', async () => {
  let reads = 0;
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => { reads++; return [{ id: 'project-1', userId: 'owner-1' }]; } }) }) }) };
  await assert.rejects(new VersionsController(db, {}).list('project-1', { user: { id: 'admin-1', role: 'admin' } }), (error) => error.getStatus() === 404);
  assert.equal(reads, 1);
});

test('version duplicate and rollback copy spatial records and audit in one transaction', async () => {
  const source = { id: 'version-1', projectId: 'project-1', version: 1, config: {}, metadata: {}, validation: {}, stats: {}, status: 'COMPLETED', createdAt: new Date(0) };
  const executions = [], audits = [];
  for (const [operation, action] of [['duplicate', 'DUPLICATE_VERSION'], ['rollback', 'ROLLBACK_VERSION']]) {
    let selection = 0;
    const tx = {
      async execute(statement) { executions.push(new PgDialect().sqlToQuery(statement).sql); },
      select: () => ({ from: () => {
        selection++;
        const query = { where() { return this; }, orderBy() { return this; }, async limit() { return selection === 1 ? [source] : [{ version: 1 }]; } };
        return query;
      } }),
      insert: () => ({ values: (value) => {
        if (value.action) { audits.push(value); return Promise.resolve(); }
        return { returning: async () => [{ ...value }] };
      } }),
    };
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'project-1', userId: 'owner-1' }] }) }) }),
      transaction: async (run) => run(tx),
    };
    const controller = new VersionsController(db, {});
    const result = await controller[operation]('project-1', '1', { user: { id: 'owner-1', role: 'engineer' } });
    assert.equal(result.data.version, 2);
  }
  assert.equal(executions.filter((sql) => sql.startsWith('INSERT INTO')).length, 6);
  assert.deepEqual(audits.map((audit) => audit.action), ['DUPLICATE_VERSION', 'ROLLBACK_VERSION']);
});

test('Nest includes OSM buildings mapped as point nodes like the reference implementation provider', async () => {
  const generator = new GeneratorService({});
  generator.fetchOsm = async () => ({
    elements: [{ type: 'node', id: 123, lon: 106.004, lat: -5.996, tags: { building: 'yes', name: 'Node House' } }],
    metadata: { source: 'fixture' },
  });
  const boundary = Buffer.from('<kml><Document><Placemark><name>Boundary</name><Polygon><outerBoundaryIs><LinearRing><coordinates>106,-6 106.01,-6 106.01,-5.99 106,-5.99 106,-6</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>');
  const pop = Buffer.from('<kml><Document><Placemark><name>OLT</name><Point><coordinates>106.001,-5.999,0</coordinates></Point></Placemark></Document></kml>');
  const result = await generator.generate(boundary, 'boundary.kml', pop, 'pop.kml', { no_road_feeder: true });
  assert.deepEqual(result.state.customers.map((house) => house.label), ['Node House']);
});

test('OSM multipolygon building points use the area-weighted centroid of every component like reference implementation', async () => {
  const generator = new GeneratorService({});
  const first = [[106.001, -6.001], [106.002, -6.001], [106.002, -6], [106.001, -6], [106.001, -6.001]];
  const second = [[106.004, -6.001], [106.007, -6.001], [106.007, -6], [106.004, -6], [106.004, -6.001]];
  generator.fetchOsm = async () => ({ elements: [{ type: 'relation', id: 10, tags: { building: 'yes' }, geometry: first, polygons: [{ outer: first, holes: [] }, { outer: second, holes: [] }] }], metadata: { source: 'fixture' } });
  const boundary = Buffer.from('<kml><Document><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>106,-6.01 106.01,-6.01 106.01,-5.99 106,-5.99 106,-6.01</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>');
  const pop = Buffer.from('<kml><Document><Placemark><name>OLT</name><Point><coordinates>106.001,-6.009,0</coordinates></Point></Placemark></Document></kml>');
  const result = await generator.generate(boundary, 'boundary.kml', pop, 'pop.kml', { allow_road_fallback: true });
  assert.deepEqual(result.state.customers[0].at, [106.0045, -6.0005]);
});

test('generation rejects an incomplete distribution tree like the reference implementation pipeline', () => {
  const assigned = [{ label: 'ODP-001' }, { label: 'ODP-002' }];
  assert.throws(
    () => requireCompleteDistributionTree('ODC-001', assigned, [{ target: 'ODP-001' }]),
    (error) => error instanceof HttpException
      && error.getStatus() === 500
      && error.getResponse().error.code === 'ROUTING_FAILED'
      && error.getResponse().error.message.includes('ODP-002'),
  );
  assert.doesNotThrow(() => requireCompleteDistributionTree('ODC-001', assigned, assigned.map((odp) => ({ target: odp.label }))));
});

test('generation aggregates disconnected ODPs across distribution trees like reference implementation', () => {
  const odcs = [
    { label: 'ODC-001', members: ['ODP-001'] },
    { label: 'ODC-002', members: ['ODP-002'] },
  ];
  const odps = [{ label: 'ODP-001' }, { label: 'ODP-002' }];
  assert.throws(
    () => requireDistributionConnectivity(odcs, odps, []),
    (error) => error instanceof HttpException
      && error.getStatus() === 500
      && error.getResponse().error.code === 'ROUTING_FAILED'
      && error.getResponse().error.message.includes('2 ODP belum tersambung ke jaringan jalan: ODP-001 (ODC ODC-001), ODP-002 (ODC ODC-002)'),
  );
});

test('same-edge fiber route follows the edge in reverse like reference implementation, even when a directed detour exists', () => {
  const graph = new Map();
  const a = [7.42521, 43.7374505], b = [7.4237917, 43.7375487];
  const c = [7.4238, 43.738], d = [7.42522, 43.738];
  addEdge(graph, a, b, 'secondary', 'priority_road', true, 120, ['a', 'b']);
  addEdge(graph, b, c, 'secondary', 'priority_road', true, 60, ['b', 'c']);
  addEdge(graph, c, d, 'secondary', 'priority_road', true, 120, ['c', 'd']);
  addEdge(graph, d, a, 'secondary', 'priority_road', true, 60, ['d', 'a']);

  const path = route(graph, [7.424248859, 43.737517047], [7.424744473, 43.737482732]);
  assert.equal(path.length, 4);
  assert.deepEqual(path[0], [7.424248859, 43.737517047]);
  assert.deepEqual(path.at(-1), [7.424744473, 43.737482732]);
});

test('fiber routes may use either endpoint of one-way road edges like reference implementation', () => {
  const graph = new Map();
  const a = [7.42, 43.73], b = [7.421, 43.73], c = [7.42, 43.731], d = [7.421, 43.731];
  addEdge(graph, a, b, 'residential', 'priority_road', true, 100, ['a', 'b']);
  addEdge(graph, c, a, 'residential', 'priority_road', true, 100, ['c', 'a']);
  addEdge(graph, b, d, 'residential', 'priority_road', true, 100, ['b', 'd']);
  addEdge(graph, d, c, 'residential', 'priority_road', true, 100, ['d', 'c']);

  const path = route(graph, [7.4207, 43.73], [7.42, 43.7303]);
  assert.ok(path.length < 8);
  assert.ok(!path.some((point) => point[0] === d[0] && point[1] === d[1]));
});

test('road spacing keeps reference implementation edge orientation when node IDs sort differently as strings', () => {
  const graph = new Map();
  const a = [7.42, 43.73], b = [7.421, 43.73];
  addEdge(graph, a, b, 'residential', 'shortest', false, 81, ['6696261618', '25191508']);
  const point = walkAlongRoad(graph, [7.42025, 43.73], 20, 1, 0);
  assert.ok(point);
  assert.ok(point[0] > 7.42025);
  assert.ok(Math.abs(point[1] - 43.73) < 1e-10);
});

test('road spacing cannot reverse an incoming one-way edge like reference implementation', () => {
  const graph = new Map();
  const a = [7.42, 43.73], b = [7.421, 43.73], c = [7.42, 43.731];
  addEdge(graph, a, b, 'residential', 'shortest', true, 81, ['a', 'b']);
  addEdge(graph, c, b, 'residential', 'shortest', true, 81, ['c', 'b']);
  assert.equal(walkAlongRoad(graph, b, 20, 1, 0), undefined);
});

test('road spacing uses reference implementation edge length at the exact movement boundary', () => {
  const graph = new Map();
  const a = [7.4200543, 43.7330672], b = [7.421227, 43.7331634], lengthM = 94.827, fraction = 40 / lengthM;
  addEdge(graph, a, b, 'residential', 'shortest', false, lengthM, ['from', 'to']);
  const origin = [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
  const point = walkAlongRoad(graph, origin, 40, -1, 0);
  assert.ok(point);
  assert.ok(Math.hypot(point[0] - a[0], point[1] - a[1]) < 1e-10);
});

test('HTTP exceptions keep previous API response shapes', () => {
  let actual;
  const filter = new ApiExceptionFilter({ httpAdapter: { reply: (_response, body, status) => { actual = { body, status }; } } });
  const host = { switchToHttp: () => ({ getResponse: () => ({}) }) };
  filter.catch(new BadRequestException('Invalid input'), host);
  assert.deepEqual(actual, { body: { detail: 'Invalid input' }, status: 400 });
  const envelope = { success: false, error: { code: 'VERSION_NOT_FOUND', message: 'Version not found' } };
  filter.catch(new HttpException(envelope, 404), host);
  assert.deepEqual(actual, { body: envelope, status: 404 });
});
