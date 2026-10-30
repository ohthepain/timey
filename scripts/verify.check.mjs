import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gitFixture } from './git-fixture.mjs';
import { fallowAuditScope } from './verify-scope.mjs';

test('fallow audit scope narrows to one path', () => {
  assert.equal(fallowAuditScope(['scripts/factory-ui/http.mjs']), 'scripts/factory-ui/http.mjs');
  assert.equal(
    fallowAuditScope(['scripts/factory-ui/http.mjs', 'scripts/factory-ui/lifecycle-stop.mjs']),
    'scripts/factory-ui'
  );
  assert.equal(fallowAuditScope(['index.js', 'new-dead.js']), '.');
  assert.equal(fallowAuditScope(['docs/agents/factory-ui.md', 'scripts/a.mjs']), '.');
});

test('staged audit sees the index even when unstaged changes hide an unused file', (t) => {
  const { root, git } = auditFixture(t);
  writeFileSync(join(root, 'extra.js'), 'export const extra = 42;\n');
  git('add', 'extra.js');
  writeFileSync(join(root, 'index.js'), 'import { extra } from "./extra.js";\nconsole.log(extra);\n');
  const before = git('diff', '--binary', 'HEAD');
  const script = resolve('scripts/verify.mjs');
  const staged = spawnSync(process.execPath, [script, '--staged', '--audit-only'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TIMEY_FALLOW_ENFORCE: '1' },
  });
  assert.equal(staged.status, 1, staged.stdout + staged.stderr);
  assert.match(staged.stdout, /FAIL fallow/);
  const working = spawnSync(process.execPath, [script, '--audit-only'], { cwd: root, encoding: 'utf8' });
  assert.equal(working.status, 0, working.stdout + working.stderr);
  assert.equal(git('diff', '--binary', 'HEAD'), before, 'audit must not modify the original index or worktree');
});

function auditFixture(t, extraFiles = {}) {
  const { root, git } = gitFixture(t, 'audit-checkpoint-');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n.issues/\n');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'checkpoint-fixture',
      type: 'module',
      main: 'index.js',
      scripts: { 'audit:staged': 'node scripts/verify.mjs --staged --audit-only' },
    })
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), readFileSync('pnpm-lock.yaml'));
  writeFileSync(join(root, '.fallowrc.json'), '{"entry":["index.js","scripts/*.mjs"]}\n');
  mkdirSync(join(root, 'scripts'));
  for (const name of [
    'verify.mjs',
    'verify-scope.mjs',
    'verify-process.mjs',
    'verify-preflight.mjs',
    'audit-result.mjs',
  ])
    writeFileSync(join(root, 'scripts', name), readFileSync(join('scripts', name)));
  writeFileSync(join(root, 'index.js'), 'console.log("baseline");\n');
  for (const [name, content] of Object.entries(extraFiles)) writeFileSync(join(root, name), content);
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'baseline');
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  const run = (...args) =>
    spawnSync(process.execPath, [resolve('scripts/verify.mjs'), '--audit-only', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TIMEY_FALLOW_ENFORCE: '1' },
    });
  return { root, git, run };
}

function auditSummary(root) {
  const evidence = join(root, '.issues/evidence');
  const name = readdirSync(evidence)
    .filter((entry) => entry.endsWith('-summary.json'))
    .sort()
    .at(-1);
  return JSON.parse(readFileSync(join(evidence, name), 'utf8'));
}

