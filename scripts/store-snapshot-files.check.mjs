import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installSnapshot, readSnapshot } from './factory-ui/stores/snapshots.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'timey-snapshot-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const issue = (id, number) => ({
    id,
    number,
    report: `---\nid: ${id}\n---\nReport ${id}.\n`,
    location: 'open',
    flow: { issueId: id, revision: 1, blocks: [], text: 'retained'.repeat(1000) },
  });
  const snapshot = {
    version: 1,
    projectId: 'snapshot-files',
    capturedAt: 'first',
    issues: [issue('one', 1), issue('two', 2)],
    claims: [{ issueId: 'one' }, { issueId: 'two' }],
    commands: [{ issueId: 'one' }, { issueId: 'two' }],
    deletedIssueIds: [],
  };
  return { root, snapshot, path: join(root, '.issues/store-runtime/snapshot.json') };
}
const stored = (f) => JSON.parse(fs.readFileSync(f.path, 'utf8'));
const fragment = (f, ref) => join(f.root, '.issues/store-runtime/snapshot-issues', ref.id, ref.sha256 + '.json');
function selected(f) {
  const issue = structuredClone(readSnapshot(f.root).issues.find((i) => i.id === 'one'));
  issue.flow.revision++;
  return { ...f.snapshot, capturedAt: 'second', issues: [issue], issueIds: ['one'], claims: [], commands: [] };
}

test('legacy display cache converts once and selected updates retain unrelated fragment bytes and objects', (t) => {
  const f = fixture(t);
  fs.mkdirSync(join(f.root, '.issues/store-runtime'), { recursive: true });
  const legacy = JSON.stringify(f.snapshot, null, 2);
  fs.writeFileSync(f.path, legacy);
  assert.equal(readSnapshot(f.root).issues.length, 2);
  assert.equal(fs.readFileSync(f.path, 'utf8'), legacy);
  installSnapshot(f.root, selected(f));
  assert.equal(stored(f).version, 2);
  const prior = readSnapshot(f.root);
  const ref = stored(f).issues.find((i) => i.id === 'two');
  const before = fs.statSync(fragment(f, ref));
  const bytes = fs.readFileSync(fragment(f, ref));
  const update = selected(f);
  installSnapshot(f.root, update);
  const after = readSnapshot(f.root);
  assert.equal(after.version, 1);
  assert.equal(after.authoritative, false);
  assert.equal(after.issues.find((i) => i.id === 'one').flow.revision, 3);
  assert.equal(
    after.issues.find((i) => i.id === 'two'),
    prior.issues.find((i) => i.id === 'two')
  );
  assert.deepEqual(fs.readFileSync(fragment(f, ref)), bytes);
  assert.equal(fs.statSync(fragment(f, ref)).ino, before.ino);
  assert.ok(fs.statSync(f.path).size < 2000);
  assert.ok(Object.isFrozen(after.issues[0].flow));
  assert.deepEqual(after.claims, [{ issueId: 'two' }]);
  assert.deepEqual(after.commands, [{ issueId: 'two' }]);
  const moduleUrl = new URL('./factory-ui/stores/snapshots.mjs', import.meta.url).href;
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {readSnapshot} from ${JSON.stringify(moduleUrl)};const s=readSnapshot(${JSON.stringify(f.root)});console.log(JSON.stringify(s.issues.map(i=>[i.id,i.flow.revision])));`,
    ],
    { encoding: 'utf8' }
  );
  assert.deepEqual(JSON.parse(output), [
    ['one', 3],
    ['two', 1],
  ]);
  assert.equal(prior.issues.find((i) => i.id === 'one').flow.revision, 2);
});

test('display cache detects changed and missing fragments without returning a partial generation', (t) => {
  for (const damage of ['changed', 'missing']) {
    const f = fixture(t);
    installSnapshot(f.root, f.snapshot);
    readSnapshot(f.root);
    const path = fragment(f, stored(f).issues[0]);
    if (damage === 'changed') fs.writeFileSync(path, '{}');
    else fs.unlinkSync(path);
    assert.throws(() => readSnapshot(f.root), { code: 'STORE_INVALID_SNAPSHOT' });
  }
});

test('a failed manifest publication restores projections and the prior readable generation', (t) => {
  const f = fixture(t);
  installSnapshot(f.root, f.snapshot);
  const before = fs.readFileSync(f.path);
  const prior = readSnapshot(f.root);
  const update = selected(f);
  update.issues[0].report += 'changed';
  const rename = fs.renameSync;
  let fail = true;
  fs.renameSync = (source, destination) => {
    if (destination === f.path && fail) {
      fail = false;
      throw Object.assign(Error('Denied index rename'), { code: 'EACCES' });
    }
    return rename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => installSnapshot(f.root, update), /Denied index rename/);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.deepEqual(fs.readFileSync(f.path), before);
  assert.deepEqual(readSnapshot(f.root), prior);
  assert.equal(fs.readFileSync(join(f.root, '.issues/one.md'), 'utf8'), f.snapshot.issues[0].report);
  installSnapshot(f.root, update);
  assert.equal(readSnapshot(f.root).issues[0].flow.revision, 2);
});

test('explicit deletion removes only its issue and retained display fragments', (t) => {
  const f = fixture(t);
  installSnapshot(f.root, f.snapshot);
  installSnapshot(f.root, selected(f));
  const other = fragment(
    f,
    stored(f).issues.find((i) => i.id === 'two')
  );
  installSnapshot(f.root, {
    ...f.snapshot,
    issues: [],
    issueIds: ['one'],
    claims: [],
    commands: [],
    deletedIssueIds: ['one'],
  });
  assert.deepEqual(
    readSnapshot(f.root).issues.map((i) => i.id),
    ['two']
  );
  assert.equal(fs.existsSync(join(f.root, '.issues/store-runtime/snapshot-issues/one')), false);
  assert.ok(fs.existsSync(other));
});

test('complete authoritative refresh repairs damaged fragments while retaining unexpected report edits', (t) => {
  for (const damage of ['changed', 'missing']) {
    const f = fixture(t);
    installSnapshot(f.root, f.snapshot);
    readSnapshot(f.root);
    const path = fragment(f, stored(f).issues[0]);
    if (damage === 'changed') fs.writeFileSync(path, '{}');
    else fs.unlinkSync(path);
    fs.writeFileSync(join(f.root, '.issues/one.md'), 'Local draft report.');
    assert.throws(() => installSnapshot(f.root, { ...f.snapshot, issueIds: ['one'] }), {
      code: 'STORE_INVALID_SNAPSHOT',
    });
    installSnapshot(f.root, f.snapshot);
    assert.equal(readSnapshot(f.root).issues[0].flow.revision, 1);
    const drafts = join(f.root, '.issues/store-runtime/drafts/one');
    assert.equal(fs.readFileSync(join(drafts, fs.readdirSync(drafts)[0]), 'utf8'), 'Local draft report.');
    assert.equal(fs.readFileSync(join(f.root, '.issues/one.md'), 'utf8'), f.snapshot.issues[0].report);
  }
});
