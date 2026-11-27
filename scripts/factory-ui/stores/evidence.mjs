import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const locators = new Set([
  'path',
  'file',
  'log',
  'proof',
  'supportingProof',
  'files',
  'summaries',
  'summaryPath',
  'evidence',
]);
const media = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
};
const resolvers = new Map();
const resolverGenerations = new WeakMap();
let nextResolverGeneration = 0;

function evidenceError(message) {
  return Object.assign(Error(message), { code: 'STORE_EVIDENCE_GAP' });
}
function within(root, path) {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child);
}
function sourcePath(path, parent, root) {
  return isAbsolute(path) ? path : resolve(parent ? dirname(parent) : root, path);
}

function locator(path, parent, root, sha256) {
  return {
    path: sourcePath(path, parent, root),
    ...(parent && { parentPath: parent }),
    ...(validDigest(sha256) && { sha256 }),
  };
}

function stringReference(value, parent, root, field) {
  if (!locators.has(field) || (!isAbsolute(value) && !parent)) return null;
  return locator(value, parent, root);
}

function declaredReference(value, parent, root, field) {
  if (typeof value.path !== 'string') return null;
  if (!validDigest(value.sha256) && !locators.has(field)) return null;
  return locator(value.path, parent, root, value.sha256);
}

function references(value, parent, root, found = [], field = '') {
  if (typeof value === 'string') {
    const entry = stringReference(value, parent, root, field);
    if (entry) found.push(entry);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  const entry = declaredReference(value, parent, root, field);
  if (entry) found.push(entry);
  const children = Array.isArray(value)
    ? value.map((item) => [field, item])
    : Object.entries(value).filter(([key]) => key !== 'path');
  for (const [key, item] of children) references(item, parent, root, found, key);
  return found;
}

async function controlledBytes(path, roots) {
  const actual = await realpath(path);
  if (!roots.some((root) => within(root, actual)))
    throw evidenceError('The reference is outside the approved issue evidence roots.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw evidenceError('The evidence reference is not a regular file.');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function gapReason(error) {
  if (error.code === 'ENOENT') return 'missing';
  if (error.code === 'ELOOP') return 'symbolic-link';
  return error.code === 'STORE_EVIDENCE_GAP' ? 'outside-approved-roots' : 'unreadable';
}

export async function collectEvidence({
  root,
  flow,
  artifacts,
  originId = 'legacy',
  allowedRoots = [join(root, '.issues')],
}) {
  const roots = await Promise.all(allowedRoots.map((path) => realpath(path)));
  const locatorRoots = [...roots, ...allowedRoots.map((path) => resolve(path))];
  const manifest = { version: 1, originId, root: resolve(root), files: [], gaps: [] };
  const tasks = references(flow, null, root);
  const seen = new Set();
  async function collect(reference) {
    const identity = reference.path + '\0' + (reference.sha256 || '');
    if (seen.has(identity)) return;
    seen.add(identity);
    if (!reference.sha256 && !locatorRoots.some((root) => within(root, resolve(reference.path)))) return;
    let bytes;
    try {
      bytes = await controlledBytes(reference.path, roots);
    } catch (error) {
      manifest.gaps.push({ ...reference, reason: gapReason(error) });
      return;
    }
    const sha256 = digest(bytes);
    if (reference.sha256 && sha256 !== reference.sha256) {
      manifest.gaps.push({ ...reference, actualSha256: sha256, reason: 'digest-mismatch' });
      return;
    }
    const existing = manifest.files.find((file) => file.path === reference.path && file.sha256 === sha256);
    if (existing) return;
    const ref = await artifacts.put({
      body: bytes,
      mediaType: media[extname(reference.path)] || 'application/octet-stream',
    });
    manifest.files.push({ path: reference.path, sha256, bytes: bytes.length, ref });
    if (extname(reference.path) !== '.json') return;
    let nested;
    try {
      nested = JSON.parse(bytes.toString('utf8'));
    } catch {
      return;
    }
    tasks.push(...references(nested, reference.path, root));
  }
  let cursor = 0;
  while (cursor < tasks.length) {
    const batch = tasks.slice(cursor, cursor + 4);
    cursor += batch.length;
    await Promise.all(batch.map(collect));
  }
  manifest.files = [...new Map(manifest.files.map((file) => [file.path + '\0' + file.sha256, file])).values()];
  manifest.files.sort((left, right) => left.path.localeCompare(right.path) || left.sha256.localeCompare(right.sha256));
  manifest.gaps.sort((left, right) => left.path.localeCompare(right.path));
  return manifest;
}

async function retain(directory, file, artifacts) {
  if (!validDigest(file.sha256)) throw evidenceError('The evidence manifest digest is invalid.');
  const bytes = Buffer.from(await artifacts.get(file.ref));
  if (digest(bytes) !== file.sha256 || bytes.length !== file.bytes)
    throw evidenceError('Retained evidence bytes differ from the manifest.');
  const path = join(directory, file.sha256);
  const temporary = path + '.' + randomUUID();
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { ...file, localPath: path };
}

export async function hydrateEvidence({ manifest, artifacts, directory }) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.gaps))
    throw evidenceError('The evidence manifest is invalid.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw evidenceError('Evidence materialization requires a real directory.');
  const target = await realpath(directory);
  const files = [];
  const gaps = [...manifest.gaps];
  for (let index = 0; index < manifest.files.length; index += 4) {
    await Promise.all(
      manifest.files.slice(index, index + 4).map(async (file) => {
        try {
          files.push(await retain(target, file, artifacts));
        } catch {
          gaps.push({ path: file.path, sha256: file.sha256, reason: 'artifact-unavailable-or-corrupt' });
        }
      })
    );
  }
  function selected(path, sha256, parentPath) {
    const original = sourcePath(path, parentPath, manifest.root);
    const matches = files.filter((file) => file.path === original && (!sha256 || file.sha256 === sha256));
    if (matches.length !== 1) throw evidenceError('The original evidence reference is missing or ambiguous.');
    const file = matches[0];
    if (!lstatSync(file.localPath).isFile()) throw evidenceError('The materialized evidence is not a regular file.');
    const bytes = readFileSync(file.localPath);
    if (digest(bytes) !== file.sha256 || bytes.length !== file.bytes)
      throw evidenceError('The materialized evidence bytes changed.');
    return { ...file, body: bytes };
  }
  const knows = (path, sha256, parentPath) => {
    const original = sourcePath(path, parentPath, manifest.root);
    return [...manifest.files, ...manifest.gaps].some(
      (file) => file.path === original && (!sha256 || !file.sha256 || file.sha256 === sha256)
    );
  };
  return {
    manifest,
    files,
    gaps,
    knows,
    resolve: (path, sha256, parentPath) => selected(path, sha256, parentPath).localPath,
    read: (path, sha256, parentPath) => selected(path, sha256, parentPath).body,
  };
}

