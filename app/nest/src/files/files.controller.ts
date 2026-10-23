import { BadRequestException, Controller, ForbiddenException, Get, Param, Post, Req, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash, randomBytes } from 'node:crypto';
import { basename, extname } from 'node:path';
import { ProxyAuthGuard } from '../auth/proxy-auth.guard';
import { StorageService } from '../storage/storage.service';

const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_FILE_BYTES ?? process.env.MAX_BATCH_FILE_BYTES ?? 50 * 1024 * 1024);
const userPrefix = (id: string) => `users/${createHash('sha256').update(id).digest('hex').slice(0, 32)}/`;
const publicName = (filename: string) => `/api/files/${encodeURIComponent(filename)}`;

@Controller()
@UseGuards(ProxyAuthGuard)
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  @Post('api/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD } }))
  async upload(@UploadedFile() file: any, @Req() req: any) {
    if (!['admin', 'engineer', 'user'].includes(req.user.role)) throw new ForbiddenException('Generation access is not allowed');
    if (!file) throw new BadRequestException('File is required');
    const original = basename(file.originalname ?? 'upload');
    const extension = extname(original).toLowerCase();
    if (!['.kml', '.kmz'].includes(extension)) throw new BadRequestException('File harus berformat KML atau KMZ.');
    if (extension === '.kml' && !file.buffer.subarray(0, 65536).toString('utf8').toLowerCase().includes('<kml')) throw new BadRequestException('Isi file KML tidak valid.');
    if (extension === '.kmz' && (file.buffer[0] !== 0x50 || file.buffer[1] !== 0x4b)) throw new BadRequestException('Isi file KMZ tidak valid.');
    const safe = original.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 180) || 'upload';
    const filename = `${randomBytes(5).toString('hex')}_${safe}`;
    await this.storage.upload(`${userPrefix(req.user.id)}${filename}`, file.buffer, file.mimetype || 'application/octet-stream', filename);
    return { success: true, data: { url: publicName(filename) } };
  }

  @Get('api/files/:filename')
  async downloadUserFile(@Param('filename') filename: string, @Req() req: any, @Res({ passthrough: true }) res: any) {
    if (!['admin', 'engineer', 'user'].includes(req.user.role)) throw new ForbiddenException('Generation access is not allowed');
    if (basename(filename) !== filename) throw new BadRequestException('Invalid filename');
    let object;
    try { object = await this.storage.download(`${userPrefix(req.user.id)}${filename}`); }
    catch (error) {
      try { object = await this.storage.download(`${req.user.id}/${filename}`); }
      catch { throw error; }
    }
    res.setHeader('Content-Type', object.contentType);
    if (object.contentLength != null) res.setHeader('Content-Length', object.contentLength);
    if (object.contentDisposition) res.setHeader('Content-Disposition', object.contentDisposition);
    return new StreamableFile(object.body);
  }

  @Get('data/*objectKey')
  async downloadData(@Param('objectKey') objectKey: string, @Req() req: any, @Res({ passthrough: true }) res: any) {
    if (basename(objectKey) === '' || objectKey.split('/').includes('..')) throw new BadRequestException('Invalid object key');
    const prefix = userPrefix(req.user.id);
    if (!objectKey.startsWith(prefix) && !objectKey.startsWith('imports/') && !objectKey.startsWith('generated/')) throw new BadRequestException('File not found');
    const object = await this.storage.download(objectKey);
    res.setHeader('Content-Type', object.contentType);
    if (object.contentLength != null) res.setHeader('Content-Length', object.contentLength);
    if (object.contentDisposition) res.setHeader('Content-Disposition', object.contentDisposition);
    return new StreamableFile(object.body);
  }
}