test('staged audit names an unstaged lockfile', (t) => {
  const { root, git } = auditFixture(t);
  git('rm', '--cached', '-q', '--', 'pnpm-lock.yaml');
  const result = spawnSync(process.execPath, [resolve('scripts/verify.mjs'), '--staged', '--audit-only'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pnpm-lock.yaml is not staged/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /ENOENT/);
});

test('real empty working and index snapshots record no unrelated analysis', (t) => {
  const { root, run } = auditFixture(t);
  const working = run('--step', '--base', 'HEAD');
  assert.equal(working.status, 0, working.stdout + working.stderr);
  assert.deepEqual(auditSummary(root).changed_files, []);
  assert.equal(auditSummary(root).checks[0].scope, 'empty');
  assert.ok(auditSummary(root).checks[0].limitations.some((entry) => entry.kind === 'empty-source-diff'));
  writeFileSync(join(root, 'untracked.js'), 'export const untracked = 1;\n');
  const staged = run('--staged');
  assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  assert.deepEqual(auditSummary(root).changed_files, [], 'index scope must exclude unstaged additions');
  const nonempty = run('--step', '--base', 'HEAD');
  assert.equal(nonempty.status, 1, nonempty.stdout + nonempty.stderr);
  assert.deepEqual(auditSummary(root).changed_files, ['untracked.js']);
  assert.equal(auditSummary(root).checks[0].scope, 'changed-files');
});

test('a compact tool report cannot hide exported untracked additions or deletions', (t) => {
  const { root, git } = auditFixture(t);
  const { root: tools } = gitFixture(t, 'audit-compact-command-');
  const compact = {
    kind: 'audit',
    schema_version: 13,
    version: '3.35.0',
    verdict: 'pass',
    changed_files_count: 0,
    attribution: { gate: 'all' },
    summary: { dead_code_issues: 0, complexity_findings: 0, duplication_clone_groups: 0 },
  };
  const fallowCommand = join(tools, 'fallow');
  writeFileSync(fallowCommand, '#!/usr/bin/env node\nconsole.log(' + JSON.stringify(JSON.stringify(compact)) + ');\n', {
    mode: 0o755,
  });
  const run = (mode = '--step') =>
    spawnSync(process.execPath, [resolve('scripts/verify.mjs'), mode, '--audit-only', '--base', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TIMEY_FALLOW_COMMAND: fallowCommand, TIMEY_FALLOW_ENFORCE: '1' },
    });
  assert.equal(run().status, 0, 'independently empty export permits the pinned compact fixture report');
  writeFileSync(join(root, 'new.js'), 'console.log("untracked");\n');
  assert.equal(run().status, 1, 'tool count zero cannot override the staged export diff');
  assert.deepEqual(auditSummary(root).changed_files, ['new.js']);
  assert.ok(auditSummary(root).checks[0].reasons.includes('Missing analysis diagnostics.'));
  rmSync(join(root, 'new.js'));
  symlinkSync('missing.js', join(root, 'dangling.js'));
  assert.equal(run().status, 1, 'a dangling untracked symlink must not disappear from the export');
  assert.deepEqual(auditSummary(root).changed_files, ['dangling.js']);
  unlinkSync(join(root, 'dangling.js'));
  rmSync(join(root, 'index.js'));
  assert.equal(run().status, 1);
  assert.deepEqual(auditSummary(root).changed_files, ['index.js']);
  git('add', '--update');
  assert.equal(run('--staged').status, 1, 'staged source deletion is still a nonempty index export');
  assert.deepEqual(auditSummary(root).changed_files, ['index.js']);
});

test('step completion requires its explicit starting revision', (t) => {
  const { run } = auditFixture(t);
  const result = run('--step');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Step completion requires --base/);
});

function aggregateFixture(t) {
  const { root, git } = auditFixture(t);
  const manifestPath = join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.scripts['test:factory'] = 'node --test scripts/factory-interface.check.mjs';
  manifest.scripts['test:browser'] = 'node index.js';
  manifest.scripts.build = 'node index.js';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"skipLibCheck":true},"files":["index.ts"]}\n');
  writeFileSync(join(root, 'index.ts'), 'console.log("types");\n');
  writeFileSync(
    join(root, 'fixture.test.js'),
    'import { test, expect } from "vitest";\ntest("fixture", () => expect(1).toBe(1));\n'
  );
  const interfacePath = join(root, 'scripts/factory-interface.check.mjs');
  const interfaceCheck = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
