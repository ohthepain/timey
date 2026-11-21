import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureIssueNumbers, issueNumberLabel } from './factory-ui/issue-numbers.mjs';

test('issue numbers remain stable, increase monotonically, and are never reused', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'timey-issue-numbers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.issues'));

  assert.deepEqual(ensureIssueNumbers(root, ['legacy-a', 'legacy-b']), { 'legacy-a': 1, 'legacy-b': 2 });
  assert.deepEqual(ensureIssueNumbers(root, ['legacy-b']), { 'legacy-b': 2 });
  assert.deepEqual(ensureIssueNumbers(root, ['legacy-b', 'new-issue']), { 'legacy-b': 2, 'new-issue': 3 });
  assert.deepEqual(ensureIssueNumbers(root, ['new-issue', 'another-issue']), { 'new-issue': 3, 'another-issue': 4 });
  assert.equal(issueNumberLabel({ issueNumber: 4, id: 'internal-id' }), '#4');

  const registry = JSON.parse(readFileSync(join(root, '.issues/issue-numbers.json'), 'utf8'));
  assert.equal(registry.next, 5);
  assert.deepEqual(registry.issues, { 'legacy-a': 1, 'legacy-b': 2, 'new-issue': 3, 'another-issue': 4 });
});
