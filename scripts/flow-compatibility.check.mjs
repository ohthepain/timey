import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { compatibilityChecks, runMergeCompatibility } from './factory-ui/flow-compatibility.mjs';
import { executeCommand } from './factory-ui/flow-executor.mjs';
import { gitFixture } from './git-fixture.mjs';

const directory = '.github/pr-repair-tests';
const manifest = directory + '/factory-deploy-startup.json';
const cases = ['deployment replaces the listener', 'deployment records recovery'];
const record = {
  ...JSON.parse(readFileSync(new URL('../' + manifest, import.meta.url), 'utf8')),
  name: 'Grouped fixture display name',
  command: ['node', '--test', '--test-name-pattern=^(?:' + cases.join('|') + ')$', 'scripts/factory-deploy.check.mjs'],
};

function commit(fixture, path, contents) {
  const destination = join(fixture.root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
  fixture.git('add', path);
  fixture.git('commit', '-qm', 'Change ' + path);
  return fixture.git('rev-parse', 'HEAD');
}

function preflight(fixture, originalHead, target, execute) {
  const head = fixture.git('rev-parse', 'HEAD');
  return runMergeCompatibility(
    { signal: new AbortController().signal, onProgress() {} },
    { checkout: fixture.root },
    join(fixture.root, 'proof'),
    originalHead,
    { head, target },
    execute
  );
}

test('repair manifests and dependencies select checks from both sides of a combined candidate', async (t) => {
  for (const side of ['issue', 'target']) {
    for (const change of ['add manifest', 'edit manifest', 'dependency', 'unrelated']) {
      await t.test(side + ' changes ' + change, async (subtest) => {
        const fixture = gitFixture(subtest, 'timey-merge-repair-');
        let base = commit(fixture, 'README.md', 'base\n');
        if (change !== 'add manifest') base = commit(fixture, manifest, JSON.stringify(record));
        fixture.git('switch', '-qc', side);
        const updatedRecord = { ...record, name: 'Changed grouped fixture display name' };
        const path = {
          'add manifest': manifest,
          'edit manifest': manifest,
          dependency: 'scripts/factory-deploy.check.mjs',
          unrelated: 'README.md',
        }[change];
        const editsManifest = path === manifest;
        const changed = commit(fixture, path, editsManifest ? JSON.stringify(updatedRecord) : 'modified\n');
        const otherSide = side === 'issue' ? 'target' : 'issue';
        fixture.git('switch', '-C', otherSide, base);
        const other = commit(fixture, 'independent.txt', 'Independent change\n');
        fixture.git('merge', '--no-edit', changed);
        const originalHead = side === 'issue' ? changed : other;
        const target = side === 'target' ? changed : other;
        const head = fixture.git('rev-parse', 'HEAD');
        const selected = compatibilityChecks(fixture.root, originalHead, { head, target });
        assert.deepEqual(
          selected.map(({ command }) => command),
          change === 'unrelated' ? [] : [record.command]
        );
        const actual = [];
        const evidence = await preflight(fixture, originalHead, target, ({ command, args, log }) => {
          actual.push([command, ...args]);
          writeFileSync(log, cases.map((name, index) => 'ok ' + (index + 1) + ' - ' + name).join('\n'));
          return Promise.resolve();
        });
        assert.deepEqual(actual, change === 'unrelated' ? [] : [record.command]);
        if (change === 'unrelated') return assert.deepEqual(evidence, []);
        const report = JSON.parse(readFileSync(evidence.at(-1).path, 'utf8'));
        assert.equal(report.candidate.head, fixture.git('rev-parse', 'HEAD'));
        assert.equal(report.target, target);
        assert.deepEqual(
          report.checks.map(({ name, passed }) => [name, passed]),
          [[editsManifest ? updatedRecord.name : record.name, true]]
        );
      });
    }
  }
});

test('grouped repair verifies the individual Node cases reported by the saved command', async (t) => {
  for (const outcome of ['passes', 'missing', 'fails', 'skipped', 'todo']) {
    await t.test(outcome, async (subtest) => {
      const fixture = gitFixture(subtest, 'timey-merge-node-');
      const base = commit(fixture, 'README.md', 'base\n');
      commit(fixture, manifest, JSON.stringify(record));
      const body = {
        passes: '() => {}',
        fails: '() => { throw Error("expected failure"); }',
        skipped: '{ skip: true }, () => {}',
        todo: '{ todo: true }, () => {}',
      }[outcome];
      const source =
        'import { test } from "node:test";\n' +
        'test(' +
        JSON.stringify(cases[0]) +
        ', () => {});\n' +
        (body ? 'test(' + JSON.stringify(cases[1]) + ', ' + body + ');\n' : '');
      const head = commit(fixture, record.command.at(-1), source);
      const actual = preflight(fixture, head, base, executeCommand);
      if (outcome === 'passes') {
        const evidence = await actual;
        const report = JSON.parse(readFileSync(evidence.at(-1).path, 'utf8'));
        assert.equal(report.checks[0].passed, true);
        assert.doesNotMatch(readFileSync(report.checks[0].log, 'utf8'), /Grouped fixture display name/);
      } else {
        await assert.rejects(actual, /Failed compatibility check Grouped fixture display name/);
      }
    });
  }
});
