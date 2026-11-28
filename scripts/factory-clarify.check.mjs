import { conversationMessages } from './factory-ui/conversation-store.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { captureFixture, proposal, captureStages } from './factory-capture-fixture.mjs';
import { clarificationLifecycle } from './factory-ui/clarify-policy.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { sameStage } from './factory-ui/lifecycle-runs.mjs';
import { createIssueFolderSettings } from './factory-ui/issue-folder-settings.mjs';
import { createCaptures } from './factory-ui/issue-capture.mjs';
import { captureRoute } from './factory-ui/capture-routing.mjs';
import { createIssueChats } from './factory-ui/issue-chat.mjs';
import { randomUUID } from 'node:crypto';

function fixture(t) {
  const f = captureFixture(t);
  writeFileSync(join(f.root, 'factory.config.json'), '{"clarification":"combined"}');
  f.git('add', 'factory.config.json');
  f.git('commit', '-qm', 'Enable combined Clarify');
  f.service.ownServer = () => {};
  f.service.codex.call = async () => ({ thread: { status: { type: 'idle' } } });
  return { ...f, id: '20261025-existing', report: join(f.root, '.issues/20261025-existing.md') };
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

test('capture grilling is explicit, follows durable creation, survives retries and starts no implementation', async (t) => {
  const f = fixture(t);
  let replies = 0;
  const skillPath = join(f.root, '.agents/skills/grilling/SKILL.md');
  mkdirSync(join(f.root, '.agents/skills/grilling'), { recursive: true });
  writeFileSync(skillPath, 'Ask useful questions.');
  f.service.issueChats.close();
  f.service.issueChats = createIssueChats(f.service, () => ({
    ready: async () => {},
    call: async () => ({ data: [{ skills: [{ name: 'grilling', path: skillPath, enabled: true }] }] }),
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
  createIssueFolderSettings(f.root, 'Inbox');
  const input = { requestId: randomUUID(), description: 'Improve Save', grill: true, folder: 'Inbox' };
  const created = await f.service.captures.save(input);
  assert.equal(created.issues[0].state, 'backlog');
  assert.equal(created.grilling[0].started, true);
  await Promise.all(f.service.issueChats.tasks.values());
  assert.equal(replies, 1);
  const repeated = await f.service.captures.save(input);
  assert.equal(repeated.grilling[0].repeated, true);
  const messages = conversationMessages(f.root, created.issues[0].id);
  const starts = messages.filter((message) => message.kind === 'grilling-start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].source.stage.state, 'backlog');
  assert.equal(starts[0].source.skill.path, realpathSync(skillPath));
  assert.equal(messages.find((message) => message.id === 'capture-grill-' + input.requestId).actor, 'factory');
  const review = f.service.discussions.open({ issueId: created.issues[0].id }, 'capture-review');
  assert.equal(review.stage.state, 'backlog');
  assert.equal(replies, 1);
  assert.equal(f.service.lifecycleTasks.size, 0);
  assert.equal(f.service.api.inspect().registry.actions.length, 0);
  await assert.rejects(f.service.captures.save({ ...input, grill: false }), /another description/);
});

test('route display labels resolve to canonical states without changing approval or skip policy', async (t) => {
  const { validateRoutes } = await import('./factory-ui/lifecycle.mjs');
  const f = fixture(t),
    queue = readQueue(f.root);
  const route = [
    {
      issueId: f.id,
      steps: queue.lifecycle.map((stage) => ({
        state: stage.name,
        decision: 'undecided',
        reason: 'Await the existing stage decision.',
      })),
    },
  ];
  const before = structuredClone(route);
  const result = validateRoutes(queue, route, f.id);
  assert.deepEqual(
    result[0].steps.map((step) => step.state),
    queue.lifecycle.map((stage) => stage.state)
  );
  assert.deepEqual(route, before, 'Preserve the raw model response.');
  assert.ok(result[0].steps.every((step) => step.decision === 'undecided'));
  assert.throws(
    () =>
      validateRoutes(queue, [
        { issueId: f.id, steps: [{ state: 'Verify', decision: 'skip', reason: 'Try to skip a required stage.' }] },
      ]),
    /required by project policy/
  );
  assert.throws(
    () =>
      validateRoutes(queue, [
        {
          issueId: f.id,
          steps: [
            { state: 'Verify', decision: 'take', reason: 'First' },
            { state: 'verify', decision: 'skip', reason: 'Conflicting duplicate' },
          ],
        },
      ]),
    /repeats a step/
  );
  assert.throws(
    () =>
      validateRoutes(queue, [
        { issueId: f.id, steps: [{ state: 'invented-stage', decision: 'take', reason: 'Unknown' }] },
      ]),
    /Unknown or ambiguous/
  );
  const ambiguous = { ...queue, lifecycle: [...queue.lifecycle, { state: 'other', name: 'Verify' }] };
  assert.throws(
    () =>
      validateRoutes(ambiguous, [
        { issueId: f.id, steps: [{ state: 'Verify', decision: 'take', reason: 'Ambiguous' }] },
      ]),
    /Unknown or ambiguous/
  );
});

test('route role IDs and agreeing aliases resolve once without changing decisions', async (t) => {
  const { validateRoutes } = await import('./factory-ui/lifecycle.mjs');
  const f = fixture(t),
    queue = readQueue(f.root);
  const steps = queue.lifecycle.map((stage) => ({
    state: stage.role,
    decision: 'undecided',
    reason: 'Retain the decision.',
  }));
  steps.push({ state: 'final', decision: 'undecided', reason: 'Alias for final review.' });
  const routes = [{ issueId: f.id, steps }],
    before = structuredClone(routes);
  const result = validateRoutes(queue, routes, f.id);
  assert.deepEqual(
    result[0].steps.map((step) => step.state),
    queue.lifecycle.map((stage) => stage.state)
  );
  assert.match(result[0].steps.find((step) => step.state === 'final').reason, /Alias for final review/);
  assert.deepEqual(routes, before);
  assert.throws(
    () =>
      validateRoutes(queue, [
        {
          issueId: f.id,
          steps: [
            { state: 'ready-to-verify', decision: 'skip', reason: 'Role spelling cannot bypass required checks.' },
          ],
        },
      ]),
    /required by project policy/
  );
  assert.throws(
    () =>
      validateRoutes(queue, [
        {
          issueId: f.id,
          steps: [
            { state: 'ready-to-close', decision: 'take', reason: 'First' },
            { state: 'final', decision: 'skip', reason: 'Conflicting alias' },
          ],
        },
      ]),
    /conflicting decisions/
  );
});
