import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { Pool, PoolClient } from 'pg';
import { downloadOsmPbf, DEFAULT_OSM_PBF_URL } from './download-osm-pbf';

const DEFAULT_COVERAGE = [94, -11.5, 141.5, 6.5] as const;
export const flexStyle = String.raw`
local schema = assert(os.getenv('OSM_STAGE_SCHEMA'))
local function col(name, type)
  local column = { column = name, type = type }
  if type == 'geometry' or type == 'point' then column.projection = 4326 end
  return column
end
local buildings = osm2pgsql.define_table({ name = 'buildings', schema = schema, columns = {
  { column = 'osm_id', sql_type = 'bigint' }, col('geom', 'geometry')
}})
local building_members = osm2pgsql.define_table({ name = 'building_members', schema = schema, columns = {
  { column = 'way_id', sql_type = 'bigint' }
}})
local road_ways = osm2pgsql.define_table({ name = 'road_ways', schema = schema, columns = {
  { column = 'way_id', sql_type = 'bigint' }, col('highway', 'text'),
  col('oneway', 'bool'), col('reverse', 'bool'), col('name', 'text')
}})
local road_vertices = osm2pgsql.define_table({ name = 'road_vertices', schema = schema, columns = {
  { column = 'way_id', sql_type = 'bigint' }, { column = 'sequence', sql_type = 'integer' },
  { column = 'node_id', sql_type = 'bigint' }, col('geom', 'point')
}})
local pois = osm2pgsql.define_table({ name = 'pois', schema = schema, columns = {
  col('poi_id', 'text'), col('kind', 'text'), col('name', 'text'), col('geom', 'geometry')
}})

local drive = {
  motorway=true, motorway_link=true, trunk=true, trunk_link=true, primary=true,
  primary_link=true, secondary=true, secondary_link=true, tertiary=true,
  tertiary_link=true, unclassified=true, residential=true, living_street=true,
  road=true, emergency_access_point=true, bridge=true
}
local function uid(object)
  return object.id
end
local function poi_kind(tags)
  if tags.railway or tags.building == 'train_station' then return 'station' end
  if tags.office or tags.building == 'office' then return 'office' end
end
local function is_closed_to_driving(value)
  if not value then return false end
  for part in value:gmatch('[^;]+') do
    local normalized = part:match('^%s*(.-)%s*$')
    if normalized == 'no' or normalized == 'private' then return true end
  end
  return false
end
local function has_driving_access(tags)
  for _, key in ipairs({'motorcar', 'motor_vehicle', 'vehicle', 'access'}) do
    if tags[key] ~= nil then return not is_closed_to_driving(tags[key]) end
  end
  return true
end
local function add_poi(object, geom)
  local kind = poi_kind(object.tags)
  if kind and geom and not geom:is_null() then
    pois:insert({ poi_id = tostring(object.id), kind = kind, name = object.tags.name, geom = geom })
  end
end
local function drivable(tags)
  return drive[tags.highway] and tags.area ~= 'yes' and has_driving_access(tags)
end

function osm2pgsql.process_node(object)
  local tags = object.tags
  local geom = object:as_point()
  add_poi(object, geom)
end

function osm2pgsql.process_way(object)
  local tags = object.tags
  if tags.building and object.is_closed then
    local geom = object:as_polygon()
    if not geom:is_null() then buildings:insert({ osm_id = uid(object), geom = geom }) end
  end
  if drivable(tags) then
    road_ways:insert({ way_id = object.id, highway = tags.highway,
      oneway = tags.oneway == 'yes' or tags.oneway == 'true' or tags.oneway == '1' or tags.oneway == 'on' or tags.oneway == '-1',
      reverse = tags.oneway == '-1', name = tags.name })
    local sequence = 0
    for index, node_id in ipairs(object.nodes) do
      local point = object:as_point(index)
      if not point:is_null() then
        sequence = sequence + 1
        road_vertices:insert({ way_id = object.id, sequence = sequence, node_id = node_id, geom = point })
      end
    end
  end
  if poi_kind(tags) then
    add_poi(object, object.is_closed and object:as_polygon() or object:as_linestring())
  end
end

function osm2pgsql.process_relation(object)
  local tags = object.tags
  if tags.building then
    local geom = object:as_multipolygon()
    if not geom:is_null() then
      buildings:insert({ osm_id = uid(object), geom = geom })
      for _, member in ipairs(object.members) do
        if member.type == 'w' then building_members:insert({ way_id = member.ref }) end
      end
    end
  end
  if tags.railway or tags.office or tags.building == 'train_station' or tags.building == 'office' then
    add_poi(object, object:as_multipolygon())
  end
end
`;

