import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';

const runner = fileURLToPath(new URL('./pr-repair-tests.mjs', import.meta.url));
function plan(root, tests) {
  mkdirSync(join(root, '.github'), { recursive: true });
  writeFileSync(join(root, '.github/pr-repair-tests.json'), JSON.stringify({ version: 1, tests }));
}
const command = (name) => ({ name, command: ['node', '--test', name + '.check.mjs'] });

void test('PR repair checks name the failed case and stop before later tests', (t) => {
  const { root } = gitFixture(t, 'pr-repair-first-');
  writeFileSync(join(root, 'broken.check.mjs'), "throw Error('Exact broken assertion');\n");
  writeFileSync(
    join(root, 'later.check.mjs'),
    "import {writeFileSync} from 'node:fs'; writeFileSync('later-ran', 'yes');\n"
  );
  plan(root, [command('broken'), command('later')]);
  const result = spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /FAIL PR repair: broken/);
  assert.equal(existsSync(join(root, 'later-ran')), false);
});

void test('PR repair plans apply throughout their PR and stop applying after joining its base', (t) => {
  const { root, git } = gitFixture(t, 'pr-repair-base-');
  writeFileSync(
    join(root, 'fixed.check.mjs'),
    "import {writeFileSync} from 'node:fs'; writeFileSync('fixed-ran', 'yes');\n"
  );
  plan(root, [command('fixed')]);
  git('add', '.');
  git('commit', '-qm', 'Original repair plan');
  const base = git('rev-parse', 'HEAD');
  let result = spawnSync(process.execPath, [runner, '--base', base], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, 'fixed-ran')), false);
  plan(root, [{ ...command('fixed'), name: 'Fixed regression' }]);
  git('add', '.github/pr-repair-tests.json');
  git('commit', '-qm', 'Repair plan for this PR');
  result = spawnSync(process.execPath, [runner, '--base', base], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS PR repair: Fixed regression/);
  assert.equal(existsSync(join(root, 'fixed-ran')), true);
});

void test('a PR repair plan cannot select an aggregate suite as a focused regression', (t) => {
  const { root } = gitFixture(t, 'pr-repair-focus-');
  plan(root, [{ name: 'Broad suite', command: ['pnpm', 'run', 'test:browser'] }]);
  const result = spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Record focused test commands/);
});
