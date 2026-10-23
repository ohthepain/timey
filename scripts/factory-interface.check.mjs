import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitFixture } from './git-fixture.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(source, 'scripts/factory.mjs');

function fixture(t) {
  const { root: temporaryRoot, git } = gitFixture(t, 'factory-interface-');
  const root = realpathSync(temporaryRoot);
  writeFileSync(join(root, '.gitignore'), '.issues/\n');
  git('add', '.gitignore');
  git('commit', '-qm', 'fixture');
  mkdirSync(join(root, '.issues'));
  const roles = [
    'ready-for-grilling',
    'ready-for-repro',
    'ready-to-fix',
    'ready-to-verify',
    'ready-for-commit',
    'ready-to-close',
    'closed',
  ];
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next state |\n| --- | --- | --- |\n' +
      roles.map((role, i) => `| ${role} | ${role} | ${roles[i + 1] ?? '—'} |`).join('\n')
  );
  writeFileSync(join(root, '.issues/preferences.json'), '{"commit":false}\n');
  for (const suffix of ['abc1', 'abc2', 'def1']) {
    const id = `20261023T120000000-${suffix}`;
    writeFileSync(
      join(root, `.issues/${id}.md`),
      `---\nid: ${id}\ntitle: Fixture ${suffix}\nstate: ready-to-fix\ncreated: "2026-10-23T12:00:00.000Z"\nupdated: "2026-10-23T12:00:00.000Z"\ngrill_later: false\n---\nOriginal request\n`
    );
  }
  const run = (...args) =>
    execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const queueBytes = () =>
    readdirSync(join(root, '.issues'))
      .sort()
      .map((name) => [name, readFileSync(join(root, '.issues', name), 'utf8')]);
  return { root, run, queueBytes };
}

test('queue-wide and targeted decisions preserve queue bytes and existing worker context', (t) => {
  const { root, run, queueBytes } = fixture(t);
  writeFileSync(
    join(root, '.issues/factory.json'),
    JSON.stringify({
      version: 1,
      actions: [{ id: 'existing', issues: ['20261023T120000000-abc1'], status: 'running' }],
    })
  );
  const before = queueBytes();
  const all = JSON.parse(run());
  assert.equal(all.mode, 'decide');
  assert.equal(all.focus_issue_ids.length, 3);
  const selected = JSON.parse(run('20261023T120000000-abc1', '20261023T120000000-d', '20261023T120000000-abc1'));
  assert.deepEqual(selected.focus_issue_ids, ['20261023T120000000-abc1', '20261023T120000000-def1']);
  assert.equal(selected.reports.length, 3);
  assert.equal(selected.registry.actions[0].status, 'running');
  assert.deepEqual(queueBytes(), before);
});

test('ambiguous, missing and duplicate report IDs fail selection without writes', (t) => {
  const { root, run, queueBytes } = fixture(t);
  const before = queueBytes();
  assert.throws(
    () => run('20261023T120000000-a'),
    (error) => /Ambiguous issue.*abc1.*abc2/s.test(error.stderr)
  );
  assert.throws(
    () => run('missing'),
    (error) => /Unknown issue/.test(error.stderr)
  );
  assert.deepEqual(queueBytes(), before);
  writeFileSync(
    join(root, '.issues/20261023-duplicate.md'),
    readFileSync(join(root, '.issues/20261023T120000000-abc1.md'))
  );
  assert.throws(
    () => run('20261023T120000000-abc1'),
    (error) => /Ambiguous issue/.test(error.stderr)
  );
});

test('issues delegates to the installed helper without a registry or coordinator metadata parsing', (t) => {
  const { root, run, queueBytes } = fixture(t);
  mkdirSync(join(root, '.agents/skills'), { recursive: true });
  symlinkSync(join(source, '.agents/skills/issues'), join(root, '.agents/skills/issues'));
  // The listing can diagnose reports that would fail the coordinator's human_checks parser.
  const path = join(root, '.issues/20261023T120000000-abc1.md');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace('grill_later: false', 'human_checks: invalid\ngrill_later: false')
  );
  const before = queueBytes();
  const output = join(root, 'listing.html');
  const result = JSON.parse(run('issues', '--output', output, '--state', 'ready-to-fix', '--sort', 'title'));
  assert.equal(result.project_root, root);
  assert.equal(result.total, 3);
  assert.match(readFileSync(output, 'utf8'), /Fixture abc1/);
  assert.deepEqual(queueBytes(), before);
  const direct = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(root, '.agents/skills/issues/scripts/list-issues.mjs'),
        '--project',
        root,
        '--output',
        join(root, 'direct.html'),
        '--state',
        'ready-to-fix',
        '--sort',
        'title',
      ],
      { encoding: 'utf8' }
    )
  );
  assert.deepEqual({ ...result, path: null }, { ...direct, path: null });
});

test('missing listing helper and chat-only operations fail without queue changes', (t) => {
  const { run, queueBytes } = fixture(t);
  const before = queueBytes();
  assert.throws(
    () => run('issues', '--output', '/tmp/unused-factory-list.html'),
    (error) => /listing helper missing/.test(error.stderr)
  );
  for (const command of ['human', 'launch', 'both', 'integrate']) {
    assert.throws(
      () => run(command, 'example'),
      (error) => /in chat/.test(error.stderr)
    );
  }
  assert.deepEqual(queueBytes(), before);
});
