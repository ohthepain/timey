import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gitFixture } from './git-fixture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { registerEvidenceResolver } from './factory-ui/stores/evidence.mjs';

function fixture(t, count) {
  const { root } = gitFixture(t, 'artifact-working-set-');
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    store: { runs: [], connected: new Set() },
    issueChats: { active: new Map() },
    ownServer() {},
  };
  const flows = createIssueFlows(service, { executor: { close() {} }, observer: { observe: async () => ({}) } });
  t.after(() => flows.close());
  const directory = join(root, '.issues', 'proof');
  fs.mkdirSync(directory, { recursive: true });
  const body = 'Verified evidence.\n';
  const sha256 = createHash('sha256').update(body).digest('hex');
  const evidence = Array.from({ length: count }, (_, index) => {
    const path = join(directory, `${index}.txt`);
    fs.writeFileSync(path, body);
    return { path, sha256 };
  });
  const flow = {
    issueId: '20261123-proof',
    blocks: [{ id: 'work', label: 'Work', attempts: [{ id: 'one', evidence }] }],
  };
  return { root, flows, evidence, flow };
}

function countReads(t, directory) {
  const read = fs.readFileSync;
  let count = 0;
  fs.readFileSync = (...args) => {
    if (String(args[0]).startsWith(directory)) count++;
    return read(...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = read;
    syncBuiltinESMExports();
  });
  return () => count;
}

test('artifact display retains a realistic working set above 512 entries without rereading bodies', (t) => {
  const f = fixture(t, 3000);
  const reads = countReads(t, join(f.root, '.issues', 'proof'));
  const first = f.flows.artifacts(f.flow, { fresh: false });
  assert.equal(first.length, 3000);
  assert.equal(reads(), 3000);
  const second = f.flows.artifacts(f.flow, { fresh: false });
  assert.deepEqual(second, first);
  assert.equal(reads(), 3000, 'A warm realistic artifact working set must not rehash its bodies.');
  assert.equal(f.flows.artifacts(f.flow).length, 3000);
  assert.equal(reads(), 6000, 'Action lookup still validates every artifact afresh.');
});

test('artifact metadata retention remains bounded when reference names exceed its byte budget', (t) => {
  const f = fixture(t, 1);
  const path = f.evidence[0].path;
  const references = Array.from({ length: 20 }, (_, index) => ({
    path: `${index}-` + 'x'.repeat(2 * 1024 * 1024),
    sha256: f.evidence[0].sha256,
  }));
  const unregister = registerEvidenceResolver(f.root, {
    manifest: { originId: 'large-reference-fixture' },
    knows: () => true,
    resolve: () => path,
  });
  t.after(unregister);
  f.flow.blocks[0].attempts[0].evidence = references;
  const reads = countReads(t, path);
  assert.equal(f.flows.artifacts(f.flow, { fresh: false }).length, 20);
  const before = reads();
  f.flow.blocks[0].attempts[0].evidence = references.slice(0, 1);
  assert.equal(f.flows.artifacts(f.flow, { fresh: false }).length, 1);
  assert.ok(reads() > before, 'Old metadata is evicted when retained references exceed the byte budget.');
  assert.ok(f.flows.artifactReadBytes <= 32 * 1024 * 1024);
});

test('a cache hit never rebases its verified generation after a concurrent file edit', (t) => {
  const f = fixture(t, 1);
  assert.equal(f.flows.artifacts(f.flow, { fresh: false }).length, 1);
  const path = f.evidence[0].path;
  const key = JSON.stringify([path, f.evidence[0].sha256]);
  const verifiedGeneration = f.flows.artifactReads.get(key).generation;
  const realpath = fs.realpathSync;
  let changed = false;
  fs.realpathSync = (...args) => {
    const result = realpath(...args);
    if (String(args[0]) === path && !changed) {
      changed = true;
      fs.writeFileSync(path, 'Tampered evidence.\n');
    }
    return result;
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.realpathSync = realpath;
    syncBuiltinESMExports();
  });
  f.flows.artifacts(f.flow, { fresh: false });
  assert.equal(changed, true);
  const cached = f.flows.artifactReads.get(key);
  if (cached) assert.equal(cached.generation, verifiedGeneration);
  assert.deepEqual(f.flows.artifacts(f.flow, { fresh: false }), []);
  assert.deepEqual(f.flows.artifacts(f.flow), []);
});
