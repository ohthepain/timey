import { readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat } from './common.mjs';

export function releaseReviewLock(lock, run) {
  requireThat(
    JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).runId === run.id,
    'Review lock ownership changed.'
  );
  rmSync(lock, { recursive: true });
}

export function acquireReviewLock(root) {
  requireThat(!existsSync(join(root, '.issues/factory-integration.lock')), 'Finish the active integration first.');
  const lock = join(root, '.issues/factory-progress.lock');
  mkdirSync(lock);
  return lock;
}
