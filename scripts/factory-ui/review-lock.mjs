import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat } from './common.mjs';

export function releaseReviewLock(lock, run) {
  requireThat(
    JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).runId === run.id,
    'Review lock ownership changed.'
  );
  rmSync(lock, { recursive: true });
}
