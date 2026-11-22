import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { installSnapshot } from './factory-ui/stores/snapshots.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
function write(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}
const issue = (id, number, flow) => ({
  id,
  number,
  report: '---\nid: ' + id + '\n---\nbody',
  location: 'archive',
  flow,
});

test('peer refresh clears verified deleted caches while retaining shared evidence and changed source files', (t) => {
  const { root } = gitFixture(t, 'delete-cache-');
  const unique = 'exclusive proof';
  const shared = 'shared proof';
  const proof = join(root, '.issues/evidence/a.txt');
  const outside = join(root, 'source.txt');
  write(proof, unique);
  write(outside, unique);
  const files = [
    { path: proof, sha256: digest(unique) },
    { path: outside, sha256: digest(unique) },
    { path: join(root, '.issues/evidence/shared.txt'), sha256: digest(shared) },
  ];
  write(files[2].path, shared);
  for (const id of ['a', 'b']) {
    const selected = id === 'a' ? files : [files[2]];
    write(
      join(root, '.issues/store-runtime/evidence', id, 'manifest.json'),
      JSON.stringify({ key: 'evidence/' + id, value: { files: selected } })
    );
    for (const file of selected)
      write(
        join(root, '.issues/store-runtime/evidence', id, file.sha256),
        file.sha256 === digest(shared) ? shared : unique
      );
  }
  const flow = { issueId: 'a', revision: 1, blocks: [] };
  const initial = {
    version: 1,
    projectId: 'fixture',
    issues: [issue('a', 1, flow), issue('b', 2, null)],
    deletedIssueIds: [],
  };
  installSnapshot(root, initial);
  installSnapshot(root, { ...initial, issues: [initial.issues[1]], deletedIssueIds: ['a'] });
  assert.equal(existsSync(proof), false);
  assert.equal(existsSync(join(root, '.issues/flows/a/flow.json')), false);
  assert.equal(existsSync(join(root, '.issues/store-runtime/evidence/a', digest(unique))), false);
  assert.equal(existsSync(join(root, '.issues/store-runtime/evidence/a/manifest.json')), false);
  assert.equal(readFileSync(files[2].path, 'utf8'), shared);
  assert.equal(readFileSync(outside, 'utf8'), unique);
  assert.equal(readFileSync(join(root, '.issues/store-runtime/evidence/b', digest(shared)), 'utf8'), shared);
});
