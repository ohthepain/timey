import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gitFixture } from './git-fixture.mjs';
import { retainBrowserEvidence } from './verify-browser-evidence.mjs';
import { fallowAuditScope } from './verify-scope.mjs';
import { factoryCheckCommand, normalizeFocusedTests } from './verify-merge-checks.mjs';
import { flowMergeChecks } from './factory-ui/flow-verification.mjs';
import { validateSummary } from './factory-ui/checks.mjs';
import { digest } from './factory-ui/common.mjs';

test('Merge uses the Request setting and records only completed upstream focused tests', () => {
  const command = ['node', '--test', 'scripts/one.check.mjs'];
  const request = { id: 'request', kind: 'request', after: [], data: {} };
  const work = {
    id: 'work',
    kind: 'work',
    after: ['request'],
    attempts: [{ status: 'completed', result: { focusedTests: [command] } }],
  };
  const unrelated = {
    ...work,
    id: 'other',
    attempts: [{ status: 'completed', result: { focusedTests: [['pnpm', 'run', 'test:unrelated']] } }],
  };
  const block = { id: 'merge', kind: 'merge', after: ['work'] };
  const ctx = { block, flow: { blocks: [request, work, unrelated, block] } };
  assert.deepEqual(flowMergeChecks(ctx), { scope: 'default', focusedRecorded: true, focused: [command] });
  request.data.fullRegression = true;
  assert.equal(flowMergeChecks(ctx).scope, 'full');
  work.attempts.push({ status: 'completed', invalidatedAt: 'edited', result: { focusedTests: [] } });
  assert.deepEqual(flowMergeChecks(ctx), { scope: 'full', focusedRecorded: false, focused: [] });
  assert.equal(flowMergeChecks({ ...ctx, block: { kind: 'verify' } }), undefined);
  assert.deepEqual(normalizeFocusedTests([command, command]), [command]);
  const browser = ['node', 'scripts/capture-grilling-browser.mjs'];
  assert.deepEqual(normalizeFocusedTests([browser]), [browser]);
  const scenarios = [
    'node',
    'scripts/flow-browser.mjs',
    '--project-discuss',
    '--project-issues',
    '--local-notes',
    '--issue-status-folders',
  ];
  assert.deepEqual(normalizeFocusedTests([scenarios]), [scenarios]);
  for (const invalid of [
    ['sh', '-c', 'test'],
    ['pnpm', 'run', 'test:factory'],
    ['node', '--test', 'scripts/a.check.mjs', '--import', 'other.mjs'],
    ['node', 'scripts/other-browser.mjs', '--all'],
    ['node', 'scripts/factory-browser.mjs'],
    ['node', 'scripts/flow-browser.mjs'],
    ['node', 'scripts/flow-browser.mjs', '--project-discuss', 'scripts/other.mjs'],
    ['node', 'scripts/flow-browser.mjs', '--project-discuss', '--import=other.mjs'],
    ['node', 'scripts/../other-browser.mjs'],
  ])
    assert.throws(() => normalizeFocusedTests([invalid]), /Record focused test commands/);
});

test('Merge evidence checks the regression scope and the exact focused commands', (t) => {
  const { root } = gitFixture(t, 'merge-scope-');
  const { proof, browser, factory } = Object.fromEntries(
    ['proof', 'browser', 'factory'].map((name) => [name, join(root, name)])
  );
  writeFileSync(proof, 'fixture');
  writeFileSync(browser, 'PASS browser scenario: fixture');
  writeFileSync(factory, 'ℹ tests 5');
  const artifactHash = digest('fixture');
  const focused = [['node', '--test', 'scripts/one.check.mjs']];
  const plan = (scope) => ({ scope, focusedRecorded: true, focused });
  const step = { base: 'base', snapshot_tree: 'tree', passed: true, checkpoint: 'step', checks: [] };
  assert.throws(
    () => validateSummary({ ...step, mergeChecks: plan('default') }, 'base', 'tree', { mergeChecks: plan('full') }),
    /verification scope/
  );
  validateSummary({ ...step, mergeChecks: plan('full') }, 'base', 'tree', { mergeChecks: plan('default') });
  const checks = [
    { name: 'fallow', skipped: true, passed: true, command: ['skipped'] },
    { name: 'factory', passed: true, exit: 0, command: factoryCheckCommand('default'), log: factory },
    { name: 'browser', passed: true, exit: 0, log: browser, artifacts: [{ path: proof, sha256: artifactHash }] },
    ...['typecheck', 'tests', 'build'].map((name) => ({ name, passed: true, exit: 0 })),
  ];
  const summary = { ...step, checkpoint: 'verification', changed_files: [], mergeChecks: plan('default'), checks };
  assert.throws(() => validateSummary(summary, 'base', 'tree'), /focused test is missing/);
  checks.push({ name: 'focused-1', passed: true, exit: 0, command: focused[0] });
  validateSummary(summary, 'base', 'tree');
  checks[1].command = factoryCheckCommand('full');
  assert.throws(() => validateSummary(summary, 'base', 'tree'), /different regression suite/);
});