test('interface dispatch sentinel', () => {
  assert.notEqual(process.cwd(), ${JSON.stringify(root)});
  assert.equal(process.env.GIT_INDEX_FILE, undefined);
  assert.equal(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(), process.cwd());
});
`;
  writeFileSync(interfacePath, interfaceCheck);
  git('add', '.');
  git('commit', '-qm', 'aggregate fixture');
  const base = git('rev-parse', 'HEAD');
  mkdirSync(join(root, '.issues'), { recursive: true });
  const queuePath = join(root, '.issues/report.md');
  writeFileSync(queuePath, 'queue must remain unchanged\n');
  // Leave distinct staged and unstaged source so preservation covers both.
  writeFileSync(join(root, 'index.js'), 'console.log("staged");\n');
  git('add', 'index.js');
  writeFileSync(join(root, 'index.js'), 'console.log("working");\n');
  const run = () => {
    const before = {
      head: git('rev-parse', 'HEAD'),
      index: git('diff', '--cached', '--binary'),
      source: git('diff', '--binary'),
      queue: readFileSync(queuePath, 'utf8'),
    };
    // Start a fresh public CLI invocation, rather than a nested node:test runner.
    const env = { ...process.env, GIT_INDEX_FILE: join(root, '.git/index') };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [resolve('scripts/verify.mjs'), '--base', base], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
    assert.equal(git('rev-parse', 'HEAD'), before.head);
    assert.equal(git('diff', '--cached', '--binary'), before.index);
    assert.equal(git('diff', '--binary'), before.source);
    assert.equal(readFileSync(queuePath, 'utf8'), before.queue);
    const evidence = join(root, '.issues/evidence');
    const summaryPath = readdirSync(evidence)
      .filter((name) => name.endsWith('-summary.json'))
      .sort()
      .at(-1);
    const summary = JSON.parse(readFileSync(join(evidence, summaryPath), 'utf8'));
    return { result, summary, factory: summary.checks.find((check) => check.name === 'factory') };
  };
  return { root, run, interfacePath, interfaceCheck };
}

test('formatting handles changed symbolic links while still checking changed target source', (t) => {
  const { root, run } = aggregateFixture(t);
  symlinkSync('index.js', join(root, 'helper-link'));
  const { result, summary } = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(summary.changed_files.includes('helper-link'));
  const formatting = summary.checks.find((check) => check.name === 'format-changed');
  assert.equal(formatting.passed, true);
  assert.ok(formatting.command.includes('index.js'));
  assert.equal(formatting.command.includes('helper-link'), false);
});

test('aggregate verification dispatches the package factory suite in an isolated export', (t) => {
  const { run, interfacePath, interfaceCheck } = aggregateFixture(t);
  writeFileSync(interfacePath, interfaceCheck + 'throw Error("deliberate interface failure");\n');
  const failed = run();
  assert.equal(failed.result.status, 1, failed.result.stdout + failed.result.stderr);
  assert.equal(failed.factory.passed, false, readFileSync(failed.factory.log, 'utf8'));
  assert.match(readFileSync(failed.factory.log, 'utf8'), /deliberate interface failure/);
  assert.deepEqual(
    failed.summary.checks.map((check) => check.name),
    ['fallow', 'format-changed', 'browser', 'factory', 'typecheck', 'tests', 'build']
  );
  writeFileSync(interfacePath, interfaceCheck);
  const passed = run();
  assert.equal(
    passed.result.status,
    0,
    passed.summary.checks.map((check) => readFileSync(check.log, 'utf8')).join('\n')
  );
  assert.equal(passed.summary.passed, true);
  assert.match(readFileSync(passed.factory.log, 'utf8'), /interface dispatch sentinel/);
});

test('step and commit audits block only introduced findings in changed files', (t) => {
  const { root, git, run } = auditFixture(t, { 'unused.js': 'export const unused = 1;\n' });
  // Inherited dead code in an already-tracked file does not block under new-only.
  writeFileSync(join(root, 'unused.js'), 'export const unused = 2;\n');
  git('add', '.');
  for (const args of [['--step', '--base', 'HEAD'], ['--staged']]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  writeFileSync(join(root, 'new-dead.js'), 'export const orphan = 1;\n');
  git('add', 'new-dead.js');
  const introduced = run('--step', '--base', 'HEAD');
  assert.equal(introduced.status, 1, introduced.stdout + introduced.stderr);
  assert.match(introduced.stdout, /FAIL fallow/);
});

test('real pre-commit hook skips Fallow by default', (t) => {
  const { root, git } = auditFixture(t);
  git('config', 'core.hooksPath', resolve('.githooks'));
  writeFileSync(join(root, 'new-dead.js'), 'export const orphan = 1;\n');
  git('add', '.');
  const beforeHead = git('rev-parse', 'HEAD');
  const result = spawnSync('git', ['commit', '-qm', 'hook probe'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TIMEY_FALLOW_ENFORCE: '0', GIT_INDEX_FILE: join(root, '.git/index') },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /SKIP fallow/);
  assert.notEqual(git('rev-parse', 'HEAD'), beforeHead);
});

test('pre-commit hook blocks introduced dead code when TIMEY_FALLOW_ENFORCE=1', (t) => {
  const { root, git } = auditFixture(t);
  git('config', 'core.hooksPath', resolve('.githooks'));
  writeFileSync(join(root, 'new-dead.js'), 'export const orphan = 1;\n');
  git('add', '.');
  const beforeHead = git('rev-parse', 'HEAD');
  const beforeEntries = git('ls-files', '--stage');
  const beforeDiff = git('diff', '--cached', '--binary');
  const commit = (message) =>
    spawnSync('git', ['commit', '-qm', message], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_INDEX_FILE: join(root, '.git/index'), TIMEY_FALLOW_ENFORCE: '1' },
    });
  const failed = commit('hook probe');
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /FAIL fallow/);
  assert.equal(git('rev-parse', 'HEAD'), beforeHead);
  assert.equal(git('ls-files', '--stage'), beforeEntries);
  assert.equal(git('diff', '--cached', '--binary'), beforeDiff);
  writeFileSync(join(root, 'index.js'), 'import { orphan } from "./new-dead.js";\nconsole.log(orphan);\n');
  git('add', '.');
  const passed = commit('hook probe fixed');
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.notEqual(git('rev-parse', 'HEAD'), beforeHead);
});

test('a real zero-exit Fallow warning blocks the step checkpoint', (t) => {
  const { root, run } = auditFixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'fallow-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const entry = join(outside, 'issues.html');
  writeFileSync(entry, '<!doctype html><title>External command entry fixture</title>');
  const file = join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.scripts.outside = 'open ' + JSON.stringify(entry);
  writeFileSync(file, JSON.stringify(manifest));
  const result = run('--step', '--base', 'HEAD');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const evidence = join(root, '.issues/evidence');
  const summary = readdirSync(evidence).find((name) => name.endsWith('-summary.json'));
  const check = JSON.parse(readFileSync(join(evidence, summary), 'utf8')).checks[0];
  assert.equal(check.exit, 0);
  assert.equal(check.passed, false);
  assert.ok(check.reasons.some((reason) => reason.includes('warning')));
  assert.equal(auditSummary(root).phases.find((phase) => phase.name === 'fallow').passed, false);
});

test('execution preflight checks actual localhost access and exact installed dependency locks', async (t) => {
  const { listenerPreflight, dependencyPreflight } = await import('./verify-preflight.mjs');
  const { root } = auditFixture(t);
  await listenerPreflight();
  assert.doesNotThrow(() => dependencyPreflight(root, root, []));
  assert.throws(() => dependencyPreflight(root, root, ['missing-workspace']), /workspace dependencies missing/);
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'changed lock');
  assert.throws(() => dependencyPreflight(root, root, []), /do not match/);
});

test('cancelling verification stops only its owned process group and retains failure', async (t) => {
  const { runVerificationProcess } = await import('./verify-process.mjs');
  const { root } = gitFixture(t, 'verify-cancel-');
  const signal = new AbortController();
  const task = runVerificationProcess(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    { signal: signal.signal },
    join(root, 'check.log')
  );
  signal.abort();
  const result = await task;
  assert.notEqual(result.status, 0);
  assert.match(result.error, /cancelled/);
  assert.ok(result.pid);
  assert.throws(() => process.kill(result.pid, 0), /ESRCH/);
  const cancelled = await runVerificationProcess(
    process.execPath,
    ['-e', 'throw Error("must not start")'],
    { signal: signal.signal },
    join(root, 'not-started.log')
  );
  assert.equal(cancelled.pid, undefined);
  assert.match(cancelled.error, /cancelled/);
});

test('listener refusal stops preflight with an actionable environment error', async () => {
  const { EventEmitter } = await import('node:events');
  const { listenerPreflight } = await import('./verify-preflight.mjs');
  const server = new EventEmitter();
  server.listen = () => queueMicrotask(() => server.emit('error', { code: 'EPERM' }));
  await assert.rejects(
    listenerPreflight(() => server),
    (error) => error.code === 'PREFLIGHT_LISTENER' && /127.0.0.1/.test(error.message)
  );
});

test('browser interaction failures block aggregate verification while remaining checks still run', (t) => {
  const { root, run } = aggregateFixture(t);
  const path = join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.scripts['test:browser'] = 'node -e "throw Error(\'browser interaction regression\')"';
  writeFileSync(path, JSON.stringify(manifest));
  const { result, summary } = run();
  assert.equal(result.status, 1);
  assert.equal(summary.checks.find((check) => check.name === 'browser').passed, false);
  assert.equal(summary.checks.find((check) => check.name === 'factory').passed, true);
  assert.equal(summary.checks.find((check) => check.name === 'build').passed, true);
});

test('failed checks print assertion details for every failed test in the CI console', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'verify-failure-output-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'failures.test.mjs');
  writeFileSync(
    path,
    `import { test } from 'node:test'; import assert from 'node:assert/strict';
    for (let i = 0; i < 16; i++) test('failure ' + i, () => assert.equal('actual-' + i, 'expected-' + i));`
  );
  const env = { ...process.env, FORCE_COLOR: '0' };
  delete env.NODE_TEST_CONTEXT;
  const failed = spawnSync(process.execPath, ['--test', '--test-reporter=spec', path], {
    encoding: 'utf8',
    env,
  });
  assert.equal(failed.status, 1);
  const html = readFileSync('scripts/verify.mjs', 'utf8');
  const source = html.slice(html.indexOf('function recordCheck('), html.indexOf('async function run('));
  const lines = [];
  const record = new Function(
    'join',
    'reportDir',
    'stamp',
    'writeFileSync',
    'checkAssessment',
    'report',
    'console',
    'let failure = false; const snapshot = null;\n' + source + '\nreturn recordCheck;'
  )(
    join,
    '/tmp/evidence',
    'fixture',
    () => {},
    () => ({ passed: false }),
    { checks: [] },
    {
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
    }
  );
  record('factory', ['node', '--test'], { stdout: failed.stdout, stderr: failed.stderr, status: 1 });
  const printed = lines.join('\n');
  assert.match(printed, /actual-0/);
  assert.match(printed, /expected-15/);
  assert.match(printed, /AssertionError/);
  assert.match(printed, /at /);
  assert.doesNotMatch(printed, /more failure lines/);
  lines.length = 0;
  record('factory', ['node', '--test'], {
    stdout: failed.stdout + '\n✖ failing tests:\nsecond command failed',
    status: 1,
  });
  assert.match(lines.join('\n'), /expected-0/);
  assert.match(lines.join('\n'), /second command failed/);
  lines.length = 0;
  record('build', ['build'], { stderr: 'Error: Cannot resolve dependency\n  at build.mjs:12:4', status: 1 });
  assert.match(lines.join('\n'), /Cannot resolve dependency\n  at build.mjs:12:4/);
});
