import { Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Req, UseGuards } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB } from '../db/database.module';
import { auditLogs, projects } from '../db/schema';
import { ProxyAuthGuard } from '../auth/proxy-auth.guard';

@Controller('api')
@UseGuards(ProxyAuthGuard)
export class AuditController {
  constructor(@Inject(DB) private readonly db: any) {}

  @Get('projects/:projectId/audit')
  async projectAudit(@Param('projectId') projectId: string, @Req() req: any) {
    const [project] = await this.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || (req.user.role !== 'viewer' && project.userId !== req.user.id)) {
      throw new NotFoundException('Project not found or access denied');
    }
    const logs = await this.db.select().from(auditLogs).where(eq(auditLogs.projectId, projectId)).orderBy(desc(auditLogs.createdAt));
    return { success: true, data: logs };
  }

  @Get('audit')
  async accountAudit(@Req() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException('Admin access required');
    const logs = await this.db.select().from(auditLogs).where(eq(auditLogs.userId, req.user.id)).orderBy(desc(auditLogs.createdAt)).limit(100);
    return { success: true, data: logs };
  }
}