test('browser evidence retains declared proof with valid hashes and excludes nested Git repositories', (t) => {
  const { root } = gitFixture(t, 'verify-browser-evidence-');
  const output = join(root, 'browser-output');
  const repository = join(output, 'flow/project');
  mkdirSync(repository, { recursive: true });
  execFileSync('git', ['init', '-q', repository]);
  const object = execFileSync('git', ['-C', repository, 'hash-object', '-w', '--stdin'], { input: 'fixture only' })
    .toString()
    .trim();
  const objectPath = join(repository, '.git/objects', object.slice(0, 2), object.slice(2));
  assert.ok(readFileSync(objectPath).length);
  const screenshot = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=',
    'base64'
  );
  const declared = {
    'queue.png': screenshot,
    'results.json': '{"passed":true}',
    'flow/project-discuss-styles.json': '{"messageBorderWidth":"0px"}',
    'flow/project-discuss.png': screenshot,
  };
  for (const [file, bytes] of Object.entries(declared)) writeFileSync(join(output, file), bytes);
  writeFileSync(join(repository, 'fixture.png'), screenshot);
  writeFileSync(join(output, 'flow/fixture-state.json'), '{"temporary":true}');
  symlinkSync(objectPath, join(output, 'flow/internal.png'));
  const retained = join(root, '.issues/evidence/browser');
  const linkedOutput = join(root, 'symlinked-output');
  symlinkSync(output, linkedOutput, 'dir');
  assert.deepEqual(retainBrowserEvidence(linkedOutput, retained), []);
  const artifacts = retainBrowserEvidence(output, retained);
  const files = Object.fromEntries(artifacts.map(({ path, sha256 }) => [relative(retained, path), sha256]));
  assert.deepEqual(files, Object.fromEntries(Object.entries(declared).map(([file, bytes]) => [file, digest(bytes)])));
  const retainedFiles = readdirSync(retained, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(retained, join(entry.parentPath, entry.name)))
    .sort();
  assert.deepEqual(retainedFiles, Object.keys(declared).sort());

  const log = join(root, '.issues/evidence/browser.log');
  writeFileSync(log, 'PASS browser scenario: proof collection fixture\n');
  const browser = { name: 'browser', passed: true, exit: 0, log, artifacts };
  const summary = { base: 'base', snapshot_tree: 'tree', passed: true, checks: [browser] };
  validateSummary(summary, 'base', 'tree');
  t.diagnostic(JSON.stringify({ retained: files, nestedGitObject: object, evidenceValidation: 'passed' }));
  writeFileSync(artifacts[0].path, 'tampered proof');
  assert.throws(() => validateSummary(summary, 'base', 'tree'), /Browser evidence changed/);
});

test('a hung verification command reports its deadline as a timeout', async (t) => {
  const { root } = gitFixture(t, 'merge-timeout-');
  const { runVerificationProcess } = await import('./verify-process.mjs');
  const result = await runVerificationProcess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { cwd: root, timeoutMs: 150 },
    join(root, 'timeout.log')
  );
  assert.equal(result.timedOut, true);
  assert.match(result.error, /timed out.*setInterval/);
});

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

function copySourceSeparation(root) {
  mkdirSync(join(root, 'scripts/factory-ui'), { recursive: true });
  for (const name of [
    'source-issue-separation.mjs',
    'shared-issue-config.mjs',
    'common.mjs',
    'diagnostic-activity.mjs',
  ])
    writeFileSync(join(root, 'scripts/factory-ui', name), readFileSync(join('scripts/factory-ui', name)));
}

