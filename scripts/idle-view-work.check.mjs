import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gitFixture } from './git-fixture.mjs';
import { FlowStore, newFlow } from './factory-ui/flow-store.mjs';
import { projectIssueRecords, projectHomeStats } from './factory-ui/project-home-stats.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { registerEvidenceResolver } from './factory-ui/stores/evidence.mjs';

function reads(t, path) {
  const original = fs.readFileSync;
  let count = 0;
  fs.readFileSync = (...args) => {
    if (String(args[0]) === path) count++;
    return original(...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  });
  return () => count;
}

function flowFixture(t) {
  const { root } = gitFixture(t, 'idle-flow-');
  const issue = { id: '20261123-flow', title: 'Feature', content: '' };
  const store = new FlowStore(root);
  const flow = newFlow(issue, { remote: 'origin', branch: 'dev', base: null });
  const saved = store.save(flow, 0);
  return { root, issue, store, path: store.path(issue.id), saved };
}

test('unchanged Flow reads reuse parsed bytes and isolate mutable callers', (t) => {
  const f = flowFixture(t);
  const count = reads(t, f.path);
  const first = f.store.read(f.issue);
  first.blocks[0].data.wording = 'Changed by caller';
  const second = f.store.read(f.issue);
  assert.equal(second.blocks[0].data.wording, f.saved.blocks[0].data.wording);
  assert.equal(count(), 1, 'An unchanged flow file is read and parsed once.');
});

test('Flow reads observe same-size edits with restored mtime, replacement, deletion and staged progress', (t) => {
  const f = flowFixture(t);
  f.store.read(f.issue);
  const initial = fs.statSync(f.path);
  const changed = { ...f.saved, revision: 2 };
  const body = JSON.stringify(changed, null, 2) + '\n';
  assert.equal(body.length, fs.readFileSync(f.path, 'utf8').length);
  fs.writeFileSync(f.path, body);
  fs.utimesSync(f.path, initial.atime, initial.mtime);
  assert.equal(f.store.read(f.issue).revision, 2);
  const replacement = f.path + '.replacement';
  fs.writeFileSync(replacement, JSON.stringify({ ...changed, revision: 3 }));
  fs.renameSync(replacement, f.path);
  assert.equal(f.store.read(f.issue).revision, 3);
  fs.writeFileSync(f.path, '{invalid');
  assert.throws(() => f.store.read(f.issue), SyntaxError);
  fs.unlinkSync(f.path);
  assert.equal(f.store.read(f.issue).revision, 0);
  f.store.staged.set(f.issue.id, { flow: { ...changed, revision: 7 }, generation: 1 });
  const pending = f.store.read(f.issue);
  pending.revision = 8;
  assert.equal(f.store.read(f.issue).revision, 7);
});

function reportFixture(t) {
  const { root } = gitFixture(t, 'idle-reports-');
  const path = join(root, '.issues', '20261123-report.md');
  fs.mkdirSync(join(root, '.issues'));
  fs.writeFileSync(
    path,
    '---\nid: 20261123-report\ntitle: Alpha\nstate: backlog\ncreated: 2026-11-23T10:00:00Z\nlabels: [one]\n---\nWords.\n'
  );
  return { root, path };
}

test('unchanged Home reports reuse content and metadata without sharing caller mutations', (t) => {
  const f = reportFixture(t);
  const count = reads(t, f.path);
  const first = projectIssueRecords(f.root);
  first[0].labels.push('mutated');
  const second = projectIssueRecords(f.root);
  assert.deepEqual(second[0].labels, ['one']);
  assert.equal(projectHomeStats(f.root, new Date('2026-11-23T12:00:00Z')).created, 1);
  assert.equal(count(), 1, 'Unchanged Home inputs are read and parsed once.');
});

test('Home reports observe edits, moves, deletion and another project', (t) => {
  const f = reportFixture(t);
  projectIssueRecords(f.root);
  const initial = fs.statSync(f.path);
  const body = fs.readFileSync(f.path, 'utf8').replace('Alpha', 'Bravo');
  fs.writeFileSync(f.path, body);
  fs.utimesSync(f.path, initial.atime, initial.mtime);
  assert.equal(projectIssueRecords(f.root)[0].title, 'Bravo');
  const closed = join(f.root, '.issues/closed');
  fs.mkdirSync(closed);
  fs.renameSync(f.path, join(closed, '20261123-report.md'));
  assert.equal(projectIssueRecords(f.root)[0].location, 'closed');
  const other = reportFixture(t);
  assert.equal(projectIssueRecords(other.root)[0].title, 'Alpha');
  fs.unlinkSync(join(closed, '20261123-report.md'));
  assert.deepEqual(projectIssueRecords(f.root), []);
});

function artifactsFixture(t) {
  const { root } = gitFixture(t, 'idle-artifacts-');
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
  const path = join(root, '.issues', 'proof.txt');
  fs.mkdirSync(join(root, '.issues'), { recursive: true });
  fs.writeFileSync(path, 'Verified evidence.\n');
  const sha256 = createHash('sha256').update(fs.readFileSync(path)).digest('hex');
  const flow = {
    issueId: '20261123-artifacts',
    blocks: [{ id: 'work', label: 'Work', attempts: [{ id: 'one', evidence: [{ path, sha256 }] }] }],
  };
  return { root, flows, path, sha256, flow };
}