export function retainedEvidencePath(root, path, sha256, parentPath) {
  try {
    const local = evidencePath(root, sourcePath(path, parentPath, root), sha256);
    if (digest(readFileSync(local)) === sha256) return local;
  } catch {
    // Exported copies can have a different original locator.
  }
  return resolveRetainedHash(root, sha256);
}

function resolveRetainedHash(root, sha256) {
  const project = resolvers.get(resolve(root)) ?? new Map();
  for (const resolver of project.values()) {
    const file = resolver.files.find((entry) => entry.sha256 === sha256);
    if (file) return resolver.resolve(file.path, sha256);
  }
  throw evidenceError('The retained evidence digest is unavailable.');
}

export function evidenceResolverGeneration(root) {
  return resolverGenerations.get(resolvers.get(resolve(root))) || 0;
}

export function registerEvidenceResolver(root, resolver, { originId = resolver.manifest.originId } = {}) {
  const key = resolve(root);
  if (!resolvers.has(key)) resolvers.set(key, new Map());
  const project = resolvers.get(key);
  if (project.get(originId) !== resolver) {
    project.set(originId, resolver);
    resolverGenerations.set(project, ++nextResolverGeneration);
  }
  return () => {
    if (project.get(originId) === resolver) {
      project.delete(originId);
      resolverGenerations.set(project, ++nextResolverGeneration);
    }
    if (!project.size && resolvers.get(key) === project) resolvers.delete(key);
  };
}

export function evidencePath(root, path, sha256, parentPath) {
  if (!root) return path;
  const project = resolvers.get(resolve(root));
  if (!project?.size) return path;
  let missing;
  for (const resolver of project.values()) {
    if (!resolver.knows(path, sha256, parentPath)) continue;
    try {
      return resolver.resolve(path, sha256, parentPath);
    } catch (error) {
      missing = error;
    }
  }
  if (missing) throw missing;
  const local = sourcePath(path, parentPath, root);
  let actual;
  try {
    actual = realpathSync(local);
  } catch {
    throw evidenceError('The unknown evidence reference is unavailable on this runner.');
  }
  if (!within(realpathSync(join(root, '.issues')), actual) || !lstatSync(local).isFile())
    throw evidenceError('The unknown evidence reference is outside this project issue storage.');
  if (sha256 && digest(readFileSync(actual)) !== sha256) throw evidenceError('The local evidence digest changed.');
  return actual;
}
