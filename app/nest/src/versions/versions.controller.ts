import { Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DB } from '../db/database.module';
import { auditLogs, designCables, designOdcs, designOdps, designVersions, projects } from '../db/schema';
import { ProxyAuthGuard } from '../auth/proxy-auth.guard';
import { StorageService } from '../storage/storage.service';

@Controller('api/projects/:projectId/versions')
@UseGuards(ProxyAuthGuard)
export class VersionsController {
  constructor(@Inject(DB) private readonly db: any, private readonly storage: StorageService) {}

  private async project(projectId: string, user: any) {
    const [project] = await this.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || (user.role !== 'viewer' && project.userId !== user.id)) throw new NotFoundException('Project not found or access denied');
    return project;
  }

  private async version(projectId: string, version: number) {
    const [result] = await this.db.select().from(designVersions).where(and(eq(designVersions.projectId, projectId), eq(designVersions.version, version))).limit(1);
    return result;
  }

  @Get()
  async list(@Param('projectId') projectId: string, @Req() req: any) {
    await this.project(projectId, req.user);
    const rows = await this.db.select().from(designVersions).where(eq(designVersions.projectId, projectId)).orderBy(desc(designVersions.version));
    return { success: true, data: rows.map((row: any) => {
      const { metadata, ...version } = row;
      const artifacts = metadata?.artifacts ?? {};
      return { ...version, artifacts: Object.fromEntries(['kmz', 'csv'].filter((kind) => artifacts[kind]).map((kind) => [kind, `/api/projects/${projectId}/versions/${row.version}/export/${kind}`])) };
    }) };
  }

  @Get('compare/versions')
  async compare(@Param('projectId') projectId: string, @Query('v1') v1: string, @Query('v2') v2: string, @Req() req: any) {
    await this.project(projectId, req.user);
    const [one, two] = await Promise.all([this.version(projectId, Number(v1)), this.version(projectId, Number(v2))]);
    if (!one || !two) throw new NotFoundException('One or both versions not found');
    const a = one.stats ?? {}, b = two.stats ?? {};
    return { success: true, data: { v1: one, v2: two, diff: {
      odc_count_diff: (b.odc_count ?? 0) - (a.odc_count ?? 0), odp_count_diff: (b.odp_count ?? 0) - (a.odp_count ?? 0),
      customer_count_diff: (b.customer_count ?? 0) - (a.customer_count ?? 0), feeder_length_km_diff: (b.feeder_length_km ?? 0) - (a.feeder_length_km ?? 0), config_diff: {},
    } } };
  }

  @Get(':version/export/:artifact')
  async export(@Param('projectId') projectId: string, @Param('version') version: string, @Param('artifact') artifact: string, @Req() req: any, @Res({ passthrough: true }) res: any) {
    await this.project(projectId, req.user);
    const result = await this.version(projectId, Number(version));
    if (!result) throw new NotFoundException(`Version ${version} not found`);
    if (artifact !== 'kmz' && artifact !== 'csv') throw new NotFoundException('Artifact not found');
    const key = result.metadata?.artifacts?.[artifact];
    if (!key) throw new NotFoundException('Artifact not found');
    const object = await this.storage.download(key);
    res.setHeader('Content-Type', object.contentType);
    if (object.contentLength != null) res.setHeader('Content-Length', object.contentLength);
    if (object.contentDisposition) res.setHeader('Content-Disposition', object.contentDisposition);
    return new StreamableFile(object.body);
  }

  @Get(':version')
  async get(@Param('projectId') projectId: string, @Param('version') version: string, @Req() req: any) {
    await this.project(projectId, req.user);
    const result = await this.version(projectId, Number(version));
    if (!result) throw new NotFoundException(`Version ${version} not found`);
    return { success: true, data: result };
  }

  @Delete(':version')
  async remove(@Param('projectId') projectId: string, @Param('version') version: string, @Req() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException('Admin access is required');
    await this.project(projectId, req.user);
    const result = await this.version(projectId, Number(version));
    if (!result) throw new NotFoundException(`Version ${version} not found`);
    await this.db.transaction(async (tx: any) => {
      await tx.delete(designVersions).where(eq(designVersions.id, result.id));
      await tx.insert(auditLogs).values({ id: randomUUID(), userId: req.user.id, action: 'DELETE_VERSION', projectId, versionId: result.id, details: { old: { version: result.version }, new: null } });
    });
    return { success: true, data: { message: `Version ${version} deleted successfully` } };
  }

  @Post(':version/duplicate')
  duplicate(@Param('projectId') projectId: string, @Param('version') version: string, @Req() req: any) { return this.copy(projectId, Number(version), req.user, 'DUPLICATE_VERSION'); }

  @Post(':version/rollback')
  rollback(@Param('projectId') projectId: string, @Param('version') version: string, @Req() req: any) { return this.copy(projectId, Number(version), req.user, 'ROLLBACK_VERSION'); }

  private async copy(projectId: string, number: number, user: any, action: string) {
    if (!['admin', 'engineer', 'user'].includes(user.role)) throw new ForbiddenException('Generation access is not allowed');
    await this.project(projectId, user);
    return this.db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`);
      const [source] = await tx.select().from(designVersions).where(and(eq(designVersions.projectId, projectId), eq(designVersions.version, number))).limit(1);
      if (!source) throw new NotFoundException(`Version ${number} not found`);
      const [last] = await tx.select({ version: designVersions.version }).from(designVersions).where(eq(designVersions.projectId, projectId)).orderBy(desc(designVersions.version)).limit(1);
      const [duplicate] = await tx.insert(designVersions).values({ ...source, id: randomUUID(), version: (last?.version ?? 0) + 1, createdAt: new Date() }).returning();
      await tx.execute(sql`INSERT INTO "design_odc" ("id", "designVersionId", "label", "location") SELECT gen_random_uuid(), ${duplicate.id}, "label", "location" FROM "design_odc" WHERE "designVersionId" = ${source.id}`);
      await tx.execute(sql`INSERT INTO "design_odp" ("id", "designVersionId", "odcId", "label", "location") SELECT gen_random_uuid(), ${duplicate.id}, new_odc."id", old_odp."label", old_odp."location" FROM "design_odp" AS old_odp JOIN "design_odc" AS old_odc ON old_odc."id" = old_odp."odcId" JOIN "design_odc" AS new_odc ON new_odc."designVersionId" = ${duplicate.id} AND new_odc."label" = old_odc."label" WHERE old_odp."designVersionId" = ${source.id}`);
      await tx.execute(sql`INSERT INTO "design_cable" ("id", "designVersionId", "type", "sourceLabel", "targetLabel", "length", "path") SELECT gen_random_uuid(), ${duplicate.id}, "type", "sourceLabel", "targetLabel", "length", "path" FROM "design_cable" WHERE "designVersionId" = ${source.id}`);
      await tx.insert(auditLogs).values({ id: randomUUID(), userId: user.id, action, projectId, versionId: duplicate.id, details: { old: { version: number }, new: { version: duplicate.version } } });
      return { success: true, data: duplicate };
    });
  }
}
