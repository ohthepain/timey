import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink, readdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { readProjectEnv } from '../project-env.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function requireArtifact(condition, message, code = 'ARTIFACT_INVALID') {
  if (condition) return;
  throw Object.assign(Error(message), { code });
}

function component(value, label) {
  requireArtifact(typeof value === 'string' && /^[\w][\w.-]{0,127}$/.test(value), `Choose a valid ${label}.`);
  return value;
}

function reference(store, hash, bytes, mediaType) {
  return { storeId: store.id, key: `${store.projectId}/sha256/${hash}`, sha256: hash, bytes, mediaType };
}

function validateRef(store, ref) {
  requireArtifact(ref?.storeId === store.id && validDigest(ref.sha256), 'Choose an artifact from this store.');
  requireArtifact(ref.key === `${store.projectId}/sha256/${ref.sha256}`, 'The artifact belongs to another project.');
  requireArtifact(Number.isSafeInteger(ref.bytes) && ref.bytes >= 0, 'The artifact size is invalid.');
}

function verified(ref, bytes) {
  requireArtifact(
    bytes.length === ref.bytes && digest(bytes) === ref.sha256,
    'Retained artifact contents changed. Reconcile the evidence before using it.',
    'ARTIFACT_CORRUPT'
  );
  return bytes;
}

async function bodyBytes(body) {
  if (typeof body === 'string' || body instanceof Uint8Array) return Buffer.from(body);
  requireArtifact(body?.[Symbol.asyncIterator], 'Supply artifact bytes or a readable stream.');
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function storageFailure(error, action) {
  if (String(error.code || '').startsWith('ARTIFACT_')) return error;
  return Object.assign(Error(`Artifact ${action} failed. Check the configured store and permissions.`), {
    code: 'STORE_UNAVAILABLE',
    providerCode: error.code || error.name,
  });
}

class ArtifactStore {
  constructor(config, options) {
    this.id = component(config.id, 'Artifact store');
    this.projectId = component(options.projectId, 'project identity');
    this.config = config;
    this.root = options.root;
  }
  async put({ body, mediaType = 'application/octet-stream' }) {
    const bytes = await bodyBytes(body);
    requireArtifact(typeof mediaType === 'string' && mediaType.length < 256, 'Choose a valid artifact media type.');
    const ref = reference(this, digest(bytes), bytes.length, mediaType);
    try {
      await this.write(ref, bytes);
      return ref;
    } catch (error) {
      throw storageFailure(error, 'upload');
    }
  }
  async get(ref) {
    validateRef(this, ref);
    try {
      return verified(ref, await this.read(ref));
    } catch (error) {
      throw storageFailure(error, 'read');
    }
  }
  async open(ref) {
    return Readable.from(await this.get(ref));
  }
  async inspect(ref) {
    try {
      await this.get(ref);
      return { ...ref };
    } catch (error) {
      if (error.code === 'ARTIFACT_MISSING') return null;
      throw error;
    }
  }
  async remove(ref) {
    validateRef(this, ref);
    try {
      await this.delete(ref);
    } catch (error) {
      throw storageFailure(error, 'deletion');
    }
  }
}

class FileArtifacts extends ArtifactStore {
  constructor(config, options) {
    super(config, options);
    this.directory = resolve(options.root, config.directory || `.issues/store-artifacts/${this.id}`);
  }
  path(ref) {
    return join(this.directory, this.projectId, ref.sha256);
  }
  async write(ref, bytes) {
    const file = this.path(ref);
    await mkdir(join(this.directory, this.projectId), { recursive: true });
    const temporary = file + '.' + randomUUID();
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    try {
      await link(temporary, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
    verified(ref, await this.read(ref));
    await writeFile(file + '.json', JSON.stringify(ref), { mode: 0o600, flag: 'wx' }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  async read(ref) {
    try {
      requireArtifact((await lstat(this.path(ref))).isFile(), 'Artifact storage requires a regular file.');
      return await readFile(this.path(ref));
    } catch (error) {
      if (error.code === 'ENOENT')
        throw Object.assign(Error('The retained artifact is missing.'), { code: 'ARTIFACT_MISSING' });
      throw error;
    }
  }
  async delete(ref) {
    for (const path of [this.path(ref), this.path(ref) + '.json'])
      await unlink(path).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
  async list() {
    const directory = join(this.directory, this.projectId);
    const names = await readdir(directory).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const refs = [];
    for (const name of names.filter(validDigest)) {
      const metadata = await readFile(join(directory, name + '.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      const details = await lstat(join(directory, name));
      requireArtifact(details.isFile(), 'Artifact storage requires a regular file.');
      const size = details.size;
      refs.push(reference(this, name, size, metadata?.mediaType || 'application/octet-stream'));
    }
    return refs;
  }
}

function missingS3(error) {
  return error.$metadata?.httpStatusCode === 404 || ['NoSuchKey', 'NotFound'].includes(error.name);
}

class S3Artifacts extends ArtifactStore {
  constructor(config, options) {
    super(config, options);
    const env = { ...readProjectEnv(options.root), ...process.env };
    this.bucket = config.bucket || env[config.bucketEnv || 'FACTORY_ARTIFACTS_BUCKET'];
    this.region = config.region || env[config.regionEnv || 'FACTORY_ARTIFACTS_BUCKET_REGION'];
    requireArtifact(this.bucket && this.region, 'Configure the artifact bucket and its region.');
    this.prefix = String(config.prefix || 'factory/artifacts').replace(/^\/+|\/+$/g, '');
    this.client = options.s3Client || new S3Client({ region: this.region });
  }
  objectKey(ref) {
    return `${this.prefix}/${ref.key}`;
  }
  async write(ref, bytes) {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(ref),
          Body: bytes,
          ContentType: ref.mediaType,
          ContentLength: ref.bytes,
          IfNoneMatch: '*',
          ChecksumSHA256: Buffer.from(ref.sha256, 'hex').toString('base64'),
          Metadata: { sha256: ref.sha256 },
        })
      );
    } catch (error) {
      if (![409, 412].includes(error.$metadata?.httpStatusCode)) throw error;
      verified(ref, await this.read(ref));
    }
  }
  async read(ref) {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(ref) }));
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (missingS3(error))
        throw Object.assign(Error('The retained artifact is missing.'), { code: 'ARTIFACT_MISSING' });
      throw error;
    }
  }
  async delete(ref) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(ref) }));
  }
  async list() {
    const refs = [];
    let token;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${this.prefix}/${this.projectId}/sha256/`,
          ContinuationToken: token,
        })
      );
      for (const object of page.Contents || []) {
        const hash = object.Key.split('/').at(-1);
        if (!validDigest(hash)) continue;
        const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: object.Key }));
        refs.push(reference(this, hash, Number(head.ContentLength), head.ContentType || 'application/octet-stream'));
      }
      token = page.NextContinuationToken;
    } while (token);
    return refs;
  }
}

class PostgresArtifacts extends ArtifactStore {
  constructor(config, options, pool) {
    super(config, options);
    this.pool = pool;
  }
  async initialize() {
    await this.pool.query('CREATE SCHEMA IF NOT EXISTS factory');
    await this.pool.query(`CREATE TABLE IF NOT EXISTS factory.artifact_objects (
      project_id text NOT NULL, store_id text NOT NULL, digest text NOT NULL,
      bytes bigint NOT NULL, media_type text NOT NULL, body bytea NOT NULL,
      PRIMARY KEY(project_id,store_id,digest))`);
  }
  async write(ref, bytes) {
    await this.pool.query(
      `INSERT INTO factory.artifact_objects(project_id,store_id,digest,bytes,media_type,body)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [this.projectId, this.id, ref.sha256, ref.bytes, ref.mediaType, bytes]
    );
    verified(ref, await this.read(ref));
  }
  async read(ref) {
    const result = await this.pool.query(
      'SELECT body FROM factory.artifact_objects WHERE project_id=$1 AND store_id=$2 AND digest=$3',
      [this.projectId, this.id, ref.sha256]
    );
    requireArtifact(result.rowCount === 1, 'The retained artifact is missing.', 'ARTIFACT_MISSING');
    return result.rows[0].body;
  }
  async delete(ref) {
    await this.pool.query('DELETE FROM factory.artifact_objects WHERE project_id=$1 AND store_id=$2 AND digest=$3', [
      this.projectId,
      this.id,
      ref.sha256,
    ]);
  }
  async list() {
    const result = await this.pool.query(
      'SELECT digest,bytes,media_type FROM factory.artifact_objects WHERE project_id=$1 AND store_id=$2',
      [this.projectId, this.id]
    );
    return result.rows.map((row) => reference(this, row.digest, Number(row.bytes), row.media_type));
  }
  async close() {
    await this.pool.end();
  }
}

