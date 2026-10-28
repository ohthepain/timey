import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, readJson, requireThat } from './factory-ui/common.mjs';

// A retry checks the retained merged tree. It never repeats an uncertain merge.
export function assembleExisting(store, delivery, intent) {
  const name = 'assembly-' + intent.actionId + '-merge',
    path = join(store.directory, name + '.json');
  const head = git(delivery.checkout, 'rev-parse', 'HEAD');
  requireThat(
    !git(delivery.checkout, 'status', '--porcelain'),
    'The issue branch has uncommitted changes. Preserve them before retrying its checks.'
  );
  if (existsSync(path)) {
    const saved = readJson(path);
    requireThat(
      saved.head === head && saved.before === intent.before && saved.workerRevision === intent.workerRevision,
      'The saved issue branch changed after assembly. Review the new changes before retrying; the original result is kept.'
    );
    return;
  }
  if (head !== intent.before) {
    // Legacy interruption after the merge: accept only the exact worker or two-parent merge.
    const parents = git(delivery.checkout, 'show', '-s', '--format=%P', head).split(' ');
    requireThat(
      head === intent.workerRevision ||
        (parents.length === 2 && parents[0] === intent.before && parents[1] === intent.workerRevision),
      'The existing issue branch does not match the saved merge. Review it before retrying; no merge was repeated.'
    );
    requireThat(
      git(delivery.checkout, 'merge-base', intent.before, head) === intent.before,
      'The existing issue branch does not include its saved base.'
    );
  } else {
    try {
      git(delivery.checkout, 'merge', '--no-edit', intent.workerRevision);
    } catch (error) {
      error.preserveLock = true;
      throw error;
    }
  }
  store.retain(name, {
    before: intent.before,
    workerRevision: intent.workerRevision,
    head: git(delivery.checkout, 'rev-parse', 'HEAD'),
  });
}
