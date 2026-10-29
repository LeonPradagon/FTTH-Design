import { BadRequestException, Controller, ForbiddenException, Get, InternalServerErrorException, NotFoundException, Param, Post, Req, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash, randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { ProxyAuthGuard } from '../auth/proxy-auth.guard';
import { StorageService } from '../storage/storage.service';
import { missingFile, validateDesignUpload } from './upload-validation';
import { GenerationRateLimiter } from '../auth/generation-rate-limiter';

const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_FILE_BYTES ?? process.env.MAX_BATCH_FILE_BYTES ?? 50 * 1024 * 1024);
const userPrefix = (id: string) => `users/${createHash('sha256').update(id).digest('hex').slice(0, 32)}/`;
const publicName = (filename: string) => `/api/files/${encodeURIComponent(filename)}`;
const contentType = (filename: string) => filename.toLowerCase().endsWith('.kmz')
  ? 'application/vnd.google-earth.kmz'
  : filename.toLowerCase().endsWith('.kml')
    ? 'application/vnd.google-earth.kml+xml'
    : 'application/octet-stream';

@Controller()
@UseGuards(ProxyAuthGuard)
export class FilesController {
  constructor(private readonly storage: StorageService, private readonly rateLimiter: GenerationRateLimiter) {}

  private async requireGeneration(req: any) {
    if (!['admin', 'engineer', 'user'].includes(req.user.role)) throw new ForbiddenException('Generation access is not allowed');
    await this.rateLimiter.consume(req.user.id, req.res);
  }

  @Post('api/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD } }))
  async upload(@UploadedFile() file: any, @Req() req: any) {
    await this.requireGeneration(req);
    if (!file) throw missingFile('file');
    const original = await validateDesignUpload(file, MAX_UPLOAD);
    const safe = original.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 180) || 'upload';
    const filename = `${randomBytes(5).toString('hex')}_${safe}`;
    try { await this.storage.upload(`${userPrefix(req.user.id)}${filename}`, file.buffer, contentType(filename), filename); }
    catch { throw new InternalServerErrorException('Failed to upload file'); }
    return { success: true, data: { url: publicName(filename) } };
  }

  @Get('api/files/:filename')
  async downloadUserFile(@Param('filename') filename: string, @Req() req: any, @Res({ passthrough: true }) res: any) {
    if (!['admin', 'engineer', 'user'].includes(req.user.role)) throw new ForbiddenException('Generation access is not allowed');
    if (basename(filename) !== filename) throw new BadRequestException('Invalid filename');
    let object;
    try { object = await this.storage.download(`${userPrefix(req.user.id)}${filename}`); }
    catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      try { object = await this.storage.download(`${req.user.id}/${filename}`); }
      catch (legacyError) { if (!(legacyError instanceof NotFoundException)) throw legacyError; throw error; }
    }
    res.setHeader('Content-Type', object.contentType);
    if (object.contentLength != null) res.setHeader('Content-Length', object.contentLength);
    if (object.contentDisposition) res.setHeader('Content-Disposition', object.contentDisposition);
    return new StreamableFile(object.body);
  }

  @Get('data/*objectKey')
  async downloadData(@Param('objectKey') objectKey: string | string[], @Req() req: any, @Res({ passthrough: true }) res: any) {
    const key = Array.isArray(objectKey) ? objectKey.join('/') : objectKey;
    if (!key || key.split('/').includes('..')) throw new NotFoundException('File not found');
    const prefix = userPrefix(req.user.id);
    if (!key.startsWith(prefix) && !key.startsWith('imports/') && !key.startsWith('generated/')) throw new NotFoundException('File not found');
    const object = await this.storage.download(key);
    res.setHeader('Content-Type', object.contentType);
    if (object.contentLength != null) res.setHeader('Content-Length', object.contentLength);
    if (object.contentDisposition) res.setHeader('Content-Disposition', object.contentDisposition);
    return new StreamableFile(object.body);
  }
}
