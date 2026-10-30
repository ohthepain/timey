import test from 'node:test';
import assert from 'node:assert/strict';
import { selectNextIssue } from './factory-ui/queue-selection.mjs';
test('queue coordinator receives only compact scheduling facts and cannot return an assignment', async () => {
  let prompt;
  const service = { lifecycleTasks: new Map(), lifecycleRuns: { one: { status: 'paused', summary: 'Ready', plan: { content: 'SECRET_PLAN'.repeat(5000) }, events: ['HUGE_EVENTS'] } },
    coordinator: { turn: async (_run, text) => { prompt = text; return JSON.stringify({ next_issue_id: 'one', reason: 'Ready to continue' }); } } };
  const queue = { issues: [{ id: 'one', title: 'One', state: 'implement', content: 'FULL_REPORT'.repeat(5000) }], lifecycle: [] };
  const result = await selectNextIssue(service, {}, queue);
  assert.equal(result.next_issue_id, 'one');
  assert.deepEqual(result.recommendations, []);
  assert.deepEqual(result.routes, []);
  assert.ok(prompt.length < 2000);
  assert.doesNotMatch(prompt, /SECRET_PLAN|HUGE_EVENTS|FULL_REPORT/);
});
test('coordinator cannot select an active issue or an issue waiting for human input', async () => {
  const service = { lifecycleTasks: new Map([['active', true]]), lifecycleRuns: { waiting: { input: { type: 'publication' } } },
    coordinator: { turn: async () => JSON.stringify({ next_issue_id: 'waiting', reason: 'Invalid' }) } };
  await assert.rejects(selectNextIssue(service, {}, { issues: [{ id: 'active' }, { id: 'waiting' }], lifecycle: [] }), /ineligible/);
});
