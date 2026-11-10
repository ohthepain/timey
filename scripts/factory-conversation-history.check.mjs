import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { conversationTimeline } from './factory-ui/conversation-view.mjs';
import { conversationContext, conversationPrompt } from './factory-ui/conversation-context.mjs';
import { appendMessage } from './factory-ui/conversation-store.mjs';
import { saveLifecycle, loadLifecycles } from './factory-ui/lifecycle-store.mjs';
import { strategyPrompt } from './factory-ui/strategy-prompt.mjs';

function fixture(t) {
  const f = deliveryFixture(t);
  const id = f.input.issueId;
  const directory = join(f.queue.root, '.issues/factory-ui');
  mkdirSync(directory, { recursive: true });
  const metadata = {
    id,
    title: 'History check',
    state: 'verify',
    created: '2026-11-01T10:00:00Z',
    lifecycle_history: [
      {
        state: 'verify',
        outcome: 'completed',
        reason: 'Required checks completed.',
        at: '2026-11-01T12:00:00Z',
        revision: f.input.revision,
        evidence: [{ path: f.input.verification[0] }],
      },
    ],
    stage_grilling: [
      {
        state: 'verify',
        name: 'Verify',
        at: '2026-11-01T11:00:00Z',
        confirmed: true,
        revision: f.input.revision,
        summary: 'Keep old reports intact.',
      },
    ],
    closure: {
      reason: 'fixed',
      label: 'Fixed',
      details: 'Accepted by the user.',
      at: '2026-11-01T15:00:00Z',
      actor: 'human',
    },
  };
  const report = join(f.queue.root, '.issues', id + '.md');
  const writeReport = () =>
    writeFileSync(
      report,
      '---\n' +
        stringify(metadata) +
        '---\n\n## Original request\n\nKeep issue history available.\n\n## Verification intent\n\nExercise history queries.\n'
    );
  writeReport();
  const checked = { head: f.input.revision, summaries: f.input.verification };
  const service = {
    root: f.queue.root,
    store: {
      directory,
      runs: [
        {
          id: 'work-run',
          issueId: id,
          kind: 'issue-work',
          created: '2026-11-01T11:00:00Z',
          status: 'completed',
          result: { summary: 'I implemented the history view.', checked },
        },
      ],
    },
    lifecycleRuns: {},
  };
  const record = {
    issueId: id,
    status: 'merged',
    work: {
      runId: 'work-run',
      config: { target: 'dev' },
      verification: { head: checked.head, checked, at: '2026-11-01T12:00:00Z' },
      merge: { revision: f.input.revision, url: 'https://github.com/fixture/timey/pull/1' },
      mergedAt: '2026-11-01T13:00:00Z',
      localDevUpdate: { status: 'not-updated', reason: 'The local checkout has edits.' },
    },
  };
  saveLifecycle(service, record);
  const timeline = () => {
    const queue = readQueue(service.root);
    return conversationTimeline(
      service,
      queue,
      queue.issues.find((issue) => issue.id === id)
    );
  };
  return { ...f, id, metadata, report, writeReport, service, record, timeline };
}

test('one saved history includes capture, reviewed decisions, work, checks, distinct merge and target outcomes, and closure', (t) => {
  const f = fixture(t);
  const messages = f.timeline();
  const kinds = messages.map((message) => message.kind);
  for (const kind of [
    'original-request',
    'reviewed-decision',
    'role-result',
    'stage-outcome',
    'factory-verification',
    'github-merge',
    'local-target-update',
    'issue-closure',
  ])
    assert.ok(kinds.includes(kind), kind);
  assert.equal(messages.find((entry) => entry.kind === 'original-request').body, 'Keep issue history available.');
  assert.equal(messages.filter((entry) => entry.kind === 'factory-verification').length, 1);
  assert.equal(messages.find((entry) => entry.kind === 'github-merge').status, 'merged');
  assert.equal(messages.find((entry) => entry.kind === 'local-target-update').status, 'not-updated');
  assert.match(messages.find((entry) => entry.kind === 'local-target-update').body, /local checkout has edits/);
  assert.equal(messages.find((entry) => entry.kind === 'role-result').actor, 'agent');
  assert.equal(messages.find((entry) => entry.kind === 'factory-verification').actor, 'factory');
  for (const entry of messages.filter((message) => message.source.evidence)) {
    for (const evidence of entry.source.evidence) assert.ok(readFileSync(evidence.path).length);
  }
});

test('event identities survive reload and insertion of an older stage record', (t) => {
  const f = fixture(t);
  const before = f.timeline();
  f.service.lifecycleRuns = loadLifecycles(f.service.root);
  assert.deepEqual(f.timeline(), before);
  f.metadata.lifecycle_history.unshift({
    state: 'verify',
    outcome: 'skipped',
    reason: 'Older historical decision.',
    at: '2026-10-31T10:00:00Z',
  });
  f.writeReport();
  const after = new Map(f.timeline().map((event) => [event.id, event]));
  for (const event of before) assert.deepEqual(after.get(event.id), event);
});

test('assistant merge claims never become confirmed Factory merge events', (t) => {
  const f = fixture(t);
  delete f.record.work.merge;
  delete f.record.work.localDevUpdate;
  saveLifecycle(f.service, f.record);
  appendMessage(f.service.root, f.id, {
    id: 'claim',
    actor: 'agent',
    role: 'Issue assistant',
    kind: 'response',
    body: 'I merged everything and updated local dev.',
  });
  const messages = f.timeline();
  assert.ok(messages.some((event) => event.id === 'claim'));
  assert.equal(
    messages.some((event) => ['github-merge', 'local-target-update'].includes(event.kind)),
    false
  );
});

test('shared context and strategy history reference retain the same complete sourced lifecycle', (t) => {
  const f = fixture(t);
  const context = conversationContext(f.service, f.id);
  const saved = JSON.parse(readFileSync(context.fullConversation, 'utf8'));
  assert.deepEqual(saved.messages, JSON.parse(JSON.stringify(f.timeline())));
  const query = conversationPrompt(f.service, { issueId: f.id }, 'What did you do?');
  const retro = conversationPrompt(f.service, { issueId: f.id }, 'Run the installed retro skill.');
  for (const prompt of [query, retro]) {
    assert.ok(prompt.includes(context.fullConversation));
    assert.match(prompt, /github-merge/);
    assert.match(prompt, /local-target-update/);
    assert.match(prompt, /issue-closure/);
    assert.ok(prompt.includes(f.input.verification[0]));
  }
  const prompt = strategyPrompt(
    f.service.root,
    readQueue(f.service.root).issues[0],
    f.record.work,
    'Continue.',
    context
  );
  assert.ok(prompt.includes(context.fullConversation));
  assert.equal(prompt.includes('/messages.jsonl'), false);
});