test('unchanged artifact display reuses verified bytes while fresh calls still validate', (t) => {
  const f = artifactsFixture(t);
  const count = reads(t, f.path);
  const first = f.flows.artifacts(f.flow, { fresh: false });
  assert.equal(first.length, 1);
  const afterFirst = count();
  first[0].label = 'Caller mutation';
  assert.equal(f.flows.artifacts(f.flow, { fresh: false })[0].label, 'Work evidence');
  assert.equal(count(), afterFirst, 'Unchanged display polling does not rehash evidence bodies.');
  assert.equal(f.flows.artifacts(f.flow).length, 1);
  assert.ok(count() > afterFirst, 'Action lookup performs fresh integrity validation.');
});

test('artifact display rejects changed bytes and symbolic links', async (t) => {
  const f = artifactsFixture(t);
  assert.equal(f.flows.artifacts(f.flow, { fresh: false }).length, 1);
  const initial = fs.statSync(f.path);
  fs.writeFileSync(f.path, 'Tampered evidence.\n');
  fs.utimesSync(f.path, initial.atime, initial.mtime);
  assert.deepEqual(f.flows.artifacts(f.flow, { fresh: false }), []);
  fs.writeFileSync(f.path, 'Verified evidence.\n');
  assert.equal(f.flows.artifacts(f.flow, { fresh: false }).length, 1);
  const actual = f.path + '.actual';
  fs.renameSync(f.path, actual);
  fs.symlinkSync(actual, f.path);
  assert.deepEqual(f.flows.artifacts(f.flow, { fresh: false }), []);
  await assert.rejects(
    () => f.flows.deleteArtifact(f.flow, { id: f.flow.issueId }, { artifactId: 'missing', confirmed: true }),
    /Confirm deletion/
  );
});

test('artifact display invalidates when the evidence resolver changes without changing the old file', (t) => {
  const f = artifactsFixture(t);
  const resolver = { manifest: { originId: 'test' }, knows: () => true, resolve: () => f.path };
  const unregister = registerEvidenceResolver(f.root, resolver);
  t.after(unregister);
  assert.equal(f.flows.artifacts(f.flow, { fresh: false }).length, 1);
  const gap = {
    manifest: { originId: 'test' },
    knows: () => true,
    resolve: () => {
      throw Error('Retained evidence unavailable.');
    },
  };
  const removeGap = registerEvidenceResolver(f.root, gap);
  assert.deepEqual(f.flows.artifacts(f.flow, { fresh: false }), []);
  removeGap();
  assert.equal(f.flows.artifacts(f.flow, { fresh: false }).length, 1);
});

test('artifact display rejects a parent link retargeted outside the project with unchanged file identity', (t) => {
  const f = artifactsFixture(t);
  const inside = join(f.root, 'inside');
  const outside = join(f.root, '..', 'outside-' + f.flow.issueId + '-' + Date.now());
  fs.mkdirSync(inside);
  fs.mkdirSync(outside);
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.renameSync(f.path, join(inside, 'proof.txt'));
  fs.linkSync(join(inside, 'proof.txt'), join(outside, 'proof.txt'));
  const link = join(f.root, 'proof-link');
  fs.symlinkSync(inside, link);
  f.flow.blocks[0].attempts[0].evidence[0].path = join(link, 'proof.txt');
  assert.equal(f.flows.artifacts(f.flow, { fresh: false }).length, 1);
  fs.unlinkSync(link);
  fs.symlinkSync(outside, link);
  assert.deepEqual(f.flows.artifacts(f.flow, { fresh: false }), []);
});

test('file generation cache evicts bounded entries and bypasses oversized values', async (t) => {
  const { FileReadCache } = await import('./factory-ui/file-read-cache.mjs');
  const { root } = gitFixture(t, 'idle-bound-');
  let parses = 0;
  const cache = new FileReadCache((body) => {
    parses++;
    return body;
  }, 12);
  const first = join(root, 'first.txt');
  const second = join(root, 'second.txt');
  const large = join(root, 'large.txt');
  fs.writeFileSync(first, '12345678');
  fs.writeFileSync(second, 'abcdefgh');
  fs.writeFileSync(large, 'Too large to retain.');
  assert.equal(cache.read(first), '12345678');
  assert.equal(cache.read(second), 'abcdefgh');
  assert.equal(cache.read(first), '12345678');
  assert.equal(parses, 3);
  cache.read(large);
  cache.read(large);
  assert.equal(parses, 5);
  cache.retain([]);
  cache.read(first);
  assert.equal(parses, 6);
});

test('artifact display never caches a generation changed after its verified bytes were read', (t) => {
  const f = artifactsFixture(t);
  const original = fs.readFileSync;
  let changed = false;
  fs.readFileSync = (...args) => {
    const result = original(...args);
    if (String(args[0]) === f.path && !changed) {
      changed = true;
      fs.writeFileSync(f.path, 'Tampered evidence.\n');
    }
    return result;
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  });
  assert.deepEqual(f.flows.artifacts(f.flow, { fresh: false }), []);
  assert.equal(changed, true);
  assert.deepEqual(f.flows.artifacts(f.flow, { fresh: false }), []);
  assert.deepEqual(f.flows.artifacts(f.flow), []);
});
