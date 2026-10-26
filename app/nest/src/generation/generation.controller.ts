import { BadRequestException, Controller, ForbiddenException, Get, HttpException, Inject, NotFoundException, OnModuleDestroy, OnModuleInit, Param, Post, Query, Req, Res, Sse, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { Pool, PoolClient } from 'pg';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Observable } from 'rxjs';
import { DB, PG_POOL } from '../db/database.module';
import { auditLogs, designVersions, generationJobs, projects, users } from '../db/schema';
import { ProxyAuthGuard } from '../auth/proxy-auth.guard';
import { StorageService } from '../storage/storage.service';
import { GeneratorService, normalizeCachedState, pythonBoolean, readKml } from './generator.service';
import { invalidFile, missingFile, validateDesignUpload } from '../files/upload-validation';
import { GenerationRateLimiter } from '../auth/generation-rate-limiter';

const GENERATION_ROLES = ['admin', 'engineer', 'user'];
const GENERATION_CONFIG_FIELDS = new Set(['odp_capacity', 'odc_capacity', 'min_odp_cluster_size', 'min_odc_cluster_size', 'include_homepass', 'force_refresh_osm', 'max_odp_radius_m', 'max_odc_radius_m', 'max_feeder_length_m', 'max_distribution_length_m', 'snapping_distance_m', 'routing_strategy']);
const MAX_UPLOAD = Number(process.env.MAX_BATCH_FILE_BYTES ?? 50 * 1024 * 1024);
const MAX_SINGLE_UPLOAD = Number(process.env.MAX_UPLOAD_FILE_BYTES ?? process.env.MAX_BATCH_FILE_BYTES ?? 50 * 1024 * 1024);
const scope = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const coreConfig = (options: any) => Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'feature_colors').sort(([a], [b]) => a.localeCompare(b)));
const safeBase = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase().replace(/(boundary|polygon|area|pop|olt|sentral|rbs)/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';
const batchSlug = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase().replace(/(boundary|pop|olt|polygon|point)/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';
const isPopFile = (name: string) => /(pop|olt|sentral|rbs)/i.test(name);
const isBoundaryFile = (name: string) => !isPopFile(name) && /(boundary|polygon|area)/i.test(name);
const popMarker = /(?<![A-Z0-9])(?:POP|OLT|SENTRAL|RBS)(?:\s*[-_ ]?\s*\d+)?(?![A-Z0-9])/i;
const xml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
const kmlCoords = (coords: number[][]) => coords.map(([lon, lat]) => `${lon},${lat},0`).join(' ');
function makeBatchKml(placemarks: any[], kind: 'boundary' | 'pop') {
  const items = placemarks.flatMap((mark) => kind === 'boundary' && mark.polygon ? [
    `<Placemark><name>${xml(mark.name || 'Boundary')}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(mark.polygon.outer)}</coordinates></LinearRing></outerBoundaryIs>${mark.polygon.holes.map((ring: number[][]) => `<innerBoundaryIs><LinearRing><coordinates>${kmlCoords(ring)}</coordinates></LinearRing></innerBoundaryIs>`).join('')}</Polygon></Placemark>`,
  ] : kind === 'pop' && mark.point ? [`<Placemark><name>${xml(mark.name || 'POP')}</name><Point><coordinates>${mark.point[0]},${mark.point[1]},0</coordinates></Point></Placemark>`] : []);
  if (!items.length) throw new BadRequestException(kind === 'boundary' ? 'Tidak ditemukan Polygon pada file boundary.' : 'Tidak ditemukan Placemark POP berupa Point.');
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${items.join('')}</Document></kml>`);
}
const filename = (prefix: string, ext: string) => `${prefix}_${Math.floor(Date.now() / 1000)}_${randomBytes(5).toString('hex')}.${ext}`;
const userPrefix = (id: string) => `users/${scope(id)}/`;
export function latestBatchRows(rows: any[]) {
  const latest = new Map<string, any>();
  for (const row of [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())) {
    const key = String(row.itemId ?? row.id);
    if (!latest.has(key)) latest.set(key, row);
  }
  return [...latest.values()];
}
export function summarizeBatchJobs(jobs: any[]) {
  const completed = jobs.filter((job) => job.status === 'COMPLETED').length;
  const failed = jobs.filter((job) => ['FAILED', 'SKIPPED', 'CANCELED'].includes(job.status)).length;
  const active = jobs.some((job) => ['QUEUED', 'RUNNING'].includes(job.status));
  return { total: jobs.length, completed, failed, status: active ? (completed || failed ? 'RUNNING' : 'QUEUED') : 'COMPLETED' };
}
function outputName(result: any, key: 'kmz' | 'csv') {
  const saved = result?.[`${key}Name`];
  if (typeof saved === 'string' && saved) return saved;
  const url = result?.[`${key}_url`] ?? (key === 'kmz' ? result?.url : undefined);
  if (typeof url !== 'string') return undefined;
  try { return decodeURIComponent(new URL(url, 'http://localhost').pathname.split('/').pop() ?? ''); }
  catch { return undefined; }
}

@Controller()
@UseGuards(ProxyAuthGuard)
export class GenerationController implements OnModuleInit, OnModuleDestroy {
  private readonly progress = new Map<string, any>();
  private readonly canceled = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly pending: { jobId: string; user: any; input: any }[] = [];
  private readonly scheduledIds = new Set<string>();
  private activeJobs = 0;
  private pollingQueue = false;
  private lastRecoveryAt = 0;
  private queueTimer?: NodeJS.Timeout;
  private readonly maxJobs = Math.max(1, Number(process.env.GENERATION_MAX_JOBS ?? 2));
  private readonly cacheRoot = process.env.USER_CACHE_ROOT ?? join(tmpdir(), 'ftth_cache');

  constructor(@Inject(DB) private readonly db: any, private readonly storage: StorageService, private readonly generator: GeneratorService, private readonly rateLimiter: GenerationRateLimiter, @Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit() {
    await this.pollQueue();
    this.queueTimer = setInterval(() => { void this.pollQueue().catch(() => undefined); }, 1000);
    this.queueTimer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.queueTimer);
  }

  private async withJobLock(jobId: string): Promise<PoolClient | undefined> {
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [jobId]);
      if (result.rows[0]?.locked) return client;
      client.release();
      return undefined;
    } catch (error) {
      client.release();
      throw error;
    }
  }

  private async releaseJobLock(client: PoolClient, jobId: string) {
    try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [jobId]); }
    finally { client.release(); }
  }

  private async recoverStaleJobs() {
    const staleBefore = new Date(Date.now() - 60 * 60 * 1000);
    const stale = await this.db.select().from(generationJobs)
      .where(and(eq(generationJobs.status, 'RUNNING'), lt(generationJobs.updatedAt, staleBefore))).limit(100);
    for (const job of stale) {
      const lock = await this.withJobLock(job.id);
      if (!lock) continue;
      try {
        await this.db.update(generationJobs)
          .set({ status: 'QUEUED', stage: 'QUEUED', progress: 1, updatedAt: new Date() })
          .where(and(eq(generationJobs.id, job.id), eq(generationJobs.status, 'RUNNING'), lt(generationJobs.updatedAt, staleBefore)));
      } finally {
        await this.releaseJobLock(lock, job.id);
      }
    }
  }

  private async pollQueue() {
    if (this.pollingQueue) return;
    this.pollingQueue = true;
    try {
      if (Date.now() - this.lastRecoveryAt >= 60_000) {
        await this.recoverStaleJobs();
        this.lastRecoveryAt = Date.now();
      }
      const rows = await this.db.select().from(generationJobs).where(eq(generationJobs.status, 'QUEUED'))
        .orderBy(asc(generationJobs.createdAt)).limit(Math.max(10, this.maxJobs * 2));
      for (const job of rows) {
        if (this.scheduledIds.has(job.id) || !job.result) continue;
        const [user] = await this.db.select().from(users).where(eq(users.id, job.userId)).limit(1);
        if (!user) continue;
        const input = job.result;
        this.progress.set(job.id, { user_id: job.userId, batch_id: job.batchId, stage: 'QUEUED', message: 'Melanjutkan job yang masih antre...', percent: 1, status: 'QUEUED', done: false, result: input });
        this.schedule(job.id, { id: user.id, role: user.role ?? 'engineer', email: user.email }, { ...input, inputPaths: input.input_paths, projectId: job.projectId ?? undefined, batchId: job.batchId ?? undefined, itemId: job.itemId ?? undefined });
      }
    } finally {
      this.pollingQueue = false;
    }
  }

  private schedule(jobId: string, user: any, input: any) {
    if (this.scheduledIds.has(jobId)) return;
    this.scheduledIds.add(jobId);
    this.pending.push({ jobId, user, input });
    this.pump();
  }

  private pump() {
    while (this.activeJobs < this.maxJobs && this.pending.length) {
      const task = this.pending.shift()!;
      if (this.canceled.has(task.jobId)) { this.canceled.delete(task.jobId); this.scheduledIds.delete(task.jobId); continue; }
      this.activeJobs++;
      void this.run(task.jobId, task.user, task.input).finally(() => {
        this.canceled.delete(task.jobId);
        this.scheduledIds.delete(task.jobId);
        this.activeJobs--;
        this.pump();
      });
    }
  }

  private async generationUser(req: any) {
    if (!GENERATION_ROLES.includes(req.user.role)) throw new ForbiddenException('Generation access is not allowed');
    await this.rateLimiter.consume(req.user.id, req.res);
    return req.user;
  }

  private async requireProject(projectId: string | undefined, user: any) {
    if (!projectId) return;
    const [project] = await this.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) throw new NotFoundException('Project tidak ditemukan.');
    if (user.role !== 'viewer' && project.userId !== user.id) throw new ForbiddenException('Project tidak dapat diakses.');
  }

  private cacheFile(userId: string, projectId: string | undefined, batchId: string | undefined, itemId: string | undefined) {
    return join(this.cacheRoot, scope(userId), scope(projectId ?? 'default-project'), scope(batchId ?? 'single-job'), scope(itemId ?? 'single-item'), 'network.json');
  }

  private async cleanupStaleInputs(userId: string, projectId?: string, maxAgeMs = 60 * 60 * 1000) {
    const root = join(this.cacheRoot, scope(userId), scope(projectId ?? 'default-project'));
    const cutoff = Date.now() - maxAgeMs;
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error: any) { if (error?.code === 'ENOENT') return; throw error; }
      await Promise.all(entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'inputs') {
            const inputs = await readdir(path, { withFileTypes: true });
            await Promise.all(inputs.filter((file) => file.isFile() && /^(boundary|pop|custom)\.(kml|kmz)$/i.test(file.name)).map(async (file) => {
              const inputPath = join(path, file.name);
              try { if ((await stat(inputPath)).mtimeMs < cutoff) await rm(inputPath, { force: true }); }
              catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
            }));
          } else await walk(path);
        }
      }));
    };
    await walk(root);
  }

  private async resolveCacheFile(userId: string, projectId: string | undefined, batchId: string | undefined, itemId: string | undefined) {
    const dirs = [dirname(this.cacheFile(userId, projectId, batchId, itemId))];
    if (projectId) dirs.push(dirname(this.cacheFile(userId, undefined, batchId, itemId)));
    for (const dir of dirs) for (const name of ['network.json', 'design_state.json']) {
      const path = join(dir, name);
      try { return { path, state: normalizeCachedState(JSON.parse(await readFile(path, 'utf8'))) }; }
      catch (error: any) {
        if (error?.code === 'ENOENT') continue;
        throw new BadRequestException('Cache Network Core rusak atau tidak didukung.');
      }
    }
    throw new BadRequestException('Cache Network Core belum tersedia. Jalankan Generate Design terlebih dahulu.');
  }

  private async update(jobId: string, patch: any) {
    const state = { ...(this.progress.get(jobId) ?? {}), ...patch };
    this.progress.set(jobId, state);
    await this.db.update(generationJobs).set({ status: state.status, stage: state.stage, progress: state.percent, error: state.error ?? null, ...(state.result === undefined ? {} : { result: state.result }), updatedAt: new Date() }).where(eq(generationJobs.id, jobId));
  }

  private async recordVersion(projectId: string | undefined, user: any, result: any, options: any, kmzName: string, csvName: string) {
    if (!projectId) return;
    await this.db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`);
      const [last] = await tx.select({ version: designVersions.version }).from(designVersions).where(eq(designVersions.projectId, projectId)).orderBy(desc(designVersions.version)).limit(1);
      const versionId = randomUUID(), version = (last?.version ?? 0) + 1;
      const metadata = {
        ...result.metadata,
        artifacts: {
          kmz: `${userPrefix(user.id)}${kmzName}`,
          csv: `${userPrefix(user.id)}${csvName}`,
        },
      };
      await tx.insert(designVersions).values({ id: versionId, projectId, version, config: options, metadata, validation: result.validation, stats: result.stats, status: 'COMPLETED' });
      const odcIds = new Map<string, string>();
      for (const odc of result.state.odcs) {
        const odcId = randomUUID(); odcIds.set(odc.label, odcId);
        await tx.execute(sql`INSERT INTO "design_odc" ("id", "designVersionId", "label", "location") VALUES (${odcId}, ${versionId}, ${odc.label}, ST_SetSRID(ST_MakePoint(${odc.at[0]}, ${odc.at[1]}),4326))`);
      }
      for (const odp of result.state.odps) {
        const parent = result.state.odcs.find((odc: any) => odc.members?.includes(odp.label));
        if (!parent) continue;
        await tx.execute(sql`INSERT INTO "design_odp" ("id", "designVersionId", "odcId", "label", "location") VALUES (${randomUUID()}, ${versionId}, ${odcIds.get(parent.label)}, ${odp.label}, ST_SetSRID(ST_MakePoint(${odp.at[0]}, ${odp.at[1]}),4326))`);
      }
      for (const cable of result.state.cables) {
        const path = `LINESTRING(${cable.coords.map((c: number[]) => `${c[0]} ${c[1]}`).join(',')})`;
        await tx.execute(sql`INSERT INTO "design_cable" ("id", "designVersionId", "type", "sourceLabel", "targetLabel", "length", "path") VALUES (${randomUUID()}, ${versionId}, ${cable.type}, ${cable.source}, ${cable.target}, ${cable.length}, ST_GeomFromText(${path},4326))`);
      }
      await tx.insert(auditLogs).values({ id: randomUUID(), userId: user.id, action: 'GENERATE', projectId, versionId, details: { version, stats: result.stats } });
    });
  }

  private async run(jobId: string, user: any, input: any) {
    let lock: PoolClient | undefined;
    let cancelCheck: NodeJS.Timeout | undefined;
    let checkingCancel = false;
    let abortController: AbortController | undefined;
    try {
      lock = await this.withJobLock(jobId);
      if (!lock) return;
      const [claimed] = await this.db.update(generationJobs)
        .set({ status: 'RUNNING', stage: 'PARSING', progress: 5, error: null, updatedAt: new Date() })
        .where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, 'QUEUED')))
        .returning({ id: generationJobs.id });
      if (!claimed) return;
      abortController = new AbortController();
      this.abortControllers.set(jobId, abortController);
      cancelCheck = setInterval(async () => {
        if (checkingCancel || abortController!.signal.aborted) return;
        checkingCancel = true;
        try {
          const [job] = await this.db.select({ status: generationJobs.status }).from(generationJobs).where(eq(generationJobs.id, jobId)).limit(1);
          if (job?.status === 'CANCELED') abortController!.abort(new DOMException('Job dibatalkan.', 'AbortError'));
        } catch { /* transient database errors are retried on the next poll */ }
        finally { checkingCancel = false; }
      }, 1000);
      cancelCheck.unref();
      this.progress.set(jobId, { ...(this.progress.get(jobId) ?? {}), user_id: user.id, batch_id: input.batchId, status: 'RUNNING', stage: 'PARSING', message: 'Membaca file KML/KMZ...', percent: 5, done: false });
      const options = input.options ?? {};
      const checkpointDir = input.inputPaths?.boundary ? join(dirname(input.inputPaths.boundary), '..', 'osm_checkpoints', scope(jobId)) : undefined;
      let result: any;
      if (input.operation === 'custom') {
        const custom = input.custom ?? { buffer: await readFile(input.inputPaths.boundary), originalname: input.inputPaths.boundaryName };
        result = await this.generator.generateCustom(custom.buffer, custom.originalname, options, checkpointDir, abortController.signal);
      } else if (input.operation) {
        const cache = JSON.parse(await readFile(input.cachePath, 'utf8'));
        result = await this.generator.fromCache(cache, options, input.operation, abortController.signal);
      } else {
        const boundary = input.boundary ?? { buffer: await readFile(input.inputPaths.boundary), originalname: input.inputPaths.boundaryName };
        const pop = input.pop ?? (input.inputPaths.pop ? { buffer: await readFile(input.inputPaths.pop), originalname: input.inputPaths.popName } : undefined);
        const corePath = this.cacheFile(user.id, input.projectId, input.batchId, input.itemId);
        const manifestPath = corePath.replace(/network\.json$/, 'core-manifest.json');
        const inputHash = createHash('sha256').update(boundary.buffer).update(pop?.buffer ?? Buffer.alloc(0)).digest('hex');
        const config = coreConfig(options);
        if (!options.include_homepass && !options.force_refresh_osm && input.inputPaths) {
          const sourceSignature = await this.generator.coreSourceSignature(boundary.buffer, boundary.originalname);
          if (sourceSignature) {
            try {
              const [manifest, cachedBytes] = await Promise.all([readFile(manifestPath, 'utf8').then(JSON.parse), readFile(corePath)]);
              const cached = JSON.parse(cachedBytes.toString('utf8'));
              const valid = manifest.format_version === 1 && manifest.generator_version === '1.9.0'
                && manifest.input_hash === inputHash && manifest.has_custom_pop === Boolean(pop)
                && manifest.config === JSON.stringify(config) && manifest.source_signature === sourceSignature
                && manifest.state_hash === createHash('sha256').update(cachedBytes).digest('hex');
              if (valid) {
                result = await this.generator.reuseCore(cached, options);
                result.metadata = manifest.metadata ?? {};
              }
            } catch { /* a missing or stale core cache falls through to generation */ }
          }
        }
        if (!result) {
          if (input.inputPaths) await Promise.all([
            rm(corePath, { force: true }), rm(manifestPath, { force: true }),
            rm(join(dirname(corePath), 'design_state.json'), { force: true }),
            rm(join(dirname(corePath), 'core_manifest.json'), { force: true }),
            rm(join(dirname(corePath), 'road_graph.pkl'), { force: true }),
          ]);
          await this.update(jobId, { stage: 'OSM', message: 'Mengambil data jalan dan bangunan OSM...', percent: 15 });
          result = await this.generator.generate(boundary.buffer, boundary.originalname, pop?.buffer, pop?.originalname, options, checkpointDir, abortController.signal);
        }
      }
      if (abortController.signal.aborted || this.canceled.has(jobId)) return;
      const kmzName = input.kmzName ?? filename('design_ftth', 'kmz'), csvName = input.csvName ?? filename('design_ftth', 'csv');
      await this.storage.upload(`${userPrefix(user.id)}${kmzName}`, result.kmz, 'application/vnd.google-earth.kmz', kmzName);
      await this.storage.upload(`${userPrefix(user.id)}${csvName}`, result.csv, 'text/csv; charset=utf-8', csvName);
      if (abortController.signal.aborted || this.canceled.has(jobId)) return;
      if (!input.operation || input.operation === 'regenerate' || input.operation === 'custom') {
        const path = this.cacheFile(user.id, input.projectId, input.batchId, input.itemId);
        await mkdir(join(path, '..'), { recursive: true });
        const stateBytes = Buffer.from(JSON.stringify(result.state));
        const stateTemporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(stateTemporary, stateBytes);
        await rename(stateTemporary, path);
        if (!input.operation && input.inputPaths) {
          const boundary = input.boundary ?? { buffer: await readFile(input.inputPaths.boundary) };
          const pop = input.pop ?? (input.inputPaths.pop ? { buffer: await readFile(input.inputPaths.pop) } : undefined);
          const metadata = result.metadata ?? {};
          const sourceSignature = metadata.source === 'osm_postgis' && metadata.dataset_id
            ? `osm_postgis:${metadata.dataset_id}`
            : metadata.source === 'osm_online' ? 'osm_online' : undefined;
          if (sourceSignature) {
            const manifest = {
              format_version: 1, generator_version: '1.9.0',
              input_hash: createHash('sha256').update(boundary.buffer).update(pop?.buffer ?? Buffer.alloc(0)).digest('hex'),
              has_custom_pop: Boolean(pop), config: JSON.stringify(coreConfig(options)), source_signature: sourceSignature,
              state_hash: createHash('sha256').update(stateBytes).digest('hex'), metadata,
            };
            const manifestPath = path.replace(/network\.json$/, 'core-manifest.json'), temporary = `${manifestPath}.${randomUUID()}.tmp`;
            await writeFile(temporary, JSON.stringify(manifest));
            await rename(temporary, manifestPath);
          }
        }
      }
      if (abortController.signal.aborted || this.canceled.has(jobId)) return;
      if (!input.operation) await this.recordVersion(input.projectId, user, result, options, kmzName, csvName);
      const output = { url: `/api/files/${encodeURIComponent(kmzName)}`, kmz_url: `/api/files/${encodeURIComponent(kmzName)}`, csv_url: `/api/files/${encodeURIComponent(csvName)}`, stats: result.stats, validation: result.validation, ...(input.inputPaths ? { input_paths: input.inputPaths, options } : {}), ...(input.batch_item ? { batch_item: input.batch_item } : {}) };
      await this.update(jobId, { status: 'COMPLETED', stage: 'COMPLETED', message: 'Generation selesai.', percent: 100, done: true, result: output });
    } catch (error: any) {
      if (abortController?.signal.aborted || this.canceled.has(jobId)) return;
      const response = error instanceof HttpException ? error.getResponse() : undefined;
      const message = typeof response === 'object' && response && 'error' in response && typeof (response as any).error?.message === 'string'
        ? (response as any).error.message
        : error instanceof Error ? error.message : 'Generation gagal.';
      await this.update(jobId, { status: 'FAILED', stage: 'FAILED', message, error: message, percent: 100, done: true });
    } finally {
      if (cancelCheck) clearInterval(cancelCheck);
      if (this.abortControllers.get(jobId) === abortController) this.abortControllers.delete(jobId);
      if (lock) await this.releaseJobLock(lock, jobId);
    }
  }

  private async persistInputs(userId: string, projectId: string | undefined, batchId: string | undefined, itemId: string | undefined, boundary: any, pop?: any) {
    await this.cleanupStaleInputs(userId, projectId);
    const dir = join(this.cacheFile(userId, projectId, batchId, itemId), '..', 'inputs');
    await mkdir(dir, { recursive: true });
    const boundaryPath = join(dir, `boundary${boundary.originalname.toLowerCase().endsWith('.kmz') ? '.kmz' : '.kml'}`);
    await writeFile(boundaryPath, boundary.buffer);
    let popPath: string | undefined;
    if (pop) { popPath = join(dir, `pop${pop.originalname.toLowerCase().endsWith('.kmz') ? '.kmz' : '.kml'}`); await writeFile(popPath, pop.buffer); }
    return { boundary: boundaryPath, boundaryName: boundary.originalname, pop: popPath, popName: pop?.originalname };
  }

  private async enqueue(user: any, input: any, batchId?: string, itemId?: string) {
    const jobId = input.jobId || randomUUID();
    await this.db.insert(generationJobs).values({ id: jobId, userId: user.id, projectId: input.projectId ?? null, batchId: batchId ?? null, itemId: itemId ?? null, status: 'QUEUED', stage: 'QUEUED', progress: 1, result: input.persistedInput ?? null, updatedAt: new Date() });
    const jobInput = input.persistedInput ?? { input_paths: input.inputPaths, options: input.options, operation: input.operation, cachePath: input.cachePath, kmzName: input.kmzName, csvName: input.csvName };
    this.progress.set(jobId, { user_id: user.id, batch_id: batchId, stage: 'QUEUED', message: 'Menunggu worker memproses job...', percent: 1, status: 'QUEUED', done: false, result: jobInput });
    this.schedule(jobId, user, { ...input, persistedInput: jobInput });
    return jobId;
  }

  @Post('generate')
  @UseInterceptors(FileFieldsInterceptor([{ name: 'boundaryFile', maxCount: 1 }, { name: 'popFile', maxCount: 1 }], { limits: { fileSize: MAX_SINGLE_UPLOAD } }))
  async generate(@UploadedFiles() files: any, @Req() req: any) {
    const user = await this.generationUser(req), boundary = files?.boundaryFile?.[0], pop = files?.popFile?.[0];
    if (!boundary) throw invalidFile('Boundary KML/KMZ wajib diunggah.');
    await validateDesignUpload(boundary, MAX_SINGLE_UPLOAD);
    if (pop) await validateDesignUpload(pop, MAX_SINGLE_UPLOAD);
    const projectId = req.body?.project_id;
    if (!projectId) throw new BadRequestException('Project wajib disimpan sebelum generation.');
    await this.requireProject(projectId, user);
    const options = this.parseOptions(req.body);
    const inputPaths = await this.persistInputs(user.id, projectId, undefined, undefined, boundary, pop);
    const jobId = await this.enqueue(user, { inputPaths, projectId, jobId: req.body?.job_id, options, persistedInput: { input_paths: inputPaths, options } });
    return { success: true, data: { message: 'Generation job accepted.', job_id: jobId } };
  }

  @Post('generate/batch')
  @UseInterceptors(FilesInterceptor('files', Number(process.env.MAX_BATCH_FILES ?? 100), { limits: { fileSize: MAX_UPLOAD, files: Number(process.env.MAX_BATCH_FILES ?? 100) } }))
  async batch(@UploadedFiles() files: any[], @Req() req: any) {
    const user = await this.generationUser(req), projectId = req.body?.project_id;
    if (!files?.length) throw missingFile('files');
    if (!projectId) throw new BadRequestException('Project wajib disimpan sebelum generation.');
    const maxFiles = Number(process.env.MAX_BATCH_FILES ?? 100);
    if (files.length > maxFiles) throw new HttpException(`Maksimal ${maxFiles} file per batch.`, 413);
    await this.requireProject(projectId, user);
    const parsed = await Promise.all(files.map(async (file) => {
      await validateDesignUpload(file, MAX_UPLOAD);
      return { file, marks: await readKml(file.buffer, file.originalname) };
    }));
    const boundaries = parsed.filter(({ file }) => isBoundaryFile(file.originalname));
    const pops = parsed.filter(({ file }) => isPopFile(file.originalname));
    for (const entry of parsed) {
      if (isBoundaryFile(entry.file.originalname) || isPopFile(entry.file.originalname)) continue;
      if (entry.marks.some((mark) => mark.polygon)) boundaries.push(entry);
      else if (entry.marks.some((mark) => mark.point)) pops.push(entry);
    }
    if (!boundaries.length) throw invalidFile('Tidak ditemukan file boundary dalam batch.');
    const batchId = randomUUID(), options = this.parseOptions(req.body);
    options.include_homepass = false;
    const forceRefresh = req.body?.force_refresh;
    try { options.force_refresh_osm = (forceRefresh === undefined ? false : pythonBoolean(forceRefresh, 'force_refresh')) || options.force_refresh_osm; }
    catch { throw new HttpException({ detail: [{ type: 'bool_parsing', loc: ['body', 'force_refresh'], msg: 'Input should be a valid boolean, unable to interpret input', input: forceRefresh }] }, 422); }
    const boundaryName = boundaries[0].file.originalname, name = batchSlug(boundaryName);
    const boundaryKml = makeBatchKml(boundaries.flatMap((entry) => entry.marks), 'boundary');
    const embeddedFile = boundaries.find((entry) => entry.marks.some((mark) => mark.point && popMarker.test(`${mark.context ?? ''} ${mark.name ?? ''}`)));
    const popMarks = embeddedFile
      ? embeddedFile.marks.filter((mark) => mark.point && popMarker.test(`${mark.context ?? ''} ${mark.name ?? ''}`))
      : pops[0]?.marks.filter((mark) => mark.point) ?? [];
    const popKml = popMarks.length ? makeBatchKml(popMarks, 'pop') : undefined;
    const itemId = randomBytes(6).toString('hex');
    const now = new Date().toISOString();
    const timestamp = `${now.slice(0, 10).replace(/-/g, '')}_${now.slice(11, 16).replace(':', '')}`;
    const outputPrefix = `FTTH_${name}_${timestamp}_${itemId.slice(0, 6)}_core`;
    const kmzName = `${outputPrefix}.kmz`, csvName = `${outputPrefix}.csv`;
    const inputDir = join(this.cacheFile(user.id, projectId, batchId, itemId), '..', 'inputs');
    await mkdir(inputDir, { recursive: true });
    const boundaryPath = join(inputDir, 'boundary.kml'); await writeFile(boundaryPath, boundaryKml);
    const popPath = popKml ? join(inputDir, 'pop.kml') : undefined;
    if (popPath && popKml) await writeFile(popPath, popKml);
    const inputPaths = { boundary: boundaryPath, boundaryName, pop: popPath, popName: embeddedFile?.file.originalname ?? pops[0]?.file.originalname };
    const batchItem = { design_name: name, boundary_name: boundaryName };
    const jobs: any[] = [];
    if (!popPath) {
      const jobId = `skipped-${randomBytes(5).toString('hex')}`;
      const item = { job_id: jobId, item_id: itemId, design_name: name, boundary_name: boundaryName, status: 'SKIPPED', error: 'POP pasangan tidak ditemukan.' };
      await this.db.insert(generationJobs).values({ id: jobId, userId: user.id, projectId, batchId, itemId, status: 'SKIPPED', stage: 'SKIPPED', progress: 100, error: item.error, result: { input_paths: inputPaths, options, batch_item: batchItem }, updatedAt: new Date() });
      jobs.push(item);
    } else {
      const persistedInput = { input_paths: inputPaths, options, batch_item: batchItem, kmzName, csvName };
      const jobId = await this.enqueue(user, { inputPaths, projectId, options, batchItem, kmzName, csvName, persistedInput }, batchId, itemId);
      jobs.push({ job_id: jobId, item_id: itemId, design_name: name, boundary_name: boundaryName, status: 'QUEUED', output_kmz_name: kmzName, output_csv_name: csvName });
    }
    const summary = summarizeBatchJobs(jobs);
    return { success: true, data: { batch_id: batchId, project_id: projectId, ...summary, jobs } };
  }

  @Post('generate-custom')
  @UseInterceptors(FileFieldsInterceptor([{ name: 'customFile', maxCount: 1 }], { limits: { fileSize: MAX_SINGLE_UPLOAD } }))
  async custom(@UploadedFiles() files: any, @Req() req: any) {
    const user = await this.generationUser(req), custom = files?.customFile?.[0];
    if (!custom) throw missingFile('customFile');
    await validateDesignUpload(custom, MAX_SINGLE_UPLOAD);
    const inputPaths = await this.persistInputs(user.id, undefined, undefined, undefined, custom);
    const options = this.parseOptions({ ...req.body, config: undefined }), outputs = { kmzName: filename('design_ftth_custom', 'kmz'), csvName: filename('design_ftth_custom', 'csv') };
    const jobId = await this.enqueue(user, { operation: 'custom', inputPaths, jobId: req.body?.job_id, options, ...outputs, persistedInput: { operation: 'custom', input_paths: inputPaths, options, ...outputs } });
    return { success: true, data: { message: 'Custom generation job accepted.', job_id: jobId, kmz_url: `/api/files/${encodeURIComponent(outputs.kmzName)}`, csv_url: `/api/files/${encodeURIComponent(outputs.csvName)}` } };
  }

  @Get('generate/batch/:batchId')
  async getBatch(@Param('batchId') batchId: string, @Req() req: any) {
    const allRows = await this.db.select().from(generationJobs).where(eq(generationJobs.batchId, batchId));
    if (!allRows.length) throw new NotFoundException('Batch tidak ditemukan.');
    if (allRows.some((row: any) => row.userId !== req.user.id)) throw new ForbiddenException('Batch tidak dapat diakses.');
    const rows = latestBatchRows(allRows);
    const jobs = rows.map((row: any) => ({
      job_id: row.id, item_id: row.itemId, ...row.result?.batch_item,
      status: row.status, stage: row.stage,
      message: this.progress.get(row.id)?.message ?? row.error ?? row.status,
      percent: row.progress, error: row.error ?? undefined,
      output_kmz_name: outputName(row.result, 'kmz'), output_csv_name: outputName(row.result, 'csv'),
      result: row.result?.url ? row.result : undefined,
    }));
    const summary = summarizeBatchJobs(jobs);
    return { success: true, data: { batch_id: batchId, project_id: rows[0].projectId, ...summary, jobs } };
  }

  @Get('generate/batch/:batchId/progress')
  async batchProgress(@Param('batchId') batchId: string, @Req() req: any) { return this.getBatch(batchId, req); }

  @Post('generate/batch/:batchId/retry/:itemId')
  async retryBatch(@Param('batchId') batchId: string, @Param('itemId') itemId: string, @Req() req: any) {
    const user = await this.generationUser(req);
    const [old] = await this.db.select().from(generationJobs).where(and(eq(generationJobs.batchId, batchId), eq(generationJobs.itemId, itemId))).orderBy(desc(generationJobs.createdAt)).limit(1);
    if (!old || old.userId !== user.id) throw new NotFoundException('Batch item tidak ditemukan.');
    if (old.status === 'SKIPPED') throw new NotFoundException('Item batch tidak dapat di-retry.');
    const saved = old.result?.input_paths;
    if (!saved?.boundary) throw new BadRequestException('Sumber batch tidak tersedia untuk dicoba ulang.');
    const kmzName = outputName(old.result, 'kmz'), csvName = outputName(old.result, 'csv');
    const batchItem = old.result?.batch_item;
    const persistedInput = { input_paths: saved, options: old.result.options ?? {}, batch_item: batchItem, kmzName, csvName };
    const jobId = await this.enqueue(user, { inputPaths: saved, projectId: old.projectId ?? undefined, options: old.result.options ?? {}, batchItem, kmzName, csvName, persistedInput }, batchId, itemId);
    return { success: true, data: { batch_id: batchId, item_id: itemId, job_id: jobId } };
  }

  private parseOptions(body: any) {
    const parse = (value: any, label: string) => {
      if (!value) return {};
      try { return JSON.parse(value); }
      catch (error) { throw invalidFile(`Invalid ${label} JSON: ${error instanceof Error ? error.message : error}`, { raw: String(value).slice(0, 200) }); }
    };
    const config = parse(body?.config, 'generation config');
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw invalidFile('Invalid generation config JSON: expected an object', { raw: String(body.config).slice(0, 200) });
    const parsedColors = parse(body?.feature_colors, 'feature colors');
    const colors = parsedColors && typeof parsedColors === 'object' && !Array.isArray(parsedColors) ? parsedColors : {};
    try {
      const validated = this.generator.validateOptions(Object.fromEntries(Object.entries(config).filter(([key]) => GENERATION_CONFIG_FIELDS.has(key))));
      return { ...validated, feature_colors: colors, include_homepass: String(body?.mode ?? '').toUpperCase() === 'CORE' ? false : validated.include_homepass };
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      throw invalidFile(`Invalid generation config JSON: ${error.message}`, { raw: String(body?.config ?? '').slice(0, 200) });
    }
  }

  private async jobState(jobId: string) {
    const current = this.progress.get(jobId);
    if (current) return current;
    const [job] = await this.db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).limit(1);
    if (!job) return null;
    return { user_id: job.userId, batch_id: job.batchId, stage: job.stage ?? job.status, message: job.error ?? job.status, percent: job.progress, done: ['COMPLETED', 'FAILED', 'CANCELED'].includes(job.status), ...(job.result && typeof job.result === 'object' && 'url' in job.result ? { result: job.result } : {}) };
  }

  @Get('generate/status/:jobId')
  async status(@Param('jobId') jobId: string, @Req() req: any) {
    const state = await this.jobState(jobId);
    if (!state) throw new NotFoundException('Job tidak ditemukan.');
    if (state.user_id !== req.user.id) throw new ForbiddenException('Job tidak dapat diakses.');
    return { success: true, data: state };
  }

  @Sse('generate/progress/:jobId')
  async progressStream(@Param('jobId') jobId: string, @Req() req: any, @Res({ passthrough: true }) res: any) {
    const initialState = await this.jobState(jobId);
    if (initialState && initialState.user_id !== req.user.id) throw new ForbiddenException('Job tidak dapat diakses.');
    res?.setHeader('Cache-Control', 'no-cache, no-transform');
    res?.setHeader('Connection', 'keep-alive');
    res?.setHeader('X-Accel-Buffering', 'no');
    return new Observable((subscriber) => {
      let closed = false;
      let lastData: string | undefined;
      let missingAttempts = 0;
      let timer: NodeJS.Timeout;
      const heartbeat = setInterval(() => subscriber.next({ type: 'heartbeat', data: '' }), 15000);
      heartbeat.unref();
      const poll = async () => {
        if (closed) return;
        const state = await this.jobState(jobId);
        if (!state) {
          missingAttempts++;
          if (missingAttempts >= 20) {
            subscriber.next({ data: { error: 'Job not found' } });
            subscriber.complete();
            return;
          }
          timer = setTimeout(poll, 500);
          return;
        }
        missingAttempts = 0;
        if (state.user_id !== req.user.id) {
          subscriber.next({ data: { error: 'Forbidden' } });
          subscriber.complete();
          return;
        }
        const serialized = JSON.stringify(state);
        if (serialized !== lastData) {
          subscriber.next({ data: state });
          lastData = serialized;
        }
        if (state.done) {
          timer = setTimeout(() => subscriber.complete(), 1000);
          return;
        }
        timer = setTimeout(poll, 1000);
      };
      void poll();
      return () => { closed = true; clearTimeout(timer); clearInterval(heartbeat); };
    });
  }

  @Post('api/jobs/:jobId/cancel')
  async cancel(@Param('jobId') jobId: string, @Req() req: any) {
    if (!GENERATION_ROLES.includes(req.user.role)) throw new ForbiddenException('Generation access is not allowed');
    const state = await this.jobState(jobId);
    if (!state) throw new NotFoundException('Job tidak ditemukan.');
    if (state.user_id !== req.user.id) throw new ForbiddenException('Job tidak dapat diakses.');
    if (state.done) throw new HttpException('Job sudah selesai.', 409);
    this.canceled.add(jobId);
    this.abortControllers.get(jobId)?.abort(new DOMException('Job dibatalkan.', 'AbortError'));
    await this.update(jobId, { status: 'CANCELED', stage: 'CANCELED', message: 'Job dibatalkan.', percent: 100, done: true });
    return { success: true, data: { job_id: jobId, status: 'CANCELED' } };
  }

  @Post('generate-homepass')
  @UseInterceptors(FilesInterceptor('files', 1, { limits: { fileSize: MAX_UPLOAD } }))
  async homepass(@Req() req: any) { return this.cachedOperation(req, 'homepass'); }

  @Post('regenerate-cables')
  @UseInterceptors(FilesInterceptor('files', 1, { limits: { fileSize: MAX_UPLOAD } }))
  async regenerate(@Req() req: any) { return this.cachedOperation(req, 'regenerate'); }

  private async cachedOperation(req: any, operation: 'homepass' | 'regenerate') {
    const user = await this.generationUser(req), body = req.body ?? {}, projectId = body.project_id as string | undefined;
    await this.requireProject(projectId, user);
    const batchId = body.batch_id, itemId = body.item_id;
    const { path } = await this.resolveCacheFile(user.id, projectId, batchId, itemId);
    const options = this.parseOptions(body), cacheNames = { kmzName: filename(operation === 'homepass' ? 'design_ftth_homepass' : 'design_ftth_regen', 'kmz'), csvName: filename(operation === 'homepass' ? 'design_ftth_homepass' : 'design_ftth_regen', 'csv') };
    const jobId = await this.enqueue(user, { operation, cachePath: path, projectId, batchId, itemId, jobId: body.job_id, options, ...cacheNames, persistedInput: { operation, cachePath: path, projectId, batchId, itemId, options, ...cacheNames } }, batchId, itemId);
    return { success: true, data: { message: operation === 'homepass' ? 'Homepass generation job accepted.' : 'Regenerate cables job accepted.', job_id: jobId, kmz_url: `/api/files/${encodeURIComponent(cacheNames.kmzName)}`, csv_url: `/api/files/${encodeURIComponent(cacheNames.csvName)}` } };
  }
}
