import { Controller, Get, HttpException, Inject, Param, Req, UseGuards } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB } from '../db/database.module';
import { auditLogs, projects } from '../db/schema';
import { ProxyAuthGuard } from '../auth/proxy-auth.guard';

const apiError = (code: string, message: string, status: number) => new HttpException({ success: false, error: { code, message } }, status);

@Controller('api')
@UseGuards(ProxyAuthGuard)
export class AuditController {
  constructor(@Inject(DB) private readonly db: any) {}

  @Get('projects/:projectId/audit')
  async projectAudit(@Param('projectId') projectId: string, @Req() req: any) {
    const [project] = await this.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || (req.user.role !== 'viewer' && project.userId !== req.user.id)) {
      throw apiError('PROJECT_NOT_FOUND', 'Project not found or access denied', 404);
    }
    const logs = await this.db.select().from(auditLogs).where(eq(auditLogs.projectId, projectId)).orderBy(desc(auditLogs.createdAt));
    return { success: true, data: logs };
  }

  @Get('audit')
  async accountAudit(@Req() req: any) {
    if (req.user.role !== 'admin') throw apiError('UNAUTHORIZED', 'Admin access required', 403);
    const logs = await this.db.select().from(auditLogs).where(eq(auditLogs.userId, req.user.id)).orderBy(desc(auditLogs.createdAt)).limit(100);
    return { success: true, data: logs };
  }
}
