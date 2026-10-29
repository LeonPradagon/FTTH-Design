import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export const DEFAULT_OSM_PBF_URL = 'https://download.geofabrik.de/asia/indonesia-latest.osm.pbf';

export async function downloadOsmPbf(url: string, output: string, timeoutSeconds = 900) {
  const destination = resolve(output), temporary = `${destination}.${randomUUID()}.part`;
  await mkdir(dirname(destination), { recursive: true });
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const resetTimeout = () => { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000); };
  resetTimeout();
  const digest = createHash('sha256');
  let sourceTimestamp: string | null = null;
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'FTTH-Design OSM importer' }, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`OSM download failed: HTTP ${response.status}`);
    const lastModified = response.headers.get('last-modified');
    if (lastModified) {
      const parsed = new Date(lastModified);
      if (Number.isFinite(parsed.getTime())) sourceTimestamp = parsed.toISOString();
    }
    const hashStream = new Transform({ transform(chunk, _encoding, callback) { resetTimeout(); digest.update(chunk); callback(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body as any), hashStream, createWriteStream(temporary, { flags: 'wx' }));
    clearTimeout(timeout);
    await rename(temporary, destination);
    const downloadedAt = new Date().toISOString();
    const metadata = { source_url: url, source_timestamp: sourceTimestamp, downloaded_at: downloadedAt, sha256: digest.digest('hex'), bytes: (await stat(destination)).size };
    const metadataPath = `${destination}.meta.json`, metadataTemporary = `${metadataPath}.${randomUUID()}.tmp`;
    await writeFile(metadataTemporary, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
    await rename(metadataTemporary, metadataPath);
    return metadata;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

if (require.main === module) {
  const value = (name: string, fallback: string) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const url = value('--url', process.env.OSM_PBF_URL ?? DEFAULT_OSM_PBF_URL);
  const output = value('--output', process.env.OSM_PBF_PATH ?? 'data/osm/indonesia-latest.osm.pbf');
  const timeout = Number(value('--timeout', process.env.OSM_PBF_DOWNLOAD_TIMEOUT_SECONDS ?? '900'));
  void downloadOsmPbf(url, output, timeout).then((metadata) => {
    process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
