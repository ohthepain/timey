import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { cleanEnvironment, requireThat } from './factory-ui/common.mjs';

const [reference, flag] = process.argv.slice(2);
requireThat(
  reference && [undefined, '--apply'].includes(flag),
  'Usage: node scripts/detach-issue-reports.mjs <verified-queue-ref> [--apply]'
);
const git = (...args) => execFileSync('git', args, { env: cleanEnvironment(), encoding: 'utf8', stdio: 'pipe' });
const head = git('rev-parse', '--verify', '--end-of-options', reference + '^{commit}').trim();
const registryPath = '.issues/issue-numbers.json';
const registry = JSON.parse(git('show', `${head}:${registryPath}`));
const paths = git('ls-files', '-z', '--', ':(glob).issues/[0-9]*.md', ':(glob).issues/closed/[0-9]*.md', registryPath)
  .split('\0')
  .filter(Boolean);
const conflicts = [];
for (const path of paths) {
  requireThat(lstatSync(path).isFile(), 'The report cache must contain regular files.');
  const local = readFileSync(path, 'utf8');
  const indexed = git('show', ':' + path);
  const id = path.split('/').at(-1).replace(/\.md$/, '');
  const candidates = path === registryPath ? [path] : [`.issues/${id}.md`, `.issues/closed/${id}.md`];
  const target = candidates.filter((candidate) => git('ls-tree', head, '--', candidate).trim());
  const stored = target.length === 1 && git('show', `${head}:${target[0]}`);
  const number = path === registryPath || Number.isSafeInteger(registry.issues?.[id]);
  if (local !== indexed || stored !== local || !number) conflicts.push(path);
}
requireThat(
  conflicts.length === 0,
  'Publish or reconcile differing reports before detaching source copies: ' + conflicts.join(', ')
);
if (flag === '--apply' && paths.length) git('rm', '--cached', '--', ...paths);
process.stdout.write(
  JSON.stringify({ queueCommit: head, reports: paths, applied: flag === '--apply', preservedLocalFiles: true }) + '\n'
);
