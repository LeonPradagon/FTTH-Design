import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DB } from '../db/database.module';
import { auditLogs, projects } from '../db/schema';
import { ProxyAuthGuard } from '../auth/proxy-auth.guard';

const DEFAULT_COLORS = { pop: '#eab308', odc: '#ff0000', odp: '#0000ff', house: '#6b7280', feeder: '#ff0000', distribution: '#aa00ff' };
const LEGACY_COLORS = [
  { pop: '#ef4444', odc: '#3b82f6', odp: '#10b981', house: '#6b7280', feeder: '#ef4444', distribution: '#3b82f6' },
  { pop: '#eab308', odc: '#ef4444', odp: '#3b82f6', house: '#6b7280', feeder: '#ef4444', distribution: '#8b5cf6' },
];
const CONFIG_KEY = '__generation_config__';

function serialize(project: any) {
  const filters = project.filters && typeof project.filters === 'object' ? project.filters : {};
  return {
    id: project.id, name: project.name, layers: project.layers,
    filters: Object.fromEntries(Object.entries(filters).filter(([key]) => key !== CONFIG_KEY)),
    feature_colors: project.feature_colors, generation_config: project.generation_config || filters[CONFIG_KEY] || {},
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
    if (typeof body?.name !== 'string' || !body.name.trim()) throw new BadRequestException('Project name is required');
    const now = new Date();
    const filters = { ...(body.filters ?? {}), [CONFIG_KEY]: body.generation_config ?? {} };
    const project = await this.db.transaction(async (tx: any) => {
      const [created] = await tx.insert(projects).values({
        id: randomUUID(), name: body.name.trim(), layers: body.layers ?? [], filters,
        feature_colors: user.role === 'admin' ? this.allowedColors(body.feature_colors ?? {}) : DEFAULT_COLORS,
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
    const rows = await this.db.select().from(projects).where(where).orderBy(desc(projects.updated_at)).offset(Math.max(0, Number(skip) || 0)).limit(Math.min(100, Math.max(1, Number(limit) || 100)));
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
    const [project] = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    this.access(project, req.user);
    const filters = body.filters === undefined
      ? body.generation_config === undefined ? project.filters : { ...(project.filters ?? {}), [CONFIG_KEY]: body.generation_config }
      : { ...(body.filters ?? {}), ...(body.generation_config === undefined ? {} : { [CONFIG_KEY]: body.generation_config }) };
    const [updated] = await this.db.update(projects).set({
      ...(body.name === undefined ? {} : { name: body.name }), ...(body.layers === undefined ? {} : { layers: body.layers }),
      ...(body.filters === undefined && body.generation_config === undefined ? {} : { filters }),
      ...(body.generation_config === undefined ? {} : { generation_config: body.generation_config }),
      ...(req.user.role === 'admin' && body.feature_colors !== undefined ? { feature_colors: this.allowedColors(body.feature_colors) } : req.user.role === 'admin' ? {} : { feature_colors: DEFAULT_COLORS }),
      updated_at: new Date(),
    }).where(eq(projects.id, id)).returning();
    await this.audit(req.user.id, 'UPDATE_PROJECT', id, serialize(project), serialize(updated));
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
