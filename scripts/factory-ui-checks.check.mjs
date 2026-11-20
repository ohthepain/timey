import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { workingSourceDigest } from './factory-ui/checks.mjs';

test('workingSourceDigest records gitlinked directories without reading them', (t) => {
  const f = gitFixture(t, 'checks-');
  mkdirSync(join(f.root, 'linked'));
  const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  f.git('update-index', '--add', '--cacheinfo', `160000,${emptyTree},linked`);
  assert.doesNotThrow(() => workingSourceDigest(f.root));
  assert.equal(typeof workingSourceDigest(f.root), 'string');
});
