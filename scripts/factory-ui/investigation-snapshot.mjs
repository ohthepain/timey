import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, requireThat } from './common.mjs';

export function investigationSnapshot(root, commit) {
  requireThat(/^[a-f0-9]{40}$/.test(commit || ''), 'Choose a committed revision for this investigation.');
  git(root, 'cat-file', '-e', commit + '^{commit}');
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'timey-investigation-')));
  try {
    git(root, 'clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout);
    git(checkout, 'checkout', '--quiet', '--detach', commit);
    git(checkout, 'remote', 'remove', 'origin');
    return { checkout, base: commit, temporary: true };
  } catch (error) {
    rmSync(checkout, { recursive: true, force: true });
    throw error;
  }
}

export function removeInvestigationSnapshot(snapshot) {
  if (snapshot) rmSync(snapshot.checkout, { recursive: true, force: true });
}
