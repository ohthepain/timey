import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { git, digest } from '../common.mjs';
import { assertStoreState } from './coordination.mjs';

function committed(checkout) {
  assertStoreState(
    !git(checkout, 'status', '--porcelain', '--untracked-files=all'),
    'STORE_UNCOMMITTED_CHECKPOINT',
    'Commit the source work before sharing a source checkpoint.'
  );
  return { head: git(checkout, 'rev-parse', 'HEAD'), tree: git(checkout, 'rev-parse', 'HEAD^{tree}') };
}

export async function createSourceCheckpoint({ checkout, artifacts, projectId, base }) {
  const candidate = committed(checkout);
  const originalBase = base || candidate.head;
  git(checkout, 'merge-base', '--is-ancestor', originalBase, candidate.head);
  const directory = mkdtempSync(join(tmpdir(), 'factory-checkpoint-'));
  try {
    const bundle = join(directory, 'source.bundle');
    git(checkout, 'bundle', 'create', bundle, 'HEAD');
    const body = readFileSync(bundle);
    const artifact = await artifacts.put({ body, mediaType: 'application/x-git-bundle' });
    assertStoreState(
      committed(checkout).head === candidate.head,
      'STORE_CHECKPOINT_CHANGED',
      'The issue commit changed while sharing its source checkpoint.'
    );
    return { version: 1, projectId, ...candidate, base: originalBase, artifact, sha256: digest(body) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function verifyManifest(checkpoint, projectId, bytes) {
  assertStoreState(
    checkpoint.version === 1 && checkpoint.projectId === projectId,
    'STORE_CHECKPOINT_PROJECT',
    'The source checkpoint belongs to another project.'
  );
  assertStoreState(
    /^[a-f0-9]{40,64}$/.test(checkpoint.head) && /^[a-f0-9]{40,64}$/.test(checkpoint.tree),
    'STORE_INVALID_CHECKPOINT',
    'The source checkpoint has invalid Git identities.'
  );
  assertStoreState(
    digest(bytes) === checkpoint.sha256,
    'STORE_CHECKPOINT_DIGEST',
    'The retained source checkpoint changed.'
  );
}

function importBundle(repositoryRoot, bundle, checkpoint) {
  git(repositoryRoot, 'bundle', 'verify', bundle);
  const ref = 'refs/factory/checkpoints/' + checkpoint.head;
  git(repositoryRoot, 'fetch', '--no-tags', '--no-write-fetch-head', bundle, 'HEAD:' + ref);
  assertStoreState(
    git(repositoryRoot, 'rev-parse', ref) === checkpoint.head,
    'STORE_CHECKPOINT_HEAD',
    'The source checkpoint contains another commit.'
  );
  return ref;
}

function checkoutSource({ repositoryRoot, checkout, branch }, checkpoint, bundle) {
  assertStoreState(
    !existsSync(checkout),
    'STORE_CHECKPOINT_PATH',
    'The target checkout already exists. Preserve it before restoring source.'
  );
  mkdirSync(dirname(checkout), { recursive: true });
  if (!repositoryRoot) {
    mkdirSync(checkout);
    git(checkout, 'init', '-q');
    importBundle(checkout, bundle, checkpoint);
    git(checkout, 'checkout', '-qb', branch, checkpoint.head);
    return;
  }
  git(repositoryRoot, 'check-ref-format', '--branch', branch);
  importBundle(repositoryRoot, bundle, checkpoint);
  git(repositoryRoot, 'worktree', 'add', '-b', branch, checkout, checkpoint.head);
}

export async function restoreSourceCheckpoint({ checkpoint, artifacts, projectId, checkout, repositoryRoot, branch }) {
  const body = await artifacts.get(checkpoint.artifact);
  verifyManifest(checkpoint, projectId, body);
  const directory = mkdtempSync(join(tmpdir(), 'factory-restore-'));
  const selected = branch || 'codex/checkpoint-' + checkpoint.head.slice(0, 12);
  try {
    const bundle = join(directory, 'source.bundle');
    writeFileSync(bundle, body, { mode: 0o600 });
    checkoutSource({ repositoryRoot, checkout, branch: selected }, checkpoint, bundle);
    const actual = committed(checkout);
    assertStoreState(
      actual.head === checkpoint.head && actual.tree === checkpoint.tree,
      'STORE_CHECKPOINT_CONTENT',
      'Restored source differs from the shared checkpoint.'
    );
    git(checkout, 'merge-base', '--is-ancestor', checkpoint.base, checkpoint.head);
    return { checkout, branch: selected, base: checkpoint.base, head: checkpoint.head, tree: checkpoint.tree };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
