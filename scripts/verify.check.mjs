import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitFixture } from './git-fixture.mjs';

test('staged audit sees the index even when unstaged changes hide an unused file', (t) => {
  const { root, git } = auditFixture(t);
  writeFileSync(join(root, 'extra.js'), 'export const extra = 42;\n');
  git('add', 'extra.js');
  writeFileSync(join(root, 'index.js'), 'import { extra } from "./extra.js";\nconsole.log(extra);\n');
  const before = git('diff', '--binary', 'HEAD');
  const script = resolve('scripts/verify.mjs');
  const staged = spawnSync(process.execPath, [script, '--staged', '--audit-only'], { cwd: root, encoding: 'utf8' });
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
  writeFileSync(join(root, 'package-lock.json'), readFileSync('package-lock.json'));
  writeFileSync(join(root, '.fallowrc.json'), '{"entry":["index.js","scripts/*.mjs"]}\n');
  mkdirSync(join(root, 'scripts'));
  for (const name of ['verify.mjs', 'verify-process.mjs', 'audit-result.mjs'])
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
    });
  return { root, git, run };
}

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
  return { run, interfacePath, interfaceCheck };
}

test('aggregate verification dispatches the package factory suite in an isolated export', (t) => {
  const { run, interfacePath, interfaceCheck } = aggregateFixture(t);
  writeFileSync(interfacePath, interfaceCheck + 'throw Error("deliberate interface failure");\n');
  const failed = run();
  assert.equal(failed.result.status, 1, failed.result.stdout + failed.result.stderr);
  assert.equal(failed.factory.passed, false, readFileSync(failed.factory.log, 'utf8'));
  assert.match(readFileSync(failed.factory.log, 'utf8'), /deliberate interface failure/);
  assert.deepEqual(
    failed.summary.checks.map((check) => check.name),
    ['fallow', 'format-changed', 'factory', 'typecheck', 'tests', 'build']
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

test('step and commit audits reject inherited findings anywhere in changed files', (t) => {
  const { root, git, run } = auditFixture(t, { 'unused.js': 'export const unused = 1;\n' });
  // This dead file already existed in the baseline. A new-only gate waived it.
  writeFileSync(join(root, 'unused.js'), 'export const unused = 2;\n');
  git('add', '.');
  for (const args of [['--step', '--base', 'HEAD'], ['--staged']]) {
    const result = run(...args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /FAIL fallow/);
  }
  writeFileSync(join(root, 'index.js'), 'import { unused } from "./unused.js";\nconsole.log(unused);\n');
  const fixed = run('--step', '--base', 'HEAD');
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
});

test('real pre-commit hook isolates Git environment and preserves the source index on failure', (t) => {
  const { root, git } = auditFixture(t);
  git('config', 'core.hooksPath', resolve('.githooks'));
  writeFileSync(join(root, 'unused.js'), 'export const unused = 1;\n');
  git('add', '.');
  const beforeHead = git('rev-parse', 'HEAD');
  const beforeEntries = git('ls-files', '--stage');
  const beforeDiff = git('diff', '--cached', '--binary');
  const commit = () =>
    spawnSync('git', ['commit', '-qm', 'hook probe'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_INDEX_FILE: join(root, '.git/index') },
    });
  const failed = commit();
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /FAIL fallow/);
  assert.equal(git('rev-parse', 'HEAD'), beforeHead);
  assert.equal(git('ls-files', '--stage'), beforeEntries);
  assert.equal(git('diff', '--cached', '--binary'), beforeDiff);
  writeFileSync(join(root, 'index.js'), 'import { unused } from "./unused.js";\nconsole.log(unused);\n');
  git('add', '.');
  const passed = commit();
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.notEqual(git('rev-parse', 'HEAD'), beforeHead);
});

test('a real zero-exit Fallow warning blocks the step checkpoint', (t) => {
  const { root, run } = auditFixture(t);
  const file = join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.scripts.outside = 'open /tmp/issues.html';
  writeFileSync(file, JSON.stringify(manifest));
  const result = run('--step', '--base', 'HEAD');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const evidence = join(root, '.issues/evidence');
  const summary = readdirSync(evidence).find((name) => name.endsWith('-summary.json'));
  const check = JSON.parse(readFileSync(join(evidence, summary), 'utf8')).checks[0];
  assert.equal(check.exit, 0);
  assert.equal(check.passed, false);
  assert.ok(check.reasons.some((reason) => reason.includes('warning')));
});
