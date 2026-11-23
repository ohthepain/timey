import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  renameSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { planDeletedFiles, removeDeletedFiles } from './factory-ui/stores/deletion-files.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deleted-evidence-files-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (path, body) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
    return { path: full, sha256: sha(body) };
  };
  return { root, file };
}

test('permanent Delete removes verified managed evidence and preserves shared paths or identical bytes', (t) => {
  const { root, file } = fixture(t);
  const unique = file('.issues/evidence/a.txt', 'unique proof');
  const sharedPath = file('.issues/factory-ui/flow-evidence/shared.txt', 'retained path');
  const sharedBytes = file('.issues/store-runtime/evidence/a/proof.txt', 'retained identical bytes');
  const progress = file('.issues/store-runtime/progress/a/log.txt', 'unique log');
  const retained = [{ proof: sharedPath.path }, { ref: { sha256: sharedBytes.sha256 } }];
  const plan = planDeletedFiles(root, [unique, sharedPath, sharedBytes, progress], retained);
  assert.deepEqual(new Set(plan.map((value) => value.path)), new Set([unique.path, progress.path]));
  assert.deepEqual(removeDeletedFiles(root, plan), { removed: 2, kept: 0 });
  assert.equal(existsSync(unique.path), false);
  assert.equal(existsSync(progress.path), false);
  assert.equal(readFileSync(sharedPath.path, 'utf8'), 'retained path');
  assert.equal(readFileSync(sharedBytes.path, 'utf8'), 'retained identical bytes');
  assert.deepEqual(removeDeletedFiles(root, plan), { removed: 0, kept: 0 });
});

test('Delete never traverses symlinks or removes source worktrees and unrelated flow files', (t) => {
  const { root, file } = fixture(t);
  const source = file('.issues/issue-work/a/source.txt', 'source must stay');
  const outside = file('external/proof.txt', 'external must stay');
  const flow = file('.issues/flows/a/flow.json', '{"issueId":"a"}');
  const otherFlow = file('.issues/flows/b/flow.json', '{"issueId":"b"}');
  mkdirSync(join(root, '.issues/evidence'), { recursive: true });
  const linkedFile = join(root, '.issues/evidence/linked.txt');
  const linkedDirectory = join(root, '.issues/evidence/linked');
  symlinkSync(outside.path, linkedFile);
  symlinkSync(dirname(outside.path), linkedDirectory);
  const linked = [
    { path: linkedFile, sha256: outside.sha256 },
    { path: join(linkedDirectory, 'proof.txt'), sha256: outside.sha256 },
  ];
  assert.deepEqual(planDeletedFiles(root, [source, outside, flow, otherFlow, ...linked], []), []);
  assert.deepEqual(planDeletedFiles(root, [flow, otherFlow], [], { issueId: 'a' }), [flow]);
  assert.deepEqual(removeDeletedFiles(root, [source, outside, otherFlow, ...linked], { issueId: 'a' }), {
    removed: 0,
    kept: 5,
  });
  assert.equal(readFileSync(outside.path, 'utf8'), 'external must stay');
  assert.equal(readFileSync(source.path, 'utf8'), 'source must stay');
  assert.equal(readFileSync(otherFlow.path, 'utf8'), '{"issueId":"b"}');
});

test('Delete preserves files changed or replaced with symlinks after planning', (t) => {
  const { root, file } = fixture(t);
  const changed = file('.issues/evidence/changed.txt', 'old proof');
  const replaced = file('.issues/evidence/replaced.txt', 'old linked proof');
  const outside = file('external/proof.txt', 'external proof');
  const plan = planDeletedFiles(root, [changed, replaced], []);
  writeFileSync(changed.path, 'new proof');
  rmSync(replaced.path);
  symlinkSync(outside.path, replaced.path);
  assert.deepEqual(removeDeletedFiles(root, plan), { removed: 0, kept: 2 });
  assert.equal(readFileSync(changed.path, 'utf8'), 'new proof');
  assert.equal(readFileSync(outside.path, 'utf8'), 'external proof');
});

test('Delete rejects changed hashes, missing files, malformed paths and symlinked parent replacements', (t) => {
  const { root, file } = fixture(t);
  const proof = file('.issues/evidence/original/proof.txt', 'original');
  const outside = file('external/proof.txt', 'original');
  assert.deepEqual(
    planDeletedFiles(
      root,
      [
        { path: proof.path },
        { ...proof, sha256: 'f'.repeat(64) },
        { path: proof.path + '.missing', sha256: proof.sha256 },
      ],
      []
    ),
    []
  );
  const plan = planDeletedFiles(root, [proof], []);
  renameSync(dirname(proof.path), dirname(proof.path) + '-retained');
  symlinkSync(dirname(outside.path), dirname(proof.path));
  assert.deepEqual(removeDeletedFiles(root, plan), { removed: 0, kept: 1 });
  assert.equal(readFileSync(outside.path, 'utf8'), 'original');
  assert.deepEqual(removeDeletedFiles(root, [{ path: root, sha256: proof.sha256 }, { sha256: 'invalid' }]), {
    removed: 0,
    kept: 2,
  });
});

test('Delete handles a project root alias without traversing evidence symlinks', (t) => {
  const { root, file } = fixture(t);
  const proof = file('.issues/evidence/alias-proof.txt', 'owned proof');
  const alias = root + '-alias';
  symlinkSync(root, alias);
  t.after(() => rmSync(alias, { force: true }));
  const supplied = { path: join(alias, '.issues/evidence/alias-proof.txt'), sha256: proof.sha256 };
  assert.deepEqual(planDeletedFiles(alias, [supplied], []), [proof]);
  assert.deepEqual(removeDeletedFiles(alias, [supplied]), { removed: 1, kept: 0 });
});
