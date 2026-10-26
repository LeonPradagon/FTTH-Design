import { Body, Controller, Delete, ForbiddenException, Get, HttpException, Inject, NotFoundException, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DB } from '../db/database.module';
import { auditLogs, projects } from '../db/schema';
import { ProxyAuthGuard } from '../auth/proxy-auth.guard';
import { fastapiInteger } from '../http/fastapi-integer';

const DEFAULT_COLORS = { pop: '#eab308', odc: '#ff0000', odp: '#0000ff', house: '#6b7280', feeder: '#ff0000', distribution: '#aa00ff' };
const LEGACY_COLORS = [
  { pop: '#ef4444', odc: '#3b82f6', odp: '#10b981', house: '#6b7280', feeder: '#ef4444', distribution: '#3b82f6' },
  { pop: '#eab308', odc: '#ef4444', odp: '#3b82f6', house: '#6b7280', feeder: '#ef4444', distribution: '#8b5cf6' },
];
const CONFIG_KEY = '__generation_config__';
const PROJECT_FIELDS: [string, string, (value: unknown) => boolean][] = [
  ['name', 'string', (value) => typeof value === 'string'],
  ['layers', 'list', Array.isArray],
  ['filters', 'dict', (value) => value !== null && typeof value === 'object' && !Array.isArray(value)],
  ['feature_colors', 'dict', (value) => value !== null && typeof value === 'object' && !Array.isArray(value)],
  ['generation_config', 'dict', (value) => value !== null && typeof value === 'object' && !Array.isArray(value)],
];

function validateProjectBody(body: any, creating: boolean) {
  const errors: any[] = [];
  for (const [name, type, valid] of PROJECT_FIELDS) {
    if (body?.[name] === undefined) {
      if (creating && name !== 'generation_config') errors.push({ type: 'missing', loc: ['body', name], msg: 'Field required', input: body });
    } else if (!valid(body[name]) && !(body[name] === null && !creating)) {
      errors.push({ type: `${type}_type`, loc: ['body', name], msg: `Input should be a valid ${type === 'dict' ? 'dictionary' : type}`, input: body[name] });
    }
  }
  if (errors.length) throw new HttpException({ detail: errors }, 422);
}

function serialize(project: any) {
  const filters = project.filters && typeof project.filters === 'object' ? project.filters : {};
  const storedConfig = project.generation_config && Object.keys(project.generation_config).length
    ? project.generation_config
    : filters[CONFIG_KEY] ?? {};
  return {
    id: project.id, name: project.name, layers: project.layers,
    filters: Object.fromEntries(Object.entries(filters).filter(([key]) => key !== CONFIG_KEY)),
    feature_colors: project.feature_colors, generation_config: storedConfig,
    userId: project.userId, created_at: project.created_at?.toISOString() ?? null, updated_at: project.updated_at?.toISOString() ?? null,
  };
}

@Controller('api/projects')
@UseGuards(ProxyAuthGuard)
export class ProjectsController {
  constructor(@Inject(DB) private readonly db: any) {}

  private async audit(userId: string, action: string, projectId: string, oldValue: unknown, newValue: unknown) {
    await this.db.insert(auditLogs).values({ id: randomUUID(), userId, action, projectId, details: { old: oldValue, new: newValue } });
  }

  private access(project: any, user: any) {
    if (!project) throw new NotFoundException('Project not found');
    if (user.role !== 'viewer' && project.userId !== user.id) throw new ForbiddenException('Forbidden');
  }

  @Post()
  async create(@Body() body: any, @Req() req: any) {
    const user = req.user;
    this.requireGeneration(user);
    validateProjectBody(body, true);
    const now = new Date();
    const filters = { ...body.filters, [CONFIG_KEY]: body.generation_config ?? {} };
    const project = await this.db.transaction(async (tx: any) => {
      const [created] = await tx.insert(projects).values({
        id: randomUUID(), name: body.name, layers: body.layers, filters,
        feature_colors: user.role === 'admin' ? this.allowedColors(body.feature_colors) : DEFAULT_COLORS,
        generation_config: body.generation_config ?? {}, userId: user.id, created_at: now, updated_at: now,
      }).returning();
      await tx.insert(auditLogs).values({ id: randomUUID(), userId: user.id, action: 'CREATE_PROJECT', projectId: created.id, details: { old: null, new: serialize(created) } });
      return created;
    });
    return { success: true, data: serialize(project) };
  }

  @Get()
  async list(@Req() req: any, @Query('skip') skip = '0', @Query('limit') limit = '100') {
    const where = req.user.role === 'viewer' ? undefined : eq(projects.userId, req.user.id);
    const rows = await this.db.select().from(projects).where(where).orderBy(desc(projects.updated_at)).offset(fastapiInteger(skip, 'query', 'skip')).limit(fastapiInteger(limit, 'query', 'limit'));
    return { success: true, data: rows.map(serialize) };
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: any) {
    const [project] = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    this.access(project, req.user);
    return { success: true, data: serialize(project) };
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    this.requireGeneration(req.user);
    validateProjectBody(body, false);
    const [project] = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    this.access(project, req.user);
    const generationConfig = body.generation_config ?? undefined;
    const filters = body.filters === undefined
      ? generationConfig === undefined ? project.filters : { ...(project.filters ?? {}), [CONFIG_KEY]: generationConfig }
      : { ...(body.filters ?? {}), ...(generationConfig === undefined ? {} : { [CONFIG_KEY]: generationConfig }) };
    const updated = await this.db.transaction(async (tx: any) => {
      const [row] = await tx.update(projects).set({
        ...(body.name === undefined ? {} : { name: body.name }), ...(body.layers === undefined ? {} : { layers: body.layers }),
        ...(body.filters === undefined && generationConfig === undefined ? {} : { filters }),
        ...(generationConfig === undefined ? {} : { generation_config: generationConfig }),
        ...(req.user.role === 'admin' && body.feature_colors != null ? { feature_colors: this.allowedColors(body.feature_colors) } : req.user.role === 'admin' ? {} : { feature_colors: DEFAULT_COLORS }),
        updated_at: new Date(),
      }).where(eq(projects.id, id)).returning();
      await tx.insert(auditLogs).values({ id: randomUUID(), userId: req.user.id, action: 'UPDATE_PROJECT', projectId: id, details: { old: serialize(project), new: serialize(row) } });
      return row;
    });
    return { success: true, data: serialize(updated) };
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException('Admin access is required');
    const [project] = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!project) throw new NotFoundException('Project not found');
    if (project.userId !== req.user.id) throw new ForbiddenException('Forbidden');
    await this.db.transaction(async (tx: any) => {
      await tx.insert(auditLogs).values({ id: randomUUID(), userId: req.user.id, action: 'DELETE_PROJECT', projectId: id, details: { old: serialize(project), new: null } });
      await tx.delete(projects).where(eq(projects.id, id));
    });
    return { success: true, data: { message: 'Project deleted successfully' } };
  }

  private requireGeneration(user: any) {
    if (!['admin', 'engineer', 'user'].includes(user.role)) throw new ForbiddenException('Generation access is not allowed');
  }

  private allowedColors(requested: any) {
    if (LEGACY_COLORS.some((palette) => Object.entries(palette).every(([key, color]) => String(requested?.[key] ?? '').toLowerCase() === color))) return DEFAULT_COLORS;
    return { ...DEFAULT_COLORS, ...(requested && typeof requested === 'object' ? requested : {}) };
  }
}
