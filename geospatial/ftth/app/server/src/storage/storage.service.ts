import { Injectable, OnModuleInit, NotFoundException } from '@nestjs/common';
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly bucket = process.env.STORAGE_BUCKET ?? 'ftth-designs';
  private readonly region = process.env.STORAGE_REGION ?? 'us-east-1';
  private readonly localRoot = resolve(process.env.STORAGE_LOCAL_ROOT ?? join(tmpdir(), 'ftth_local_storage'));
  private readonly useLocal = process.env.STORAGE_DRIVER === 'local';
  private readonly client = new S3Client({
    region: this.region,
    endpoint: process.env.STORAGE_ENDPOINT_URL,
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE !== 'false',
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'ftth-local',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'ftth-local-secret',
    },
  });

  async onModuleInit() {
    if (this.useLocal) { await mkdir(this.localRoot, { recursive: true }); return; }
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error: any) {
      if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== 'NotFound' && error?.name !== 'NoSuchBucket') throw error;
      await this.client.send(new CreateBucketCommand({
        Bucket: this.bucket,
        ...(this.region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: this.region as any } }),
      }));
    }
  }

  async upload(key: string, body: Buffer, contentType: string, filename: string) {
    if (this.useLocal) {
      const path = this.localPath(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      await writeFile(`${path}.meta.json`, JSON.stringify({ contentType, contentDisposition: `inline; filename="${filename.replace(/["\\\r\n]/g, '_')}"` }));
      return;
    }
    await new Upload({ client: this.client, params: {
      Bucket: this.bucket, Key: key, Body: body, ContentType: contentType,
      ContentDisposition: `inline; filename="${filename.replace(/["\\\r\n]/g, '_')}"`,
    } }).done();
  }

  async download(key: string) {
    if (this.useLocal) {
      const path = this.localPath(key);
      try {
        const [body, metadata, info] = await Promise.all([
          readFile(path),
          readFile(`${path}.meta.json`, 'utf8').then((value) => JSON.parse(value)).catch(() => ({})),
          stat(path),
        ]);
        return { body: Readable.from(body), contentType: metadata.contentType ?? 'application/octet-stream', contentLength: info.size, contentDisposition: metadata.contentDisposition };
      } catch (error: any) {
        if (error?.code === 'ENOENT') throw new NotFoundException('File not found');
        throw error;
      }
    }
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        body: result.Body as Readable,
        contentType: result.ContentType ?? 'application/octet-stream',
        contentLength: result.ContentLength,
        contentDisposition: result.ContentDisposition,
      };
    } catch (error: any) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NoSuchKey' || error?.name === 'NotFound') throw new NotFoundException('File not found');
      throw error;
    }
  }

  async delete(key: string) {
    if (this.useLocal) {
      const path = this.localPath(key);
      await Promise.all([rm(path, { force: true }), rm(`${path}.meta.json`, { force: true })]);
      return;
    }
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  private localPath(key: string) {
    const path = resolve(this.localRoot, key);
    if (!path.startsWith(`${this.localRoot}/`)) throw new NotFoundException('File not found');
    return path;
  }
}
