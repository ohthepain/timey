import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, availableParallelism, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installSnapshot, readSnapshot } from './factory-ui/stores/snapshots.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const project = resolve(option('--project', process.cwd()));
const repository = fileURLToPath(new URL('../', import.meta.url));
const base = option('--base', '0bfa0b08');
const original = readSnapshot(project);
assert.ok(original?.issues.length, 'Choose a project with a confirmed display cache.');
const selected =
  original.issues.find((issue) => issue.id === option('--issue')) || original.issues.find((issue) => issue.flow);
assert.ok(selected?.flow, 'Choose an issue with a retained flow.');
const scratch = mkdtempSync(join(tmpdir(), 'timey-snapshot-benchmark-'));
try {
  const source = execFileSync('git', ['-C', repository, 'show', base + ':scripts/factory-ui/stores/snapshots.mjs'], {
    encoding: 'utf8',
  });
  const baselineSource = source.replace(
    /from '(\.\/[^']+)'/g,
    (_, specifier) => `from '${new URL(specifier, new URL('./factory-ui/stores/snapshots.mjs', import.meta.url)).href}'`
  );
  const baselinePath = join(scratch, 'baseline.mjs');
  writeFileSync(baselinePath, baselineSource);
  const before = await import(pathToFileURL(baselinePath));
  const roots = ['before', 'after'].map((name) => join(scratch, name));
  const body = JSON.stringify(original, null, 2);
  for (const root of roots) {
    mkdirSync(join(root, '.issues/store-runtime'), { recursive: true });
    writeFileSync(join(root, '.issues/store-runtime/snapshot.json'), body);
  }
  const measurements = [];
  for (let run = 0; run < 5; run++) {
    for (const index of run % 2 ? [1, 0] : [0, 1]) {
      const api = index ? { installSnapshot, readSnapshot } : before;
      const issue = structuredClone(selected);
      issue.flow.revision += run + 1;
      const input = {
        ...original,
        issues: [issue],
        issueIds: [issue.id],
        claims: [],
        commands: [],
        deletedIssueIds: [],
        capturedAt: new Date().toISOString(),
      };
      const start = performance.now();
      api.installSnapshot(roots[index], input);
      const result = api.readSnapshot(roots[index]);
      const ms = performance.now() - start;
      assert.equal(result.issues.length, original.issues.length);
      assert.deepEqual(
        result.issues.find((entry) => entry.id === issue.id),
        issue
      );
      assert.deepEqual(
        result.issues.filter((entry) => entry.id !== issue.id),
        original.issues.filter((entry) => entry.id !== issue.id)
      );
      measurements.push({
        run,
        version: index ? 'after' : 'before',
        ms,
        indexBytes: statSync(join(roots[index], '.issues/store-runtime/snapshot.json')).size,
      });
    }
  }
  const result = {
    cores: availableParallelism(),
    load: loadavg(),
    sourceBytes: Buffer.byteLength(body),
    errors: 0,
    measurements,
  };
  const output = option('--output');
  if (output) writeFileSync(resolve(output), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