class GitArtifacts extends ArtifactStore {
  constructor(config, options, records) {
    super(config, options);
    this.records = records;
    this.cache = new Map();
  }
  async write(ref, bytes) {
    const key = 'artifact/' + ref.sha256;
    const current = await this.records.get(key);
    if (current) {
      verified(ref, Buffer.from(current.value.body, 'base64'));
      return;
    }
    try {
      await this.records.commit({
        operationId: 'artifact-' + randomUUID(),
        expected: [{ key, revision: null }],
        writes: [{ key, value: { ref, body: bytes.toString('base64') } }],
      });
    } catch (error) {
      if (error.code !== 'STORE_CONFLICT') throw error;
      verified(ref, await this.read(ref));
    }
  }
  async read(ref) {
    if (this.cache.has(ref.sha256)) return Buffer.from(this.cache.get(ref.sha256));
    const current = await this.records.get('artifact/' + ref.sha256);
    requireArtifact(current, 'The retained artifact is missing.', 'ARTIFACT_MISSING');
    const body = verified(ref, Buffer.from(current.value.body, 'base64'));
    this.cache.set(ref.sha256, body);
    return Buffer.from(body);
  }
  async delete(ref) {
    this.cache.delete(ref.sha256);
    const key = 'artifact/' + ref.sha256;
    const current = await this.records.get(key);
    if (current)
      await this.records.commit({
        operationId: 'artifact-delete-' + randomUUID(),
        expected: [{ key, revision: current.revision }],
        writes: [{ key, value: null }],
      });
  }
  async list() {
    return (await this.records.list('artifact/')).map((record) => record.value.ref);
  }
  async close() {
    await this.records.close?.();
  }
}

export async function openArtifactStore(config, options) {
  if (config.kind === 'files') return new FileArtifacts(config, options);
  if (config.kind === 's3') return new S3Artifacts(config, options);
  if (config.kind === 'postgres') {
    const { createFactoryPool } = await import('./postgres-connection.mjs');
    const store = new PostgresArtifacts(config, options, await createFactoryPool(config, options));
    await store.initialize();
    return store;
  }
  if (config.kind === 'git') {
    const { openRecordStore } = await import('./providers.mjs');
    return new GitArtifacts(config, options, await openRecordStore(config, { ...options, inlinePayloads: true }));
  }
  throw Object.assign(Error('Choose files/Git, S3, or Postgres for artifacts.'), { code: 'STORE_CONFIG' });
}
