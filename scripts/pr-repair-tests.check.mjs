import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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

void test('concurrent PR repair checks retain independent source snapshots and replay commands', (t) => {
  const { root, git } = gitFixture(t, 'pr-repair-concurrent-');
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/flow-browser.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  git('add', '.');
  git('commit', '-qm', 'Fixture browser records replay arguments');
  const base = git('rev-parse', 'HEAD');
  const paths = ['activity-indicators', 'folder-workspace'].map((name) => '.github/pr-repair-tests/' + name + '.json');
  paths.forEach((path, index) => {
    git('switch', '-qc', 'repair-' + index, base);
    mkdirSync(join(root, '.github/pr-repair-tests'), { recursive: true });
    writeFileSync(join(root, path), readFileSync(new URL('../' + path, import.meta.url)));
    git('add', path);
    git('commit', '-qm', 'Record independent repair');
  });
  git('merge', '--no-edit', 'repair-0');
  const records = paths.map((path) => JSON.parse(git('show', 'HEAD:' + path)));
  assert.deepEqual(
    records.map(({ source: { runId, jobId } }) => [runId, jobId]),
    [
      ['45818424513', '139907129555'],
      ['45870933190', '140089737384'],
    ]
  );
  assert.ok(records[0].command.includes('--ai-text'));
  assert.ok(records[0].command.indexOf('--ai-text') < records[0].command.indexOf('--activity-indicators'));
  const result = spawnSync(process.execPath, [runner, '--base', base], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const { name, command, source } of records) {
    assert.ok(result.stdout.includes('PASS PR repair: ' + name), result.stdout);
    assert.ok(result.stdout.includes(JSON.stringify(command.slice(2))), result.stdout);
    assert.ok(result.stdout.includes(`checkout ${source.checkout}, tree ${source.tree}`), result.stdout);
  }
  t.diagnostic(JSON.stringify(records));
});
