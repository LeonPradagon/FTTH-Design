import { Injectable, OnModuleInit, NotFoundException } from '@nestjs/common';
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly bucket = process.env.STORAGE_BUCKET ?? 'ftth-designs';
  private readonly client = new S3Client({
    region: process.env.STORAGE_REGION ?? 'us-east-1',
    endpoint: process.env.STORAGE_ENDPOINT_URL,
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE !== 'false',
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'ftth-local',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'ftth-local-secret',
    },
  });

  async onModuleInit() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error: any) {
      if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== 'NotFound' && error?.name !== 'NoSuchBucket') throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async upload(key: string, body: Buffer, contentType: string, filename: string) {
    await new Upload({ client: this.client, params: {
      Bucket: this.bucket, Key: key, Body: body, ContentType: contentType,
      ContentDisposition: `inline; filename="${filename.replace(/["\\\r\n]/g, '_')}"`,
    } }).done();
  }

  async download(key: string) {
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
}
