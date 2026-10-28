import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureFixture, proposal, captureStages } from './factory-capture-fixture.mjs';
import { clarificationLifecycle } from './factory-ui/clarify-policy.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { progressBasis } from './factory-ui/next-action.mjs';
import { sameStage } from './factory-ui/lifecycle-runs.mjs';
import { createCaptures } from './factory-ui/issue-capture.mjs';
import { captureRoute } from './factory-ui/capture-routing.mjs';
import { createIssueChats } from './factory-ui/issue-chat.mjs';
import { randomUUID } from 'node:crypto';
import { approvePlanAdaptation } from './factory-ui/plan-adaptation.mjs';
import { digest } from './factory-ui/common.mjs';

function fixture(t) {
  const f = captureFixture(t);
  writeFileSync(join(f.root, 'factory.config.json'), '{"clarification":"combined"}');
  f.git('add', 'factory.config.json');
  f.git('commit', '-qm', 'Enable combined Clarify');
  f.service.ownServer = () => {};
  f.service.codex.call = async () => ({ thread: { status: { type: 'idle' } } });
  return { ...f, id: '20261025-existing', report: join(f.root, '.issues/20261025-existing.md') };
}
function assessment(f, questions = []) {
  return {
    prior_approval: null,
    direct_task: null,
    direct_routes: [],
    clarification_complete: !questions.length,
    summary: 'Enough context to implement the requested outcome.',
    evidence: [join(f.root, 'source.js')],
    questions,
    plan_path: null,
    plan_summary: 'Implement the agreed scope.',
    proposed_plan: 'Implement the requested behavior within the agreed scope.',
  };
}
async function settled(service, id) {
  const task = service.lifecycleTasks.get(id);
  if (task) await task;
  return service.lifecycleRuns[id];
}
function start(f) {
  const queue = readQueue(f.root),
    issue = queue.issues[0];
  f.service.startLifecycle({ issueId: issue.id, state: issue.state, issueBasis: progressBasis(queue, issue.id) });
}

test('combined Clarify preserves saved aliases, original reports, active run identity and custom stages', (t) => {
  const f = fixture(t);
  writeFileSync(f.report, readFileSync(f.report, 'utf8').replace('state: backlog', 'state: to-do'));
  const original = readFileSync(f.report, 'utf8'),
    queue = readQueue(f.root),
    issue = queue.issues[0];
  assert.equal(queue.lifecycle.filter((s) => s.name === 'Clarify').length, 1);
  assert.equal(
    queue.lifecycle.some((s) => s.name === 'Investigate'),
    false
  );
  assert.equal(issue.state, 'backlog');
  assert.equal(issue.saved_state, 'to-do');
  assert.equal(sameStage(queue, issue, { issueState: 'to-do' }), true);
  assert.equal(readFileSync(f.report, 'utf8'), original);
  const raw = captureStages.map(([role, state], i) => ({ role, state, next: captureStages[i + 1]?.[1] || '—' }));
  raw[0].next = 'custom-check';
  raw.splice(1, 0, { role: 'custom', state: 'custom-check', next: 'to-do' });
  const stages = clarificationLifecycle(f.root, raw).stages;
  assert.equal(stages[0].next, 'custom-check');
  assert.equal(stages[1].next, 'prototype');
  assert.equal(captureRoute(stages, proposal('Defined work')).state, 'custom-check');
});

test('diagnostic Clarify precedes approval and completes both old states through the real human-input guard', async (t) => {
  for (const state of ['backlog', 'to-do']) {
    const f = fixture(t);
    writeFileSync(f.report, readFileSync(f.report, 'utf8').replace('state: backlog', 'state: ' + state));
    let calls = 0;
    f.service.codex.start = async (_cwd, sandbox) => {
      assert.equal(sandbox, 'read-only');
      return 'clarify-chat';
    };
    f.service.codex.turn = async (_id, _cwd, prompt) => {
      calls++;
      assert.match(prompt, /run focused diagnostic or reproduction commands/);
      assert.doesNotMatch(prompt, /Do not modify files, start work, run tests/);
      assert.equal(f.service.lifecycleRuns[f.id].approval, undefined);
      return JSON.stringify(assessment(f));
    };
    start(f);
    const record = await settled(f.service, f.id);
    assert.equal(record.status, 'waiting', record.summary);
    assert.equal(record.input.type, 'plan');
    assert.equal(readQueue(f.root).issues[0].state, 'prototype');
    assert.equal(calls, 1);
    assert.equal(f.service.api.inspect().registry.actions.length, 0);
  }
});

