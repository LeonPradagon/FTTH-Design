import { BadRequestException, Controller, ForbiddenException, Get, HttpException, Inject, NotFoundException, OnModuleInit, Param, Post, Query, Req, Sse, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Observable } from 'rxjs';
import { DB } from '../db/database.module';
import { auditLogs, designVersions, generationJobs, projects, users } from '../db/schema';
import { ProxyAuthGuard } from '../auth/proxy-auth.guard';
import { StorageService } from '../storage/storage.service';
import { GeneratorService, readKml } from './generator.service';

const GENERATION_ROLES = ['admin', 'engineer', 'user'];
const MAX_UPLOAD = Number(process.env.MAX_BATCH_FILE_BYTES ?? 50 * 1024 * 1024);
const scope = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
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

@Controller()
@UseGuards(ProxyAuthGuard)
export class GenerationController implements OnModuleInit {
  private readonly progress = new Map<string, any>();
  private readonly canceled = new Set<string>();
  private readonly rate = new Map<string, number[]>();
  private readonly pending: { jobId: string; user: any; input: any }[] = [];
  private activeJobs = 0;
  private readonly maxJobs = Math.max(1, Number(process.env.GENERATION_MAX_JOBS ?? 2));
  private readonly cacheRoot = process.env.USER_CACHE_ROOT ?? join(tmpdir(), 'ftth_cache');

  constructor(@Inject(DB) private readonly db: any, private readonly storage: StorageService, private readonly generator: GeneratorService) {}

  async onModuleInit() {
    const rows = await this.db.select().from(generationJobs).where(inArray(generationJobs.status, ['QUEUED', 'RUNNING']));
    for (const job of rows) {
      const [user] = await this.db.select().from(users).where(eq(users.id, job.userId)).limit(1);
      if (!user || !job.result) continue;
      const input = job.result;
      await this.db.update(generationJobs).set({ status: 'QUEUED', stage: 'QUEUED', progress: 1, updatedAt: new Date() }).where(eq(generationJobs.id, job.id));
      this.progress.set(job.id, { user_id: job.userId, batch_id: job.batchId, stage: 'QUEUED', message: 'Melanjutkan job setelah backend dimulai ulang...', percent: 1, status: 'QUEUED', done: false, result: input });
      this.schedule(job.id, { id: user.id, role: user.role ?? 'engineer', email: user.email }, { ...input, inputPaths: input.input_paths, projectId: job.projectId ?? undefined, batchId: job.batchId ?? undefined, itemId: job.itemId ?? undefined });
    }
  }

  private schedule(jobId: string, user: any, input: any) {
    this.pending.push({ jobId, user, input });
    this.pump();
  }

  private pump() {
    while (this.activeJobs < this.maxJobs && this.pending.length) {
      const task = this.pending.shift()!;
      if (this.canceled.has(task.jobId)) continue;
      this.activeJobs++;
      void this.run(task.jobId, task.user, task.input).finally(() => {
        this.activeJobs--;
        this.pump();
      });
    }
  }

