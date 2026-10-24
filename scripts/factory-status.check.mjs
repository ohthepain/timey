import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { factory } from './factory.mjs';
import { gitFixture } from './git-fixture.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'factory.mjs');

function fixture(t) {
  const { root: directory, git } = gitFixture(t, 'factory-status-');
  const root = realpathSync(directory);
  writeFileSync(join(root, '.gitignore'), '.issues/\n');
  git('add', '.gitignore');
  git('commit', '-qm', 'fixture');
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, '.issues/triage-labels.md'), '| Role | State | Next |\n| closed | closed | — |\n');
  const ledger = join(root, '.issues/factory.json');
  const records = (actions) => writeFileSync(ledger, JSON.stringify({ version: 1, actions }));
  const run = (...args) =>
    execFileSync(process.execPath, [script, 'status', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  return { root, git, ledger, records, run };
}

const action = (id, status, extra = {}) => ({
  id,
  title: `Task ${id}`,
  status,
  kind: 'implement',
  merge: 'automatic',
  issues: ['issue-one'],
  created: '2026-10-24T10:00:00.000Z',
  ...extra,
});

test('status reads saved results without loading reports, prompts or evidence contents, and preserves files', (t) => {
  const { root, ledger, records, run } = fixture(t);
  const evidence = join(root, '.issues/evidence');
  mkdirSync(evidence);
  writeFileSync(join(evidence, 'result.json'), 'EVIDENCE_CONTENT_MUST_NOT_BE_LOADED');
  const report = join(root, '.issues/20261024-invalid.md');
  writeFileSync(report, 'malformed report: REPORT_BODY_MUST_NOT_BE_LOADED');
  symlinkSync(join(root, 'absent.md'), join(root, '.issues/20261024-missing.md'));
  const prompt = 'PROMPT_MUST_NOT_BE_LOADED'.repeat(1000);
  records([
    action('merged-action', 'integrated', {
      evidence: 'Checks passed. See .issues/evidence/result.json.',
      worker_prompt: prompt,
    }),
    action('pending-action', 'setup', { clientThreadId: 'pending-chat', worker_prompt: prompt }),
  ]);
  const before = [ledger, report, join(root, '.git/index')].map((path) => readFileSync(path));
  const text = run();
  assert.match(text, /Last recorded factory status/);
  assert.match(text, /Merged/);
  assert.match(text, /Setting up/);
  assert.match(text, /No result recorded/);
  assert.match(text, /result\.json/);
  assert.doesNotMatch(text, /MUST_NOT_BE_LOADED|worker_prompt/);
  assert.ok(text.length < 2000);
  const data = JSON.parse(run('--json'));
  assert.equal(data.tasks[1].chat.clientThreadId, 'pending-chat');
  assert.deepEqual(data.tasks[0].evidence, [{ path: join(evidence, 'result.json'), available: true }]);
  assert.match(data.tasks[0].remaining[0], /acceptance/);
  assert.equal(data.tasks[0].recorded_at, '2026-10-24T10:00:00.000Z');
  assert.deepEqual(
    [ledger, report, join(root, '.git/index')].map((path) => readFileSync(path)),
    before
  );
});

test('targeted status resolves unique action prefixes; full records require an explicit single selection', (t) => {
  const { records, run } = fixture(t);
  records([
    action('alpha-one', 'completed', { worker_prompt: 'ARCHIVED_REQUEST_ONE' }),
    action('alpha-two', 'reconciled', { kind: 'review', worker_prompt: 'ARCHIVED_REQUEST_TWO' }),
  ]);
  assert.equal(JSON.parse(run('alpha-one', '--json')).tasks.length, 1);
  assert.equal(JSON.parse(run('alpha-o', '--details')).action.worker_prompt, 'ARCHIVED_REQUEST_ONE');
  assert.doesNotMatch(run('alpha-o', '--details'), /ARCHIVED_REQUEST_TWO/);
  for (const args of [['alpha'], ['unknown'], ['--details'], ['alpha-one', 'alpha-two', '--details'], ['--live']]) {
    assert.throws(() => run(...args));
  }
});

test('missing and damaged factory records produce diagnostics without creating or repairing anything', (t) => {
  const { ledger, run } = fixture(t);
  assert.match(run(), /records are missing/);
  assert.throws(() => readFileSync(ledger), /ENOENT/);
  writeFileSync(ledger, '{broken');
  assert.throws(() => run());
  assert.equal(readFileSync(ledger, 'utf8'), '{broken');
  writeFileSync(ledger, JSON.stringify({ version: 2, actions: [] }));
  assert.throws(
    () => run(),
    (error) => /Unsupported or damaged/.test(error.stderr)
  );
  rmSync(ledger);
  assert.equal(JSON.parse(run('--json')).tasks.length, 0);
});

test('concise reporting fields are validated and cannot survive a newer result accidentally', (t) => {
  const { root, git, records, run } = fixture(t);
  records([action('code-action', 'running', { threadId: 'worker', hostId: 'local' })]);
  const api = factory(root);
  const completion = {
    status: 'completed',
    evidence: 'Actual verification evidence.',
    worker_revision: git('rev-parse', 'HEAD'),
  };
  assert.throws(() => api.record('code-action', { ...completion, remaining: 'not a list' }), /Invalid status summary/);
  assert.equal(JSON.parse(run('--json')).tasks[0].status, 'running');
  api.record('code-action', {
    ...completion,
    summary: 'All checks passed.',
    remaining: ['Review and merge this change.'],
    evidence_links: ['.issues/evidence/not-yet-retained.json'],
  });
  const completed = JSON.parse(run('--json')).tasks[0];
  assert.equal(completed.result, 'All checks passed.');
  assert.deepEqual(completed.remaining, ['Review and merge this change.']);
  assert.equal(completed.evidence[0].available, false);
  api.record('code-action', {
    status: 'integrated',
    evidence: 'Combined checks passed after merge.',
    verified_revision: git('rev-parse', 'HEAD'),
    checks_passed: true,
  });
  const integrated = JSON.parse(run('--json')).tasks[0];
  assert.equal(integrated.result, 'Combined checks passed after merge.');
  assert.doesNotMatch(integrated.remaining.join(' '), /merge this change/);
});

test('compact output bounds old evidence and escapes Markdown without claiming acceptance', (t) => {
  const { records, run } = fixture(t);
  records([
    action('unsafe-label', 'completed', {
      title: 'Task | [injected](target)',
      evidence: 'Long evidence '.repeat(2000),
      summary: 'Passed | checks\nwith a limitation.',
      remaining: [],
    }),
  ]);
  const text = run();
  assert.match(text, /Task \\\| \\\[injected/);
  assert.match(text, /Passed \\\| checks with a limitation/);
  assert.match(text, /Issue acceptance is separate/);
  assert.ok(text.length < 1500);
  const full = JSON.parse(run('unsafe-label', '--details'));
  assert.ok(full.action.evidence.length > 10000);
});