test('existing active investigations finish without another assessment or replacement worker', async (t) => {
  const f = fixture(t);
  const [action] = f.service.api.recommend([
    {
      kind: 'investigate',
      title: 'Existing investigation',
      scope: 'Inspect source',
      reason: 'Existing assignment',
      verification: 'Read source',
      worker_prompt: 'Inspect source only',
      merge: 'none',
      issues: [f.id],
      dependencies: [],
    },
  ]);
  f.service.api.reserve(action.id);
  f.service.api.attach(action.id, { threadId: 'existing', hostId: 'native' });
  f.service.codex.start = async () => {
    throw Error('Must not start another chat.');
  };
  start(f);
  const record = await settled(f.service, f.id);
  assert.equal(record.status, 'blocked');
  assert.match(record.summary, /existing assignment is still active/);
  assert.equal(f.service.api.inspect().registry.actions[0].threadId, 'existing');
  assert.equal(f.service.store.runs.length, 0);
});

test('ordinary commits preserve pending clarification answers and do not restart the interview', async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.service.codex.start = async () => 'clarify-chat';
  f.service.codex.resume = async () => {};
  f.service.codex.ready = async () => {};
  f.service.codex.call = async () => ({ thread: { status: { type: 'idle' } } });
  f.service.codex.turn = async () =>
    JSON.stringify(
      assessment(f, ++calls === 1 ? [{ id: 'intent', question: 'Should Save retain the current selection?' }] : [])
    );
  start(f);
  const waiting = await settled(f.service, f.id);
  assert.equal(waiting.input.type, 'questions');
  writeFileSync(join(f.root, 'unrelated.js'), 'export const unrelated = true;\n');
  f.git('add', 'unrelated.js');
  f.git('commit', '-qm', 'Unrelated commit');
  await f.service.answerLifecycle({
    issueId: f.id,
    updated: waiting.updated,
    text: 'Yes, retain the current selection.',
    decision: 'answer',
  });
  const ready = await settled(f.service, f.id);
  assert.equal(ready.input.type, 'plan', ready.summary);
  assert.equal(calls, 2);
  assert.match(readFileSync(f.report, 'utf8'), /retain the current selection/);
});

test('technical plan adaptations retain actual human approval and reuse their decision across commits', async (t) => {
  const f = fixture(t);
  const plan = { content: 'Implement the agreed outcome.', sha256: digest('Implement the agreed outcome.') };
  const approval = { sha256: plan.sha256, receipt: '/original-human-receipt' };
  const record = { issueId: f.id, startHead: f.git('rev-parse', 'HEAD'), events: [], plan, approval };
  f.service.lifecycleRuns[f.id] = record;
  f.service.codex.start = async () => 'scope-chat';
  let calls = 0;
  f.service.codex.turn = async () => {
    calls++;
    return JSON.stringify({ within_scope: true, summary: 'Only the technical sequence changed.' });
  };
  const current = { content: 'Use a different helper to implement the agreed outcome.' },
    hash = digest(current.content);
  assert.equal(await approvePlanAdaptation(f.service, record, current, hash), true);
  f.git('commit', '--allow-empty', '-qm', 'Ordinary commit');
  assert.equal(await approvePlanAdaptation(f.service, record, current, hash), true);
  assert.equal(calls, 1);
  assert.deepEqual(record.approval, approval);
  assert.deepEqual(record.plan, plan);
});

test('capture grilling is explicit, follows durable creation, survives retries and starts no implementation', async (t) => {
  const f = fixture(t);
  let replies = 0;
  f.service.issueChats.close();
  f.service.issueChats = createIssueChats(f.service, () => ({
    attach: async (_root, _state, retain) => {
      retain({ threadId: 'issue-chat' });
      return 'issue-chat';
    },
    turn: async (_id, _cwd, prompt) => {
      replies++;
      assert.match(prompt, /Grill me after creation/);
      return 'Should Save retain the current selection? I recommend yes.';
    },
    close() {},
  }));
  f.service.captures = createCaptures(f.service, {
    assess: async (description) => ({ issues: [proposal(description)] }),
  });
  const input = { requestId: randomUUID(), description: 'Improve Save', grill: true };
  const created = await f.service.captures.save(input);
  assert.equal(created.issues[0].state, 'backlog');
  assert.equal(created.grilling[0].started, true);
  await Promise.all(f.service.issueChats.tasks.values());
  assert.equal(replies, 1);
  const repeated = await f.service.captures.save(input);
  assert.equal(repeated.grilling[0].repeated, true);
  assert.equal(replies, 1);
  assert.equal(f.service.lifecycleTasks.size, 0);
  assert.equal(f.service.api.inspect().registry.actions.length, 0);
  await assert.rejects(f.service.captures.save({ ...input, grill: false }), /another description/);
});
