import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { fixtureDeliveryCheck } from './issue-delivery-fixture.mjs';
import { checkCandidate, validateSummary } from './factory-ui/checks.mjs';
import { runLogged } from './factory-ui/common.mjs';
import { runVerificationProcess } from './verify-process.mjs';
import { CodexConnection } from './factory-ui/codex.mjs';
import { captureFixture } from './factory-capture-fixture.mjs';

test('failed candidate is retained across callers; explicit retry, changed inputs and damaged evidence recover', async (t) => {
  const fixture = gitFixture(t, 'factory-failed-check-');
  const root = realpathSync(fixture.root),
    git = fixture.git;
  writeFileSync(join(root, '.gitignore'), '.issues/\nnode_modules/\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const base = git('rev-parse', 'HEAD');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules/.modules.yaml'), 'fixture dependencies');
  const evidence = join(root, '.issues/evidence');
  const checked = await fixtureDeliveryCheck(root, base, evidence);
  const summaryPath = checked.summaries[0];
  const summary = JSON.parse(readFileSync(summaryPath));
  summary.passed = false;
  summary.checks.find((c) => c.name === 'factory').passed = false;
  writeFileSync(summaryPath, JSON.stringify(summary));
  const bin = join(root, '.issues/bin');
  mkdirSync(bin);
  const calls = join(bin, 'calls');
  writeFileSync(
    join(bin, 'pnpm'),
    '#!' +
      process.execPath +
      '\n' +
      `require('node:fs').appendFileSync(${JSON.stringify(calls)},'call\\n');console.log('Verification summary: '+${JSON.stringify(summaryPath)});process.exit(1);`,
    { mode: 0o755 }
  );
  const priorPath = process.env.PATH;
  process.env.PATH = bin + ':' + priorPath;
  t.after(() => {
    process.env.PATH = priorPath;
  });
  const count = () => readFileSync(calls, 'utf8').trim().split('\n').length;
  await assert.rejects(checkCandidate(root, base, join(root, '.issues/one')), /Required check failed/);
  await assert.rejects(checkCandidate(root, base, join(root, '.issues/two')), /unchanged candidate already failed/);
  assert.equal(count(), 1);
  await assert.rejects(
    checkCandidate(root, base, join(root, '.issues/retry'), { retryFailed: true }),
    /Required check failed/
  );
  assert.equal(count(), 2);
  writeFileSync(summaryPath, JSON.stringify({ ...summary, diagnostic: 'changed evidence' }));
  await assert.rejects(checkCandidate(root, base, join(root, '.issues/damaged')), /Required check failed/);
  assert.equal(count(), 3);
  writeFileSync(join(root, 'changed.js'), 'export const changed = true;\n');
  git('add', '.');
  git('commit', '-qm', 'changed candidate');
  await assert.rejects(checkCandidate(root, base, join(root, '.issues/changed')), /Required check failed/);
  assert.equal(count(), 4);
});

test('command log and progress update before exit; verifier keeps raw output out of the summary stream', async (t) => {
  const { root } = gitFixture(t, 'factory-live-check-');
  const log = join(root, 'live.log');
  let progress = '';
  const running = runLogged(
    root,
    process.execPath,
    ['-e', "console.log('START factory');setTimeout(()=>console.log('FAIL factory'),500)"],
    log,
    (chunk) => {
      progress += chunk;
    }
  );
  const deadline = Date.now() + 5000;
  while (!progress && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.match(readFileSync(log, 'utf8'), /START factory/);
  assert.doesNotMatch(progress, /FAIL factory/);
  await running;
  assert.match(progress, /FAIL factory/);
  const raw = join(root, 'raw.log');
  const result = await runVerificationProcess(
    process.execPath,
    ['-e', "console.log('fixture raw stdout');console.error('fixture raw stderr')"],
    { cwd: root },
    raw
  );
  assert.equal(result.status, 0);
  assert.match(readFileSync(raw, 'utf8'), /fixture raw stdout/);
  assert.match(result.stderr, /fixture raw stderr/);
});

test('project model preference applies to new chats and leaves resumed work alone', async (t) => {
  const { root } = gitFixture(t, 'factory-model-');
  writeFileSync(join(root, 'factory.config.json'), '{"factoryModel":"gpt-6-luna"}');
  const connection = new CodexConnection();
  connection.ready = async () => {};
  const requests = [];
  connection.call = async (method, params) => {
    requests.push({ method, params });
    return { thread: { id: 'fixture' } };
  };
  await connection.start(root, 'read-only');
  await connection.resume('fixture', root, 'read-only');
  assert.equal(requests[0].params.model, 'gpt-6-luna');
  assert.equal(requests[1].params.model, undefined);
});

test('factory fixtures reject unstubbed provider access immediately', async (t) => {
  const { root, service } = captureFixture(t);
  await assert.rejects(service.codex.start(root), /Unexpected provider access/);
});

test('default skipped Fallow remains valid while a failed required command blocks', async (t) => {
  const { root, git } = gitFixture(t, 'factory-skipped-fallow-');
  git('commit', '--allow-empty', '-qm', 'fixture');
  const base = git('rev-parse', 'HEAD');
  const result = await fixtureDeliveryCheck(root, base, join(root, '.issues/evidence'));
  const summary = JSON.parse(readFileSync(result.summaries[0]));
  summary.checks[0] = { name: 'fallow', passed: true, skipped: true, command: ['skipped'], log: summary.checks[0].log };
  assert.doesNotThrow(() => validateSummary(summary, base, result.tree));
  summary.checks.find((c) => c.name === 'factory').passed = false;
  assert.throws(() => validateSummary(summary, base, result.tree), /required check/);
});
