import { existsSync } from 'node:fs';
import { git } from './common.mjs';

export function pendingIssueMerge(checkout) {
  if (!checkout || !existsSync(checkout)) return null;
  const mergePath = git(checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD');
  if (!existsSync(mergePath)) return null;
  return {
    head: git(checkout, 'rev-parse', 'HEAD'),
    target: git(checkout, 'rev-parse', 'MERGE_HEAD'),
    conflicts: git(checkout, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean),
  };
}
