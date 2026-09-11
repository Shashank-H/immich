import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Injectable } from '@nestjs/common';
import archiver from 'archiver';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { CrawlOptionsDto, WalkOptionsDto } from 'src/dtos/library.dto';
import { ConfigRepository } from 'src/repositories/config.repository';
import {
  ImmichReadStream,
  ImmichZipStream,
  ReadRange,
  StorageMetadata,
  StorageRepository,
} from 'src/repositories/storage.repository';

@Injectable()
export class S3StorageRepository implements StorageRepository {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly mediaLocation: string;
  private readonly encryption: { ServerSideEncryption?: 'AES256' | 'aws:kms'; SSEKMSKeyId?: string };

  constructor(configRepository: ConfigRepository) {
    const { storage } = configRepository.getEnv();
    if (!storage.s3) {
      throw new Error('S3 storage repository was selected without S3 configuration');
    }
    this.bucket = storage.s3.bucket;
    this.prefix = storage.s3.keyPrefix;
    this.mediaLocation = storage.mediaLocation ?? '/data';
    this.encryption = {
      ServerSideEncryption: storage.s3.serverSideEncryption,
      SSEKMSKeyId: storage.s3.sseKmsKeyId,
    };
    this.client = new S3Client({
      region: storage.s3.region,
      endpoint: storage.s3.endpoint,
      forcePathStyle: storage.s3.forcePathStyle,
      credentials: storage.s3.credentials,
    });
  }

  async resolvePath(filepath: string) {
    await this.getMetadata(filepath);
    return filepath;
  }

  async list(folder: string) {
    const key = `${this.key(folder).replace(/\/$/, '')}/`;
    const entries = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: key,
          Delimiter: '/',
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of result.Contents ?? []) {
        if (item.Key !== key) entries.add(item.Key!.slice(key.length).split('/')[0]);
      }
      for (const item of result.CommonPrefixes ?? []) entries.add(item.Prefix!.slice(key.length).replace(/\/$/, ''));
      continuationToken = result.NextContinuationToken;
    } while (continuationToken);
    return [...entries];
  }

  async copyFile(source: string, target: string) {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: this.key(target),
        CopySource: encodeURIComponent(`${this.bucket}/${this.key(source)}`).replaceAll('%2F', '/'),
        ...this.encryption,
      }),
    );
  }

  async getMetadata(filepath: string): Promise<StorageMetadata> {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(filepath) }));
    const modifiedAt = result.LastModified ?? new Date(0);
    return { size: result.ContentLength ?? 0, accessedAt: modifiedAt, modifiedAt, createdAt: modifiedAt, type: 'file' };
  }

  async createFile(filepath: string, buffer: Buffer) {
    await this.put(filepath, buffer, true);
  }

  createWriteStream(filepath: string): Writable {
    const body = new PassThrough();
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: this.key(filepath), Body: body, ...this.encryption },
    });
    const done = upload.done();
    return new Writable({
      write(chunk, encoding, callback) {
        body.write(chunk, encoding, callback);
      },
      final(callback) {
        body.end();
        done.then(() => callback()).catch(callback);
      },
      destroy(error, callback) {
        void upload.abort();
        body.destroy();
        callback(error);
      },
    });
  }

  async createOrOverwriteFile(filepath: string, buffer: Buffer) {
    await this.put(filepath, buffer);
  }

  async overwriteFile(filepath: string, buffer: Buffer) {
    if (!(await this.exists(filepath)))
      throw Object.assign(new Error(`File does not exist: ${filepath}`), { code: 'ENOENT' });
    await this.put(filepath, buffer);
  }

  async publish(source: string, target: string) {
    await this.copyFile(source, target);
    await this.deleteFile(source);
  }

  async setFileTimes() {
    // S3 timestamps are maintained by the object store and cannot be assigned by clients.
  }

  createZipStream(): ImmichZipStream {
    const archive = archiver('zip', { store: true });
    return {
      stream: archive,
      addFile: (inputPath, filename) => {
        const input = new PassThrough();
        archive.append(input, { name: filename, mode: 0o644 });
        this.createReadStream(inputPath)
          .then(({ stream }) => stream.pipe(input))
          .catch((error) => input.destroy(error));
      },
      finalize: () => archive.finalize(),
    };
  }

  createGzip(): PassThrough {
    return createGzip();
  }
  createGunzip(): PassThrough {
    return createGunzip();
  }

  createPlainReadStream(filepath: string): Readable {
    const output = new PassThrough();
    this.get(filepath)
      .then((result) => result.pipe(output))
      .catch((error) => output.destroy(error));
    return output;
  }

  async createReadStream(filepath: string, mimeType?: string | null): Promise<ImmichReadStream> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(filepath) }));
    return {
      stream: response.Body as Readable,
      length: response.ContentLength,
      type: mimeType || response.ContentType,
    };
  }

  async readFile(filepath: string, range?: ReadRange): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(filepath),
        Range: range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : undefined,
      }),
    );
    return Buffer.from(await response.Body!.transformToByteArray());
  }

  async readJsonFile<T>(filepath: string): Promise<T> {
    return JSON.parse((await this.readFile(filepath)).toString()) as T;
  }

  async exists(filepath: string) {
    try {
      await this.getMetadata(filepath);
      return true;
    } catch (error) {
      if ((error as { name?: string; $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        return false;
      throw error;
    }
  }

  async deleteFile(filepath: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(filepath) }));
  }

  async deleteDirectory(folder: string) {
    const keys = await this.listKeys(`${this.key(folder).replace(/\/$/, '')}/`);
    for (let index = 0; index < keys.length; index += 1000) {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.slice(index, index + 1000).map((Key) => ({ Key })) },
        }),
      );
    }
  }

  async removeEmptyDirs() {}
  async createDirectory() {}

  async crawl({ pathsToCrawl }: CrawlOptionsDto) {
    return this.paths(await this.listPathKeys(pathsToCrawl));
  }

  async *walk({ pathsToCrawl, take }: WalkOptionsDto): AsyncGenerator<string[]> {
    const values = this.paths(await this.listPathKeys(pathsToCrawl));
    for (let index = 0; index < values.length; index += take) yield values.slice(index, index + take);
  }

  private key(filepath: string) {
    const normalized = path.posix.normalize(filepath);
    const root = this.mediaLocation.replace(/\/$/, '');
    const relative = (
      normalized === root ? '' : normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
    ).replace(/^\/+/, '');
    return [this.prefix, relative].filter(Boolean).join('/');
  }

  private async put(filepath: string, body: Buffer, exclusive = false) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(filepath),
        Body: body,
        IfNoneMatch: exclusive ? '*' : undefined,
        ...this.encryption,
      }),
    );
  }

  private async get(filepath: string) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(filepath) }));
    return result.Body as Readable;
  }

  private async listPathKeys(paths: string[]) {
    return (await Promise.all(paths.map((value) => this.listKeys(this.key(value))))).flat();
  }
  private paths(keys: string[]) {
    const prefix = this.prefix ? `${this.prefix}/` : '';
    return keys.map((key) => path.posix.join(this.mediaLocation, key.slice(prefix.length)));
  }

  private async listKeys(prefix: string) {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuationToken }),
      );
      keys.push(...(result.Contents ?? []).flatMap(({ Key }) => (Key ? [Key] : [])));
      continuationToken = result.NextContinuationToken;
    } while (continuationToken);
    return keys;
  }
}
