import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inputDigest, validIdentity } from './coordination.mjs';
import { planDeletedFiles, removeDeletedFiles } from './deletion-files.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

function cachedManifest(root, issueId) {
  const path = join(root, '.issues/store-runtime/evidence', issueId, 'manifest.json');
  try {
    const bytes = readFileSync(path);
    const record = JSON.parse(bytes.toString());
    if (record.key !== 'evidence/' + issueId || !Array.isArray(record.value?.files)) return null;
    return { path, bytes, value: record.value };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function manifestCacheFiles(root, issueId) {
  const manifest = cachedManifest(root, issueId);
  if (!manifest) return [];
  const copies = manifest.value.files
    .filter((file) => /^[a-f0-9]{64}$/.test(file?.sha256 || ''))
    .map((file) => ({
      path: join(root, '.issues/store-runtime/evidence', issueId, file.sha256),
      sha256: file.sha256,
    }));
  return [manifest.value, { path: manifest.path, sha256: hash(manifest.bytes) }, ...copies];
}

function verifiedFlowFiles(root, issueId, flow) {
  if (!flow) return [];
  const owned = [flow];
  const path = join(root, '.issues/flows', issueId, 'flow.json');
  try {
    const bytes = readFileSync(path);
    if (inputDigest(JSON.parse(bytes.toString())) === inputDigest(flow)) owned.push({ path, sha256: hash(bytes) });
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return owned;
}

export function cleanupDeletedCache(root, snapshot, previous) {
  const retained = snapshot.issues.flatMap((issue) => [issue.flow, cachedManifest(root, issue.id)?.value]);
  const prior = new Map((previous?.issues || []).map((issue) => [issue.id, issue]));
  for (const id of snapshot.deletedIssueIds || []) {
    validIdentity(id);
    const owned = [...manifestCacheFiles(root, id), ...verifiedFlowFiles(root, id, prior.get(id)?.flow)];
    removeDeletedFiles(root, planDeletedFiles(root, owned, retained, { issueId: id }), { issueId: id });
  }
}
