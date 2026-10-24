import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson, requireThat, digest } from './factory-ui/common.mjs';

// Preserve the existing file and IDs. Both front doors now use this store.
export function readProgress(root) {
  const path = join(root, '.issues/factory-ui/lifecycle.json');
  if (!existsSync(path)) return {};
  const ledger = readJson(path);
  requireThat(
    ledger.version === 1 && ledger.issues && !Array.isArray(ledger.issues),
    'The saved progress record needs repair. It has not been reset.'
  );
  return ledger.issues;
}
export function writeProgress(root, record) {
  const directory = join(root, '.issues/factory-ui');
  mkdirSync(directory, { recursive: true });
  const lock = join(root, '.issues/factory-progress-record.lock');
  mkdirSync(lock);
  try {
    const issues = readProgress(root);
    issues[record.issueId] = record;
    writeJson(join(directory, 'lifecycle.json'), { version: 1, issues });
  } finally {
    rmSync(lock, { recursive: true });
  }
}
export function readCheckReceipt(root, id) {
  requireThat(typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id), 'Invalid completion receipt ID.');
  const path = join(root, '.issues/factory-progress', id + '.json');
  return existsSync(path) ? readJson(path) : legacyCheckReceipt(root, id);
}
export function writeCheckReceipt(root, record) {
  const directory = join(root, '.issues/factory-progress');
  mkdirSync(directory, { recursive: true });
  readCheckReceipt(root, record.id); // Validate the identity before constructing a writable path.
  writeJson(join(directory, record.id + '.json'), record);
}

function legacyCheckReceipt(root, id) {
  const path = join(root, '.issues/factory-ui/runs.json');
  if (!existsSync(path)) return null;
  const ledger = readJson(path);
  requireThat(
    ledger.version === 1 && Array.isArray(ledger.runs),
    'The legacy check receipts need repair; they were not reset.'
  );
  return ledger.runs.find((run) => matchingLegacyReceipt(run, id)) || null;
}
function matchingLegacyReceipt(run, id) {
  return run.id === id && run.status === 'completed' && typeof run.afterBasis === 'string';
}

export function completionBasis(snapshot, registry) {
  return digest(JSON.stringify({ snapshot, registry }));
}
