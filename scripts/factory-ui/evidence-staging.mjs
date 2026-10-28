import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, readJson, requireThat } from './common.mjs';
import { evidence, proof } from '../issue-delivery-store.mjs';

// Only worker-declared, hash-checked files enter the store. Completion-review paths
// never grant import authority. Staging records bytes, not test success.
function regularFile(path) {
  requireThat(typeof path === 'string' && isAbsolute(path), `Artifact needs an absolute path: ${path}`);
  let current = resolve(path);
  while (true) {
    requireThat(!lstatSync(current).isSymbolicLink(), `Artifact uses a symlink: ${path}`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    // /tmp and /var are platform aliases, not worker-controlled links.
    if (['/tmp', '/var'].includes(current)) break;
  }
  const stat = lstatSync(path);
  requireThat(stat.isFile() && stat.size <= 16 * 1024 * 1024, `Artifact must be a regular file at most 16 MB: ${path}`);
  return realpathSync(path);
}
function inside(root, path) {
  const child = relative(realpathSync(root), path);
  return child && !child.startsWith('..' + sep) && child !== '..' && !isAbsolute(child);
}
function retain(root, bytes) {
  const directory = join(realpathSync(root), '.issues/evidence/artifacts');
  mkdirSync(directory, { recursive: true });
  requireThat(realpathSync(directory) === directory, 'Artifact store must not contain symlinks.');
  const path = join(directory, digest(bytes));
  if (existsSync(path))
    requireThat(digest(readFileSync(regularFile(path))) === digest(bytes), `Retained artifact changed: ${path}`);
  else writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return proof(path);
}
export function stageWorkerArtifacts(root, action, checked, artifacts = []) {
  if (!artifacts.length) return null;
  requireThat(artifacts.length <= 128, 'Declare at most 128 supporting artifacts.');
  let total = 0;
  const files = artifacts.map((entry) => {
    const path = regularFile(entry.path);
    requireThat(
      inside(root, path) || inside(tmpdir(), path),
      `Artifact is outside the project and temporary work folders: ${entry.path}`
    );
    evidence({ ...entry, path });
    const bytes = readFileSync(path);
    total += bytes.length;
    requireThat(total <= 64 * 1024 * 1024, 'Supporting artifacts exceed 64 MB.');
    return { source: entry.path, ...retain(root, bytes) };
  });
  const index = {
    actionId: action.id,
    issues: action.issues,
    candidate: checked.head,
    tree: checked.tree,
    originalBase: action.start?.revision || action.basis.head,
    files,
  };
  return retain(root, Buffer.from(JSON.stringify(index) + '\n'));
}
export function completionArtifacts(root, delivery) {
  const files = new Map();
  for (const contribution of delivery.contributions) {
    evidence(contribution.receipt);
    const receipt = readJson(contribution.receipt.path);
    if (!receipt.review) continue;
    evidence(receipt.review);
    const review = readJson(receipt.review.path);
    const text = review.action?.evidence;
    let selected;
    try {
      selected = JSON.parse(typeof text === 'string' ? text.split(' Independent checks: ')[0] : '{}');
    } catch {
      selected = {};
    }
    const retained = selected.retainedArtifacts || review.retainedArtifacts;
    if (!retained) continue; // Legacy prose remains readable; never invent an artifact declaration.
    requireThat(inside(root, regularFile(retained.path)), `Artifact index is outside the project: ${retained.path}`);
    evidence(retained);
    const index = readJson(retained.path);
    requireThat(
      index.actionId === contribution.actionId &&
        index.candidate === contribution.workerRevision &&
        index.originalBase === contribution.originalBase &&
        JSON.stringify(index.issues) === JSON.stringify(contribution.issues),
      'Retained artifacts do not match the assembled contribution candidate, scope or base.'
    );
    for (const file of index.files) {
      requireThat(inside(root, regularFile(file.path)), `Retained artifact is outside the project: ${file.path}`);
      evidence(file);
      requireThat(
        !files.has(file.source) || files.get(file.source).sha256 === file.sha256,
        `Conflicting artifact: ${file.source}`
      );
      files.set(file.source, file);
      files.set(file.path, file);
    }
  }
  return files;
}