function argument(name: string, fallback?: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

export function datasetSourceTimestamp(metadata: any, fileModifiedAt: Date, justDownloaded = false) {
  const source = metadata?.source_timestamp || (justDownloaded ? metadata?.downloaded_at : undefined);
  const parsed = source ? new Date(source) : undefined;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : fileModifiedAt;
}

export function importWorkerCount(value = process.env.OSM_IMPORT_WORKERS) {
  if (value === undefined || !/^\s*[+-]?\d(?:_?\d)*\s*$/.test(value)) return 1;
  return Math.min(32, Math.max(1, Number(value.replaceAll('_', '').trim())));
}

function parseBox(value: string | undefined, fallback: readonly number[]) {
  const parsed = value?.split(',').map(Number) ?? [...fallback];
  if (parsed.length !== 4 || parsed.some((number) => !Number.isFinite(number)) || parsed[0] >= parsed[2] || parsed[1] >= parsed[3]) {
    throw new Error('Cakupan harus berupa min_lon,min_lat,max_lon,max_lat.');
  }
  return parsed;
}

async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function pgEnvironment(connectionString: string) {
  const url = new URL(connectionString);
  const query = url.searchParams;
  return {
    PGHOST: decodeURIComponent(url.hostname), PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    ...(query.get('sslmode') ? { PGSSLMODE: query.get('sslmode')! } : {}),
  };
}

async function runOsm2pgsql(pbf: string, schema: string, workdir: string) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL belum dikonfigurasi.');
  const pgEnv = pgEnvironment(connectionString);
  const binary = process.env.OSM2PGSQL_BIN ?? 'osm2pgsql';
  const versionResult = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (versionResult.error) throw new Error('osm2pgsql tidak ditemukan. Pasang osm2pgsql 2.3.0+ secara lokal lalu ulangi.');
  const versionOutput = `${versionResult.stdout ?? ''}\n${versionResult.stderr ?? ''}`;
  const version = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 3)) {
    throw new Error('Importer membutuhkan osm2pgsql versi 2.3.0 atau lebih baru.');
  }
  const stylePath = resolve(workdir, 'osm-flex.lua');
  await writeFile(stylePath, flexStyle);
  await new Promise<void>((resolveRun, reject) => {
    const args = [
      '--create', '--slim', '--drop', '--output=flex', `--style=${stylePath}`,
      `--database=${pgEnv.PGDATABASE}`, `--schema=${schema}`, `--middle-schema=${schema}`, `--prefix=${schema}`,
      `--number-processes=${importWorkerCount()}`,
    ];
    args.push(pbf);
    const child = spawn(binary, args, { env: { ...process.env, OSM_STAGE_SCHEMA: schema, ...pgEnv } });
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(Object.assign(new Error(`osm2pgsql gagal (${signal ?? code}).`), { stderr }));
    });
  });
}

async function sortOsmPbf(pbf: string, output: string) {
  const binary = process.env.OSMIUM_BIN ?? 'osmium';
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(binary, ['sort', pbf, '-o', output], { stdio: 'inherit' });
    child.once('error', () => reject(new Error('Input PBF tidak terurut. Pasang osmium-tool secara lokal agar importer dapat mengurutkannya.')));
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`osmium sort gagal (${signal ?? code}).`)));
  });
}

