import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from './factory-ui/common.mjs';
import { implementationOrder, persistImplementationOrder, readImplementationOrder } from './factory-ui/implementation-order.mjs';

test('implementation order persists, appends new issues, and rejects stale or incomplete writes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'timey-implementation-order-'));
  mkdirSync(join(root, '.issues'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const issues = [
    { id: 'showstopper', created: '2026-10-02', priorityInfo: { index: 0 } },
    { id: 'minor', created: '2026-10-01', priorityInfo: { index: 3 } },
  ];
  assert.deepEqual(implementationOrder(issues), ['showstopper', 'minor']);
  const current = ['showstopper', 'minor'];
  const queue = { issues, implementationOrder: current };
  const basis = digest(JSON.stringify({ issueIds: current.slice().sort(), order: current }));
  assert.deepEqual(persistImplementationOrder(root, queue, { basis, order: ['minor', 'showstopper'] }).order, [
    'minor',
    'showstopper',
  ]);
  const withNewIssue = [...issues, { id: 'new', created: '2026-10-03', priorityInfo: { index: 1 } }];
  assert.deepEqual(readImplementationOrder(root, withNewIssue), ['minor', 'showstopper', 'new']);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.issues/implementation-order.json'))).issues, [
    'minor',
    'showstopper',
  ]);
  assert.throws(() => persistImplementationOrder(root, queue, { basis: 'stale', order: current }), /queue changed/);
  assert.throws(
    () => persistImplementationOrder(root, queue, { basis, order: ['minor', 'minor'] }),
    /each current issue exactly once/
  );
});
