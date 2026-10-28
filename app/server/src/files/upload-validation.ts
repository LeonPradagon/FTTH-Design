import { BadRequestException, HttpException, PayloadTooLargeException } from '@nestjs/common';
import { basename, extname } from 'node:path';
import JSZip = require('jszip');

export const invalidFile = (message: string, details?: Record<string, unknown>) => new HttpException({ success: false, error: { code: 'INVALID_FILE', message, ...(details ? { details } : {}) } }, 400);
export const missingFile = (name: string) => new HttpException({ detail: [{ type: 'missing', loc: ['body', name], msg: 'Field required', input: null }] }, 422);

export async function validateDesignUpload(file: any, maxBytes = Number(process.env.MAX_UPLOAD_FILE_BYTES ?? process.env.MAX_BATCH_FILE_BYTES ?? 50 * 1024 * 1024)) {
  const name = basename(file?.originalname ?? '');
  const extension = extname(name).toLowerCase();
  if (!['.kml', '.kmz'].includes(extension)) throw invalidFile('File harus berformat KML atau KMZ.');
  if (!file?.buffer) throw new BadRequestException('File is required');
  if (file.buffer.length > maxBytes) throw new PayloadTooLargeException(`Ukuran file maksimal ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
  if (extension === '.kml') {
    if (!file.buffer.subarray(0, 65536).toString('utf8').toLowerCase().includes('<kml')) throw invalidFile('Isi file KML tidak valid.');
  } else {
    let zip: JSZip;
    try { zip = await JSZip.loadAsync(file.buffer); }
    catch { throw invalidFile('Isi file KMZ tidak valid.'); }
    const kmlFiles = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith('.kml'));
    if (!kmlFiles.length || kmlFiles.some((entry) => Number((entry as any)._data?.uncompressedSize ?? 0) > maxBytes)) throw invalidFile('KMZ tidak berisi KML yang valid.');
  }
  return name;
}