async function importPbf(pbf: string, datasetId: string, sourceUrl: string, coverage: number[], bbox?: number[], includePois = true, timestampOverride?: Date) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL belum dikonfigurasi.');
  const pool = new Pool({ connectionString });
  const checksum = await sha256(pbf);
  const metadataPath = `${pbf}.meta.json`;
  let sourceTimestamp = timestampOverride ?? new Date((await stat(pbf)).mtimeMs);
  if (!timestampOverride) {
    try {
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      sourceTimestamp = datasetSourceTimestamp(metadata, sourceTimestamp);
    } catch { /* A downloaded PBF may have no metadata sidecar. */ }
  }
  const schema = `osm_stage_${randomUUID().replaceAll('-', '')}`;
  let client: PoolClient;
  try { client = await pool.connect(); }
  catch (error) { await pool.end(); throw error; }
  let stagingCreated = false;
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT status FROM osm_data.dataset WHERE dataset_id = $1', [datasetId]);
    if (existing.rows[0]?.status === 'active') throw new Error(`Dataset OSM ${datasetId} sudah aktif; gunakan dataset-id baru.`);
    if (existing.rowCount) await client.query('DELETE FROM osm_data.dataset WHERE dataset_id = $1', [datasetId]);
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`INSERT INTO osm_data.dataset(dataset_id, source_url, source_timestamp, checksum, status, coverage) VALUES ($1,$2,$3,$4,'staging',ST_MakeEnvelope($5,$6,$7,$8,4326))`, [datasetId, sourceUrl, sourceTimestamp, checksum, ...coverage]);
    await client.query('COMMIT');
    stagingCreated = true;

    const workdir = await mkdtemp(resolve(tmpdir(), 'ftth-osm-'));
    try {
      try { await runOsm2pgsql(pbf, schema, workdir); }
      catch (error) {
        if (!/Input data is not ordered/.test((error as any)?.stderr ?? '')) throw error;
        const sortedPbf = resolve(workdir, 'sorted.osm.pbf');
        await sortOsmPbf(pbf, sortedPbf);
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await client.query(`CREATE SCHEMA "${schema}"`);
        await runOsm2pgsql(sortedPbf, schema, workdir);
      }
    }
    finally { await rm(workdir, { recursive: true, force: true }); }
    await client.query('BEGIN');
    await client.query(`DELETE FROM "${schema}".buildings AS building
      USING "${schema}".building_members AS member
      WHERE building.osm_id = member.way_id`);
    const buildings = await client.query(`
      INSERT INTO osm_data.building(dataset_id, osm_id, geom)
      SELECT $1, osm_id, ST_SetSRID(geom,4326) FROM "${schema}".buildings
      WHERE NOT $2::boolean OR ST_Intersects(geom, ST_MakeEnvelope($3,$4,$5,$6,4326))
      ON CONFLICT (dataset_id, osm_id) DO NOTHING`, [datasetId, !!bbox, ...(bbox ?? [0, 0, 0, 0])]);
    await client.query(`
      INSERT INTO osm_data.road_node(dataset_id, node_id, geom)
      SELECT DISTINCT ON (node_id) $1, node_id, ST_SetSRID(geom,4326) FROM (
        SELECT v1.node_id, v1.geom, v1.way_id, v1.sequence FROM "${schema}".road_vertices v1
        JOIN "${schema}".road_vertices v2 ON v2.way_id=v1.way_id AND v2.sequence=v1.sequence+1
        WHERE NOT $2::boolean OR ST_Intersects(ST_MakeLine(v1.geom,v2.geom),ST_MakeEnvelope($3,$4,$5,$6,4326))
        UNION ALL
        SELECT v2.node_id, v2.geom, v2.way_id, v2.sequence FROM "${schema}".road_vertices v1
        JOIN "${schema}".road_vertices v2 ON v2.way_id=v1.way_id AND v2.sequence=v1.sequence+1
        WHERE NOT $2::boolean OR ST_Intersects(ST_MakeLine(v1.geom,v2.geom),ST_MakeEnvelope($3,$4,$5,$6,4326))
      ) vertices ORDER BY node_id, way_id, sequence
      ON CONFLICT (dataset_id,node_id) DO NOTHING`, [datasetId, !!bbox, ...(bbox ?? [0, 0, 0, 0])]);
    await client.query(`
      INSERT INTO osm_data.road_edge(dataset_id,edge_id,source_node,target_node,edge_index,geom,highway,length_m,oneway,name)
      SELECT $1, v1.way_id::text,
        CASE WHEN w.reverse THEN v2.node_id ELSE v1.node_id END,
        CASE WHEN w.reverse THEN v1.node_id ELSE v2.node_id END,
        v1.sequence - 1,
        ST_SetSRID(ST_MakeLine(CASE WHEN w.reverse THEN v2.geom ELSE v1.geom END,
          CASE WHEN w.reverse THEN v1.geom ELSE v2.geom END),4326), w.highway,
        ST_DistanceSphere(
          CASE WHEN w.reverse THEN v2.geom ELSE v1.geom END,
          CASE WHEN w.reverse THEN v1.geom ELSE v2.geom END
        )::double precision, w.oneway, w.name
      FROM "${schema}".road_vertices v1
      JOIN "${schema}".road_vertices v2 ON v2.way_id = v1.way_id AND v2.sequence = v1.sequence + 1
      JOIN "${schema}".road_ways w ON w.way_id = v1.way_id
      WHERE NOT $2::boolean OR ST_Intersects(ST_MakeLine(v1.geom,v2.geom),ST_MakeEnvelope($3,$4,$5,$6,4326))
      ON CONFLICT (dataset_id,edge_id,edge_index) DO NOTHING`, [datasetId, !!bbox, ...(bbox ?? [0, 0, 0, 0])]);
    let poiCount = 0;
    if (includePois) {
      try {
        await client.query('SAVEPOINT osm_pois');
        const pois = await client.query(`INSERT INTO osm_data.poi(dataset_id,poi_id,kind,name,geom)
          SELECT $1,poi_id,kind,name,ST_SetSRID(ST_PointOnSurface(geom),4326) FROM "${schema}".pois
          WHERE NOT $2::boolean OR ST_Intersects(geom,ST_MakeEnvelope($3,$4,$5,$6,4326))
          ON CONFLICT (dataset_id,poi_id) DO NOTHING`, [datasetId, !!bbox, ...(bbox ?? [0, 0, 0, 0])]);
        poiCount = pois.rowCount ?? 0;
        await client.query('RELEASE SAVEPOINT osm_pois');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT osm_pois');
        await client.query('RELEASE SAVEPOINT osm_pois');
        process.stderr.write(`Peringatan: POI tidak berhasil diimport, lanjut tanpa POI: ${error instanceof Error ? error.message : error}\n`);
      }
    }
    const counts = await client.query(`SELECT
      (SELECT count(*)::int FROM osm_data.building WHERE dataset_id=$1) AS buildings,
      (SELECT count(*)::int FROM osm_data.road_node WHERE dataset_id=$1) AS nodes,
      (SELECT count(*)::int FROM osm_data.road_edge WHERE dataset_id=$1) AS edges`, [datasetId]);
    const count = counts.rows[0];
    if (!buildings.rowCount || count.buildings === 0) throw new Error('Import PBF tidak memiliki building; dataset tidak diaktifkan.');
    if (count.nodes === 0 || count.edges === 0) throw new Error('Import PBF tidak memiliki road node/edge; dataset tidak diaktifkan.');
    await client.query(`UPDATE osm_data.dataset SET building_count=$2, road_node_count=$3, road_edge_count=$4, poi_count=$5 WHERE dataset_id=$1`, [datasetId, count.buildings, count.nodes, count.edges, poiCount]);
    await client.query(`UPDATE osm_data.dataset SET status='failed' WHERE status='active' AND dataset_id<>$1`, [datasetId]);
    await client.query(`UPDATE osm_data.dataset SET status='active' WHERE dataset_id=$1`, [datasetId]);
    await client.query('COMMIT');
    return { dataset_id: datasetId, checksum, building_count: count.buildings, road_node_count: count.nodes, road_edge_count: count.edges, poi_count: poiCount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (stagingCreated) {
      await client.query(`UPDATE osm_data.dataset SET status='failed' WHERE dataset_id=$1`, [datasetId]).catch(() => undefined);
    }
    throw error;
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

async function main() {
  const pbfArg = argument('--pbf');
  const sourceUrl = argument('--source-url', process.env.OSM_PBF_URL ?? DEFAULT_OSM_PBF_URL)!;
  const pbf = resolve(pbfArg ?? process.env.OSM_PBF_PATH ?? 'data/osm/indonesia-latest.osm.pbf');
  const datasetId = argument('--dataset-id', new Date().toISOString().slice(0, 10))!;
  const coverage = parseBox(argument('--coverage', process.env.OSM_PBF_COVERAGE), DEFAULT_COVERAGE);
  const bboxText = argument('--bbox');
  const bbox = bboxText ? parseBox(bboxText, DEFAULT_COVERAGE) : undefined;
  let timestampOverride = argument('--source-timestamp');
  if (process.argv.includes('--download')) {
    const metadata = await downloadOsmPbf(sourceUrl, pbf, Number(process.env.OSM_PBF_DOWNLOAD_TIMEOUT_SECONDS ?? 900));
    process.stdout.write(`${JSON.stringify({ download: metadata })}\n`);
    timestampOverride ??= metadata.source_timestamp ?? metadata.downloaded_at;
  } else if (!pbfArg && process.env.DOWNLOAD_OSM_PBF === 'true') {
    const metadata = await downloadOsmPbf(sourceUrl, pbf, Number(process.env.OSM_PBF_DOWNLOAD_TIMEOUT_SECONDS ?? 900));
    process.stdout.write(`${JSON.stringify({ download: metadata })}\n`);
    timestampOverride ??= metadata.source_timestamp ?? metadata.downloaded_at;
  }
  const explicitTimestamp = timestampOverride ? new Date(timestampOverride) : undefined;
  if (explicitTimestamp && !Number.isFinite(explicitTimestamp.getTime())) throw new Error('--source-timestamp harus berupa tanggal valid.');
  const result = await importPbf(pbf, datasetId, sourceUrl, coverage, bbox, !process.argv.includes('--without-pois'), explicitTimestamp);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
