import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { git } from './factory-ui/common.mjs';
import { assertSourceIssueSeparation } from './factory-ui/source-issue-separation.mjs';
import { createSharedIssueGit } from './factory-ui/shared-issue-git.mjs';
import { sharedIssueQueueConfig } from './factory-ui/shared-issue-config.mjs';

const id = '20261111T165430736-ca3555165563420b';
const reportPath = `.issues/${id}.md`;
const report = `---\nid: ${id}\ntitle: Keep reports\nstate: backlog\n---\n\nOriginal words.\n`;
const tool = fileURLToPath(new URL('./detach-issue-reports.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'source-issue-cutover-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-qb', 'dev');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.test');
  mkdirSync(join(root, '.issues'));
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify({ sharedIssueQueue: true, sharedIssueQueueBranch: 'issue-queue' })
  );
  writeFileSync(join(root, '.gitignore'), readFileSync(new URL('../.gitignore', import.meta.url)));
  writeFileSync(join(root, reportPath), report);
  writeFileSync(join(root, '.issues/issue-numbers.json'), JSON.stringify({ version: 1, next: 2, issues: { [id]: 1 } }));
  writeFileSync(join(root, '.issues/triage-labels.md'), 'Project policy\n');
  git(root, 'add', 'factory.config.json', '.gitignore');
  git(root, 'add', '-f', reportPath, '.issues/triage-labels.md');
  git(root, 'commit', '-qm', 'Source with legacy report');
  const writer = createSharedIssueGit({ root });
  const queue = writer.commit(
    git(root, 'rev-parse', 'HEAD'),
    [['.issues/issue-numbers.json', readFileSync(join(root, '.issues/issue-numbers.json'), 'utf8')]],
    'Shared queue'
  );
  git(root, 'branch', 'issue-queue', queue);
  return root;
}

test('cutover preserves local files and policy, is repeatable, and prevents source reintroduction', (t) => {
  const root = fixture(t);
  const run = (...args) =>
    JSON.parse(execFileSync(process.execPath, [tool, 'issue-queue', ...args], { cwd: root, encoding: 'utf8' }));
  assert.throws(() => assertSourceIssueSeparation(root), /belong on the issue queue branch/);
  assert.equal(run().applied, false);
  assert.equal(run('--apply').reports.length, 1);
  assert.equal(readFileSync(join(root, reportPath), 'utf8'), report);
  assert.equal(git(root, 'ls-files', '--', reportPath), '');
  assert.equal(git(root, 'ls-files', '--', '.issues/triage-labels.md'), '.issues/triage-labels.md');
  assert.equal(git(root, 'check-ignore', reportPath), reportPath);
  assert.deepEqual(run('--apply').reports, []);
  assert.doesNotThrow(() => assertSourceIssueSeparation(root));
  git(root, 'add', '-f', reportPath);
  assert.throws(() => assertSourceIssueSeparation(root), /belong on the issue queue branch/);
});

test('cutover refuses unpublished report bytes without modifying files or the index', (t) => {
  const root = fixture(t);
  const index = git(root, 'write-tree');
  writeFileSync(join(root, reportPath), report + 'Unpublished evidence.\n');
  assert.throws(
    () => execFileSync(process.execPath, [tool, 'issue-queue', '--apply'], { cwd: root, stdio: 'pipe' }),
    /Publish or reconcile differing reports/
  );
  assert.equal(git(root, 'write-tree'), index);
  assert.match(readFileSync(join(root, reportPath), 'utf8'), /Unpublished evidence/);
});

test('local file queues remain valid and shared queues cannot fall back to a source branch', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, 'factory.config.json'), '{}');
  git(root, 'add', 'factory.config.json');
  assert.doesNotThrow(() => assertSourceIssueSeparation(root));
  writeFileSync(
    join(root, '.issues/issue-delivery-config.json'),
    JSON.stringify({ provider: 'github', repository: 'example/timey', remote: 'origin', target: 'dev' })
  );
  writeFileSync(join(root, 'factory.config.json'), JSON.stringify({ sharedIssueQueue: true }));
  assert.throws(() => sharedIssueQueueConfig(root), /dedicated sharedIssueQueueBranch/);
});

test('the commit guard checks the selected index rather than the working config or another index', (t) => {
  const root = fixture(t);
  const index = join(root, '.git', 'separated-index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (...args) => execFileSync('git', ['-C', root, ...args], { env, stdio: 'pipe' });
  run('read-tree', 'HEAD');
  run('update-index', '--force-remove', '--', reportPath);
  const module = new URL('./factory-ui/source-issue-separation.mjs', import.meta.url).href;
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { assertSourceIssueSeparation } from ${JSON.stringify(module)}; assertSourceIssueSeparation(process.argv[1]);`,
      root,
    ],
    { env, stdio: 'pipe' }
  );
  writeFileSync(join(root, 'factory.config.json'), '{}');
  assert.throws(() => assertSourceIssueSeparation(root), /belong on the issue queue branch/);
});
