import { existsSync, readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import flowIntegration from './flow-integration-tests.json' with { type: 'json' };
import { normalizeFocusedTests } from './verify-merge-checks.mjs';

const manifest = '.github/pr-repair-tests.json';
const records = '.github/pr-repair-tests';
const args = process.argv.slice(2);
const base = args[0] === '--base' ? args[1] : undefined;
const changed =
  base &&
  new Set(
    execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', '-z', base, 'HEAD', '--', manifest, records], {
      encoding: 'utf8',
    }).split('\0')
  );

function legacyTests() {
  const plan = JSON.parse(readFileSync(manifest, 'utf8'));
  const named = plan.tests ?? [];
  const message = 'Record 1–20 named PR repair tests using manifest version 1.';
  assert.equal(plan.version, 1, message);
  assert.ok(Array.isArray(named), message);
  const tests = plan.suite === 'flow-integration' ? [...named, ...flowIntegration.tests] : named;
  checkLegacyCount(tests.length);
  return tests;
}

function selected(path) {
  return !changed || changed.has(path);
}

function checkLegacyCount(count) {
  if (count < 1 || count > 20) throw Error('Record 1–20 named PR repair tests using manifest version 1.');
}

function readRecord(path) {
  const test = JSON.parse(readFileSync(path, 'utf8'));
  const { runId, jobId, attemptId, checkout, tree } = test.source ?? {};
  const { timeoutMs = 120_000 } = test;
  const valid = (values, pattern) => values.every((value) => typeof value === 'string' && pattern.test(value));
  const message =
    path + ' needs version 2 provenance with a GitHub run and job or a Factory attempt, plus checkout and tree.';
  assert.equal(test.version, 2, message);
  if (attemptId === undefined) assert.ok(valid([runId, jobId], /^\d+$/), message);
  else assert.ok(valid([attemptId], /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/), message);
  assert.ok(valid([checkout, tree], /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), message);
  const timeoutMessage = path + ' timeoutMs must be an integer from 120000 to 240000.';
  assert.ok(Number.isInteger(timeoutMs), timeoutMessage);
  assert.ok(timeoutMs >= 120_000, timeoutMessage);
  assert.ok(timeoutMs <= 240_000, timeoutMessage);
  return test;
}

function recordedTests() {
  if (!existsSync(records)) return [];
  return readdirSync(records)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => records + '/' + name)
    .filter(selected)
    .map(readRecord);
}

const legacy = selected(manifest) && existsSync(manifest) ? legacyTests() : [];
const tests = [...legacy, ...recordedTests()];
if (!tests.length) {
  console.log('No changed PR repair test plan.');
} else {
  for (const test of tests) {
    if (typeof test.name !== 'string' || !test.name.trim() || /[\r\n]/.test(test.name))
      throw Error('Each PR repair test needs a single-line name.');
    normalizeFocusedTests([test.command]);
  }
  for (const test of tests) {
    console.log('RUN PR repair: ' + test.name);
    if (test.source) {
      const { runId, jobId, attemptId, checkout, tree } = test.source;
      const source = attemptId ? `Factory attempt ${attemptId}` : `run ${runId}, job ${jobId}`;
      console.log(`Source ${source}, checkout ${checkout}, tree ${tree}`);
    }
    const [command, ...argv] = test.command;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(command, argv, { stdio: 'inherit', timeout: test.timeoutMs ?? 120_000, env });
    if (result.error || result.status !== 0) {
      console.error('FAIL PR repair: ' + test.name);
      if (result.error) console.error(result.error.message);
      process.exit(result.status || 1);
    }
    console.log('PASS PR repair: ' + test.name);
  }
}