  private generationUser(req: any) {
    if (!GENERATION_ROLES.includes(req.user.role)) throw new ForbiddenException('Generation access is not allowed');
    const now = Date.now(), windowStart = now - Number(process.env.GENERATION_RATE_WINDOW_SECONDS ?? 60) * 1000;
    const recent = (this.rate.get(req.user.id) ?? []).filter((time) => time > windowStart);
    if (recent.length >= Number(process.env.GENERATION_RATE_LIMIT ?? 10)) throw new HttpException('Terlalu banyak permintaan generation. Coba lagi sebentar.', 429);
    recent.push(now); this.rate.set(req.user.id, recent);
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

  private async update(jobId: string, patch: any) {
    const state = { ...(this.progress.get(jobId) ?? {}), ...patch };
    this.progress.set(jobId, state);
    await this.db.update(generationJobs).set({ status: state.status, stage: state.stage, progress: state.percent, error: state.error ?? null, ...(state.result === undefined ? {} : { result: state.result }), updatedAt: new Date() }).where(eq(generationJobs.id, jobId));
  }

  private async recordVersion(projectId: string | undefined, user: any, result: any, options: any) {
    if (!projectId) return;
    await this.db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`);
      const [last] = await tx.select({ version: designVersions.version }).from(designVersions).where(eq(designVersions.projectId, projectId)).orderBy(desc(designVersions.version)).limit(1);
      const versionId = randomUUID(), version = (last?.version ?? 0) + 1;
      await tx.insert(designVersions).values({ id: versionId, projectId, version, config: options, metadata: result.metadata, validation: result.validation, stats: result.stats, status: 'COMPLETED' });
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
    try {
      await this.update(jobId, { status: 'RUNNING', stage: 'PARSING', message: 'Membaca file KML/KMZ...', percent: 5, done: false });
      const options = input.options ?? {};
      const checkpointDir = input.inputPaths?.boundary ? join(dirname(input.inputPaths.boundary), '..', 'osm_checkpoints', scope(jobId)) : undefined;
      let result: any;
      if (input.operation === 'custom') {
        const custom = input.custom ?? { buffer: await readFile(input.inputPaths.boundary), originalname: input.inputPaths.boundaryName };
        result = await this.generator.generateCustom(custom.buffer, custom.originalname, options, checkpointDir);
      } else if (input.operation) {
        const cache = JSON.parse(await readFile(input.cachePath, 'utf8'));
        result = await this.generator.fromCache(cache, options, input.operation);
      } else {
        await this.update(jobId, { stage: 'OSM', message: 'Mengambil data jalan dan bangunan OSM...', percent: 15 });
        const boundary = input.boundary ?? { buffer: await readFile(input.inputPaths.boundary), originalname: input.inputPaths.boundaryName };
        const pop = input.pop ?? (input.inputPaths.pop ? { buffer: await readFile(input.inputPaths.pop), originalname: input.inputPaths.popName } : undefined);
        result = await this.generator.generate(boundary.buffer, boundary.originalname, pop?.buffer, pop?.originalname, options, checkpointDir);
      }
      if (this.canceled.has(jobId)) return;
      const kmzName = input.kmzName ?? filename('design_ftth', 'kmz'), csvName = input.csvName ?? filename('design_ftth', 'csv');
      await this.storage.upload(`${userPrefix(user.id)}${kmzName}`, result.kmz, 'application/vnd.google-earth.kmz', kmzName);
      await this.storage.upload(`${userPrefix(user.id)}${csvName}`, result.csv, 'text/csv; charset=utf-8', csvName);
      if (!input.operation || input.operation === 'regenerate' || input.operation === 'custom') {
        const path = this.cacheFile(user.id, input.projectId, input.batchId, input.itemId);
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, JSON.stringify(result.state));
      }
      await this.recordVersion(input.projectId, user, result, options);
      const output = { url: `/api/files/${encodeURIComponent(kmzName)}`, kmz_url: `/api/files/${encodeURIComponent(kmzName)}`, csv_url: `/api/files/${encodeURIComponent(csvName)}`, stats: result.stats, validation: result.validation, ...(input.inputPaths ? { input_paths: input.inputPaths, options } : {}), ...(input.batch_item ? { batch_item: input.batch_item } : {}) };
      await this.update(jobId, { status: 'COMPLETED', stage: 'COMPLETED', message: 'Generation selesai.', percent: 100, done: true, result: output });
    } catch (error: any) {
      const message = error instanceof Error ? error.message : 'Generation gagal.';
      await this.update(jobId, { status: 'FAILED', stage: 'FAILED', message, error: message, percent: 100, done: true });
    }
  }

  private async persistInputs(userId: string, projectId: string | undefined, batchId: string | undefined, itemId: string | undefined, boundary: any, pop?: any) {
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
    await this.db.insert(generationJobs).values({ id: jobId, userId: user.id, projectId: input.projectId ?? null, batchId: batchId ?? null, itemId: itemId ?? null, status: 'QUEUED', stage: 'QUEUED', progress: 1, result: input.persistedInput ?? null });
    const jobInput = input.persistedInput ?? { input_paths: input.inputPaths, options: input.options, operation: input.operation, cachePath: input.cachePath, kmzName: input.kmzName, csvName: input.csvName };
    this.progress.set(jobId, { user_id: user.id, batch_id: batchId, stage: 'QUEUED', message: 'Menunggu worker memproses job...', percent: 1, status: 'QUEUED', done: false, result: jobInput });
    this.schedule(jobId, user, { ...input, persistedInput: jobInput });
    return jobId;
  }

  @Post('generate')
  @UseInterceptors(FileFieldsInterceptor([{ name: 'boundaryFile', maxCount: 1 }, { name: 'popFile', maxCount: 1 }], { limits: { fileSize: MAX_UPLOAD } }))
  async generate(@UploadedFiles() files: any, @Req() req: any) {
    const user = this.generationUser(req), boundary = files?.boundaryFile?.[0], pop = files?.popFile?.[0];
    if (!boundary) throw new BadRequestException('Boundary KML/KMZ wajib diunggah.');
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
    const user = this.generationUser(req), projectId = req.body?.project_id;
    if (!files?.length) throw new BadRequestException('Minimal satu file boundary wajib diunggah.');
    if (!projectId) throw new BadRequestException('Project wajib disimpan sebelum generation.');
    const maxFiles = Number(process.env.MAX_BATCH_FILES ?? 100);
    if (files.length > maxFiles) throw new HttpException(`Maksimal ${maxFiles} file per batch.`, 413);
    await this.requireProject(projectId, user);
    const parsed = await Promise.all(files.map(async (file) => ({ file, marks: await readKml(file.buffer, file.originalname) })));
    const boundaries = parsed.filter(({ file }) => isBoundaryFile(file.originalname));
    const pops = parsed.filter(({ file }) => isPopFile(file.originalname));
    for (const entry of parsed) {
      if (isBoundaryFile(entry.file.originalname) || isPopFile(entry.file.originalname)) continue;
      if (entry.marks.some((mark) => mark.polygon)) boundaries.push(entry);
      else if (entry.marks.some((mark) => mark.point)) pops.push(entry);
    }
    if (!boundaries.length) throw new BadRequestException('File boundary tidak ditemukan.');
    const batchId = randomUUID(), options = this.parseOptions(req.body);
    options.include_homepass = false;
    options.force_refresh_osm = String(req.body?.force_refresh ?? '').toLowerCase() === 'true' || options.force_refresh_osm;
    const boundaryName = boundaries[0].file.originalname, name = batchSlug(boundaryName);
    const boundaryKml = makeBatchKml(boundaries.flatMap((entry) => entry.marks), 'boundary');
    const embeddedFile = boundaries.find((entry) => entry.marks.some((mark) => mark.point && popMarker.test(`${mark.context ?? ''} ${mark.name ?? ''}`)));
    const popMarks = embeddedFile
      ? embeddedFile.marks.filter((mark) => mark.point && popMarker.test(`${mark.context ?? ''} ${mark.name ?? ''}`))
      : pops[0]?.marks.filter((mark) => mark.point) ?? [];
    const popKml = popMarks.length ? makeBatchKml(popMarks, 'pop') : undefined;
    const itemId = randomBytes(6).toString('hex');
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
      await this.db.insert(generationJobs).values({ id: jobId, userId: user.id, projectId, batchId, itemId, status: 'SKIPPED', stage: 'SKIPPED', progress: 100, error: item.error, result: { input_paths: inputPaths, options, batch_item: batchItem } });
      jobs.push(item);
    } else {
      const jobId = await this.enqueue(user, { inputPaths, projectId, options, batchItem, persistedInput: { input_paths: inputPaths, options, batch_item: batchItem } }, batchId, itemId);
      jobs.push({ job_id: jobId, item_id: itemId, design_name: name, boundary_name: boundaryName, status: 'QUEUED' });
    }
    return { success: true, data: { batch_id: batchId, project_id: projectId, status: 'QUEUED', total: jobs.length, completed: 0, failed: 0, jobs } };
  }

  @Post('generate-custom')
  @UseInterceptors(FileFieldsInterceptor([{ name: 'customFile', maxCount: 1 }], { limits: { fileSize: MAX_UPLOAD } }))
  async custom(@UploadedFiles() files: any, @Req() req: any) {
    const user = this.generationUser(req), custom = files?.customFile?.[0];
    if (!custom) throw new BadRequestException('File KML custom wajib diunggah.');
    const inputPaths = await this.persistInputs(user.id, undefined, undefined, undefined, custom);
    const jobId = await this.enqueue(user, { operation: 'custom', inputPaths, jobId: req.body?.job_id, options: this.parseOptions(req.body), persistedInput: { operation: 'custom', input_paths: inputPaths, options: this.parseOptions(req.body) } });
    return { success: true, data: { message: 'Custom generation job accepted.', job_id: jobId } };
  }

  @Get('generate/batch/:batchId')
  async getBatch(@Param('batchId') batchId: string, @Req() req: any) {
    const rows = await this.db.select().from(generationJobs).where(eq(generationJobs.batchId, batchId));
    if (!rows.length) throw new NotFoundException('Batch tidak ditemukan.');
    if (rows.some((row: any) => row.userId !== req.user.id)) throw new ForbiddenException('Batch tidak dapat diakses.');
    const jobs = rows.map((row: any) => ({ job_id: row.id, item_id: row.itemId, ...row.result?.batch_item, status: row.status, stage: row.stage, message: this.progress.get(row.id)?.message ?? row.error ?? row.status, percent: row.progress, error: row.error ?? undefined, result: row.result?.url ? row.result : undefined }));
    const completed = jobs.filter((job: any) => ['COMPLETED', 'FAILED', 'CANCELED', 'SKIPPED'].includes(job.status)).length;
    const failed = jobs.filter((job: any) => ['FAILED', 'SKIPPED'].includes(job.status)).length;
    const status = completed < jobs.length ? 'RUNNING' : failed ? 'FAILED' : 'COMPLETED';
    return { success: true, data: { batch_id: batchId, status, total: jobs.length, completed, failed, jobs } };
  }

  @Get('generate/batch/:batchId/progress')
  async batchProgress(@Param('batchId') batchId: string, @Req() req: any) { return this.getBatch(batchId, req); }

  @Post('generate/batch/:batchId/retry/:itemId')
  async retryBatch(@Param('batchId') batchId: string, @Param('itemId') itemId: string, @Req() req: any) {
    const user = this.generationUser(req);
    const [old] = await this.db.select().from(generationJobs).where(and(eq(generationJobs.batchId, batchId), eq(generationJobs.itemId, itemId))).orderBy(desc(generationJobs.createdAt)).limit(1);
    if (!old || old.userId !== user.id) throw new NotFoundException('Batch item tidak ditemukan.');
    if (old.status === 'SKIPPED') throw new NotFoundException('Item batch tidak dapat di-retry.');
    const saved = old.result?.input_paths;
    if (!saved?.boundary) throw new BadRequestException('Sumber batch tidak tersedia untuk dicoba ulang.');
    const jobId = await this.enqueue(user, { inputPaths: saved, projectId: old.projectId ?? undefined, options: old.result.options ?? {} }, batchId, itemId);
    return { success: true, data: { job_id: jobId, item_id: itemId, status: 'QUEUED' } };
  }

  private parseOptions(body: any) {
    const parse = (value: any, fallback: any) => { try { return value ? JSON.parse(value) : fallback; } catch { throw new BadRequestException('Format konfigurasi JSON tidak valid.'); } };
    const config = parse(body?.config, {}), colors = parse(body?.feature_colors, {});
    return { ...config, feature_colors: colors, include_homepass: String(body?.mode ?? '').toUpperCase() === 'CORE' ? false : config.include_homepass ?? true };
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
  progressStream(@Param('jobId') jobId: string, @Req() req: any) {
    return new Observable((subscriber) => {
      let closed = false;
      const send = async () => {
        if (closed) return;
        const state = await this.jobState(jobId);
        if (!state || state.user_id !== req.user.id) { subscriber.next({ data: { error: state ? 'Forbidden' : 'Job not found' } }); subscriber.complete(); return; }
        subscriber.next({ data: state });
        if (state.done) setTimeout(() => subscriber.complete(), 1200);
      };
      void send();
      const timer = setInterval(() => void send(), 1000);
      return () => { closed = true; clearInterval(timer); };
    });
  }

  @Post('api/jobs/:jobId/cancel')
  async cancel(@Param('jobId') jobId: string, @Req() req: any) {
    this.generationUser(req);
    const state = await this.jobState(jobId);
    if (!state) throw new NotFoundException('Job tidak ditemukan.');
    if (state.user_id !== req.user.id) throw new ForbiddenException('Job tidak dapat diakses.');
    if (state.done) throw new BadRequestException('Job sudah selesai.');
    this.canceled.add(jobId);
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
    const user = this.generationUser(req), body = req.body ?? {}, projectId = body.project_id as string | undefined;
    await this.requireProject(projectId, user);
    const batchId = body.batch_id, itemId = body.item_id;
    const path = this.cacheFile(user.id, projectId, batchId, itemId);
    try { await readFile(path); } catch { throw new BadRequestException('Cache Network Core belum tersedia. Jalankan Generate Design terlebih dahulu.'); }
    const options = this.parseOptions(body), cacheNames = { kmzName: filename(operation === 'homepass' ? 'design_ftth_homepass' : 'design_ftth_regen', 'kmz'), csvName: filename(operation === 'homepass' ? 'design_ftth_homepass' : 'design_ftth_regen', 'csv') };
    const jobId = await this.enqueue(user, { operation, cachePath: path, projectId, batchId, itemId, options, ...cacheNames, persistedInput: { operation, cachePath: path, projectId, batchId, itemId, options, ...cacheNames } }, batchId, itemId);
    return { success: true, data: { message: `${operation} job accepted.`, job_id: jobId } };
  }
}
