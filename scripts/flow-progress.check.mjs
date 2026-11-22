import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { newFlow } from './factory-ui/flow-store.mjs';

function fixture(t) {
  const { root } = gitFixture(t, 'flow-progress-');
  mkdirSync(join(root, '.issues'));
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    store: { runs: [], connected: new Set() },
    issueChats: { active: new Map() },
  };
  const flows = createIssueFlows(service);
  t.after(() => flows.close());
  const issues = ['first', 'second'].map((id) => ({ id, title: 'Fix progress', content: '' }));
  const records = issues.map((issue) => {
    const flow = newFlow(issue, { remote: 'origin', branch: 'dev', base: null });
    const block = flow.blocks.find(({ kind }) => kind === 'work');
    block.attempts.push({ id: issue.id + '-attempt', status: 'running', output: '' });
    flows.store.save(flow, flow.revision);
    return { issue, blockId: block.id, attemptId: block.attempts[0].id };
  });
  const read = ({ issue }) => JSON.parse(readFileSync(flows.store.path(issue.id), 'utf8'));
  return { flows, records, read };
}

test('interleaved issue progress retains output, workspace, timing and terminal results', (t) => {
  const { flows, records, read } = fixture(t);
  for (let index = 0; index < 4; index++) {
    for (const { issue, blockId, attemptId } of records)
      flows.changeAttempt(issue, blockId, attemptId, (attempt) => {
        attempt.output += issue.id + index + '\n';
      });
  }
  for (const record of records) {
    const { issue, blockId, attemptId } = record;
    const workspace = { checkout: '/temporary/' + issue.id, branch: 'codex/' + issue.id };
    flows.changeAttempt(issue, blockId, attemptId, (_, flow) => {
      flow.workspace = workspace;
    });
    const active = read(record);
    const attempt = active.blocks.find(({ id }) => id === blockId).attempts[0];
    assert.equal(attempt.output, [0, 1, 2, 3].map((index) => issue.id + index + '\n').join(''));
    assert.ok(Number.isFinite(Date.parse(attempt.lastActiveAt)));
    assert.deepEqual(active.workspace, workspace);
    flows.changeAttempt(issue, blockId, attemptId, (current) => {
      Object.assign(current, { status: 'completed', result: { candidate: issue.id }, endedAt: '2026-11-22T08:00:00Z' });
    });
    const completed = read(record).blocks.find(({ id }) => id === blockId).attempts[0];
    assert.equal(completed.output, attempt.output);
    assert.equal(completed.lastActiveAt, attempt.lastActiveAt);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.endedAt, '2026-11-22T08:00:00Z');
    assert.deepEqual(completed.result, { candidate: issue.id });
    assert.equal(read(record).revision, active.revision + 1);
  }
});

test('attempt updates preserve conflict and missing-attempt guards', (t) => {
  const { flows, records, read } = fixture(t);
  const record = records[0];
  const { issue, blockId, attemptId } = record;
  assert.throws(() => flows.changeAttempt(issue, blockId, 'missing'), /running block record is missing/);
  assert.throws(
    () =>
      flows.changeAttempt(issue, blockId, attemptId, (attempt) => {
        const current = read(record);
        current.note = 'concurrent edit';
        flows.store.save(current, current.revision);
        attempt.output = 'must not overwrite the edit';
      }),
    /flow changed/
  );
  assert.equal(read(record).note, 'concurrent edit');
  assert.equal(read(record).blocks.find(({ id }) => id === blockId).attempts[0].output, '');
});
