import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const lookup = spawnSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
if (![0, 1].includes(lookup.status)) throw Error(lookup.stderr || 'Cannot inspect Git hooks configuration.');
const existing = lookup.stdout.trim();
if (existing && existing !== '.githooks')
  throw Error(`Existing hooksPath ${existing}; integrate hooks explicitly before replacing it.`);
if (!existing) {
  const previous = execFileSync('git', ['rev-parse', '--git-path', 'hooks/pre-commit'], { encoding: 'utf8' }).trim();
  if (existsSync(previous))
    throw Error(`Existing pre-commit hook at ${previous}; integrate it explicitly before replacing it.`);
}
execFileSync('git', ['config', 'core.hooksPath', '.githooks']);
console.log('Installed the staged Fallow audit hook.');