test('staged formatter checks issue reports from an in-repository snapshot', (t) => {
  const { root, git } = gitFixture(t, 'format-staged-');
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'format-staged-fixture', private: true }));
  writeFileSync(join(root, 'scripts/format-staged.mjs'), readFileSync(resolve('scripts/format-staged.mjs')));
  copySourceSeparation(root);
  writeFileSync(join(root, '.prettierignore'), '');
  writeFileSync(join(root, '.issues/report.md'), '# A staged report  \n');
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  git('add', '.prettierignore', '.issues/report.md');
  const result = spawnSync(process.execPath, ['scripts/format-staged.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /report\.md/);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith('.timey-format-staged-')),
    []
  );
  git('reset', '-q', '--', '.issues/report.md');
  mkdirSync(join(root, '.issues/closed'), { recursive: true });
  mkdirSync(join(root, '.issues/archive'), { recursive: true });
  const closed = '.issues/closed/20261116-closed.md';
  const archived = '.issues/archive/20261116-archived.md';
  writeFileSync(join(root, closed), '# Closed report  \n');
  writeFileSync(join(root, archived), '# Archived report  \n');
  git('add', '--', closed, archived);
  const unstaged = '# Archived report  \n\nUnstaged text.\n';
  writeFileSync(join(root, archived), unstaged);
  const formatted = spawnSync(process.execPath, ['scripts/format-staged.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(formatted.status, 0, formatted.stdout + formatted.stderr);
  assert.equal(git('show', ':' + closed), '# Closed report');
  assert.equal(git('show', ':' + archived), '# Archived report');
  assert.equal(readFileSync(join(root, closed), 'utf8'), '# Closed report\n');
  assert.equal(readFileSync(join(root, archived), 'utf8'), unstaged);
});

function auditFixture(t, extraFiles = {}) {
  const { root, git } = gitFixture(t, 'audit-checkpoint-');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n.issues/\n');
  writeFileSync(join(root, '.prettierignore'), '');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: false\n');
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
  writeFileSync(join(root, '.fallowrc.json'), '{"entry":["index.js","scripts/**/*.mjs"]}\n');
  mkdirSync(join(root, 'scripts'));
  for (const name of [
    'format-staged.mjs',
    'format-files.mjs',
    'verify.mjs',
    'verify-browser-evidence.mjs',
    'verify-scope.mjs',
    'verify-process.mjs',
    'verify-merge-checks.mjs',
    'verify-preflight.mjs',
    'audit-result.mjs',
  ])
    writeFileSync(join(root, 'scripts', name), readFileSync(join('scripts', name)));
  copySourceSeparation(root);
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
  assert.ok(auditSummary(root).checks[0].command.includes('--no-cache'));
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
  manifest.scripts['test:factory:smoke'] = 'node -e "console.log(\'factory smoke sentinel\')"';
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
  const run = (...args) => {
    const before = {
      head: git('rev-parse', 'HEAD'),
      index: git('diff', '--cached', '--binary'),
      source: git('diff', '--binary'),
      queue: readFileSync(queuePath, 'utf8'),
    };
    // Start a fresh public CLI invocation, rather than a nested node:test runner.
    const env = { ...process.env, GIT_INDEX_FILE: join(root, '.git/index') };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [resolve('scripts/verify.mjs'), '--base', base, ...args], {
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

function formatFixtureFile(root, path) {
  const result = spawnSync(resolve('node_modules/.bin/vp'), ['fmt', path], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('formatting handles changed symbolic links while still checking changed target source', (t) => {
  const { root, run } = aggregateFixture(t);
  symlinkSync('index.js', join(root, 'helper-link'));
  const { result, summary } = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(summary.changed_files.includes('helper-link'));
  const formatting = summary.checks.find((check) => check.name === 'format-changed');
  assert.equal(formatting.passed, true);
  assert.ok(formatting.command.includes('./index.js'));
  assert.equal(formatting.command.includes('./helper-link'), false);
});

test('aggregate verification dispatches the package factory suite in an isolated export', (t) => {
  const { root, run, interfacePath, interfaceCheck } = aggregateFixture(t);
  writeFileSync(interfacePath, interfaceCheck + 'throw Error("deliberate interface failure");\n');
  formatFixtureFile(root, 'scripts/factory-interface.check.mjs');
  const failed = run();
  assert.equal(failed.result.status, 1, failed.result.stdout + failed.result.stderr);
  assert.equal(failed.factory.passed, false, readFileSync(failed.factory.log, 'utf8'));
  assert.match(readFileSync(failed.factory.log, 'utf8'), /deliberate interface failure/);
  assert.deepEqual(
    failed.summary.checks.map((check) => check.name),
    ['format-changed', 'fallow', 'browser', 'factory', 'typecheck', 'tests', 'build']
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

test('Merge runs the focused command, common checks, and selected Factory suite', (t) => {
  const { run } = aggregateFixture(t);
  const focused = ['node', '--test', 'scripts/factory-interface.check.mjs'];
  for (const scope of ['default', 'full']) {
    const plan = { scope, focusedRecorded: true, focused: [focused] };
    const { result, summary, factory } = run('--merge-checks', JSON.stringify(plan));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(summary.mergeChecks, plan);
    assert.deepEqual(
      summary.checks.map(({ name }) => name),
      ['format-changed', 'fallow', 'focused-1', 'browser', 'factory', 'typecheck', 'tests', 'build']
    );
    const focusedResult = summary.checks.find(({ name }) => name === 'focused-1');
    assert.deepEqual(focusedResult.command, focused);
    assert.match(readFileSync(focusedResult.log, 'utf8'), /interface dispatch sentinel/);
    const sentinel = scope === 'default' ? /factory smoke sentinel/ : /interface dispatch sentinel/;
    assert.match(readFileSync(factory.log, 'utf8'), sentinel);
  }
});

test('Verify stops before Fallow and tests on an unformatted change', (t) => {
  const { root, run } = aggregateFixture(t);
  writeFileSync(join(root, 'index.js'), 'console.log(   "unformatted"   );\n');
  const { result, summary } = run();
  assert.equal(result.status, 1);
  assert.deepEqual(
    summary.checks.map(({ name, passed }) => [name, passed]),
    [['format-changed', false]]
  );
});

test('Verify stops before test suites on an introduced Fallow failure', (t) => {
  const { root } = aggregateFixture(t);
  writeFileSync(join(root, 'new-dead.js'), 'export const orphan = 1;\n');
  const result = spawnSync(process.execPath, [resolve('scripts/verify.mjs'), '--base', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TIMEY_FALLOW_ENFORCE: '1', TIMEY_FALLOW_WARNINGS: 'error' },
  });
  const summary = auditSummary(root);
  assert.equal(result.status, 1);
  assert.deepEqual(
    summary.checks.map(({ name, passed }) => [name, passed]),
    [
      ['format-changed', true],
      ['fallow', false],
    ]
  );
});

test('Work formats issue files and checks Fallow without starting a test suite', (t) => {
  const { root } = aggregateFixture(t);
  const path = join(root, 'index.js');
  const source = 'console.log(  "work change"  );\n';
  writeFileSync(path, source);
  const result = spawnSync(
    process.execPath,
    [resolve('scripts/verify.mjs'), '--work-checks', '--write-format', '--base', 'HEAD'],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.notEqual(readFileSync(path, 'utf8'), source);
  assert.deepEqual(
    auditSummary(root).checks.map(({ name }) => name),
    ['format-changed', 'fallow']
  );
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
  formatFixtureFile(root, 'package.json');
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

test('verification forwards stdout and stderr before the child finishes and retains its log', async (t) => {
  const { spawn } = await import('node:child_process');
  const { root } = gitFixture(t, 'verify-live-output-');
  const release = join(root, 'release');
  const log = join(root, 'command.log');
  const runner = join(root, 'runner.mjs');
  const modulePath = new URL('./verify-process.mjs', import.meta.url).href;
  writeFileSync(
    runner,
    `
    import { runVerificationProcess } from ${JSON.stringify(modulePath)};
    const result = await runVerificationProcess(process.execPath, ['-e', ${JSON.stringify(`
      const fs = require('node:fs');
      process.stdout.write('live stdout marker\\n');
      process.stderr.write('live stderr marker\\n');
      const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); } }, 10);
    `)}], { cwd: ${JSON.stringify(root)}, streamOutput: true }, ${JSON.stringify(log)});
    process.exitCode = result.status ?? 1;
  `
  );
  const child = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const output = { stdout: '', stderr: '' };
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('No live output arrived before child completion')), 3000);
      for (const channel of ['stdout', 'stderr'])
        child[channel].on('data', (chunk) => {
          output[channel] += chunk;
          if (output.stdout.includes('live stdout marker') && output.stderr.includes('live stderr marker')) resolve();
        });
      child.once('error', reject);
    });
    assert.equal(child.exitCode, null, 'output must be visible while the command is still running');
    assert.match(readFileSync(log, 'utf8'), /live stdout marker/);
    assert.match(readFileSync(log, 'utf8'), /live stderr marker/);
  } finally {
    clearTimeout(timer);
    writeFileSync(release, 'finish');
    await closed;
  }
  assert.equal(child.exitCode, 0);
});
