import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRetro } from './factory-ui/flow-retro.mjs';
import { exportRetroThread } from './factory-ui/flow-retro-thread.mjs';
import { gitFixture } from './git-fixture.mjs';

function pendingRetro(t) {
  const { root, git } = gitFixture(t, 'retro-deadline-');
  const directory = join(root, '.issues');
  mkdirSync(directory);
  cpSync(new URL('../.issues/triage-labels.md', import.meta.url), join(directory, 'triage-labels.md'));
  const id = '20261113-one';
  const content = `---\nid: ${id}\ntitle: Review issue\nstate: backlog\ncreated: 2026-11-13T12:00:00Z\n---\n\n## Original request\n\nReview the issue.\n`;
  writeFileSync(join(directory, id + '.md'), content);
  git('commit', '--allow-empty', '-qm', 'Fixture');
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  let closed = false;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = runRetro(
    { root, store: { runs: [], directory } },
    {
      issue: { id, content },
      flow: { blocks: [] },
      definition: { prompt: 'Review the issue.' },
      signal: new AbortController().signal,
    },
    () => ({
      async begin() {},
      ask() {
        entered.resolve();
        return answer.promise;
      },
      close() {
        closed = true;
      },
    })
  );
  return { entered: entered.promise, answer, result, closed: () => closed };
}

test('Retro accepts a review that needs more than 90 seconds', async (t) => {
  const retro = pendingRetro(t);
  await retro.entered;
  t.mock.timers.tick(91_000);
  retro.answer.resolve(JSON.stringify({ summary: 'Reviewed the issue.', recommendations: [] }));
  const result = await retro.result;
  assert.equal(result.summary, 'Reviewed the issue.');
  assert.equal(retro.closed(), true);
});

test('Retro closes a stalled review at five minutes and links its exported evidence', async (t) => {
  const retro = pendingRetro(t);
  await retro.entered;
  const failure = assert.rejects(retro.result, (error) => {
    assert.match(error.message, /Retro timed out while reviewing issue history/);
    const index = JSON.parse(readFileSync(error.evidence[0].path, 'utf8'));
    assert.ok(index.sections.report.sha256);
    return true;
  });
  t.mock.timers.tick(299_999);
  await Promise.resolve();
  assert.equal(retro.closed(), false);
  t.mock.timers.tick(1);
  await failure;
  assert.equal(retro.closed(), true);
});

test('retrospective exports retain ordered tool calls, outcomes, and public permission decisions', () => {
  const exported = exportRetroThread(
    'thread',
    {
      createdAt: 1,
      turns: [
        {
          id: 'turn',
          startedAt: 2,
          completedAt: 9,
          status: 'completed',
          items: [
            { id: 'message', type: 'agentMessage', text: 'Checking the fixture.', createdAt: 3 },
            {
              id: 'audit',
              type: 'commandExecution',
              command: 'node audit.mjs',
              aggregatedOutput: 'new warning',
              exitCode: 1,
              startedAt: 4,
            },
            {
              id: 'restriction',
              type: 'commandExecution',
              command: 'node browser.mjs',
              aggregatedOutput: 'listen EPERM',
              exitCode: 1,
            },
            {
              id: 'approval',
              type: 'autoApprovalReview',
              review: { status: 'approved', rationale: 'Local temporary server.', internalReasoning: 'private' },
              timestamp: 5,
            },
            {
              id: 'fixture',
              type: 'mcpToolCall',
              arguments: { fixture: 'old' },
              result: { error: 'fixture mismatch' },
            },
            {
              id: 'passing',
              type: 'dynamicToolCall',
              tool: 'test',
              arguments: {},
              content: [{ type: 'text', text: 'checks passed' }],
              timestamp: 8,
            },
          ],
        },
      ],
    },
    [{ id: 'attempt', result: { threadId: 'thread', turnId: 'turn' } }]
  );
  assert.deepEqual(exported.attemptIds, ['attempt']);
  const turn = exported.turns[0];
  assert.deepEqual(turn.attemptIds, ['attempt']);
  assert.equal(turn.attemptAssociation, 'recorded-turn-id');
  assert.deepEqual(
    turn.items.map((item) => item.id),
    ['message', 'audit', 'restriction', 'approval', 'fixture', 'passing']
  );
  assert.deepEqual(
    turn.items.map((item) => item.timestamp),
    [3, 4, null, 5, null, 8]
  );
  assert.deepEqual(
    turn.items.map((item) => item.sequence),
    [0, 1, 2, 3, 4, 5]
  );
  assert.equal(turn.items[1].aggregatedOutput, 'new warning');
  assert.equal(turn.items[2].aggregatedOutput, 'listen EPERM');
  assert.deepEqual(turn.items[3].review, { status: 'approved', rationale: 'Local temporary server.' });
  assert.equal(turn.permissionDecisions, 'recorded');
  assert.equal(turn.items[4].result.error, 'fixture mismatch');
  assert.equal(turn.items[5].content[0].text, 'checks passed');
});

test('retrospective exports mark missing timing, ownership, tool results, and permission decisions', () => {
  const attempts = ['first', 'second'].map((id) => ({ id, result: { threadId: 'thread' } }));
  const exported = exportRetroThread(
    'thread',
    {
      turns: [
        {
          id: 'turn',
          items: [
            { id: 'pending', type: 'commandExecution', command: 'node check.mjs', status: 'inProgress' },
            { id: 'approval', type: 'autoApprovalReview', review: { status: 'inProgress' } },
            { id: 'reason', type: 'reasoning', text: 'private reasoning' },
            { id: 'unknown', type: 'futureTool', payload: 'unsupported' },
          ],
        },
      ],
    },
    attempts
  );
  const turn = exported.turns[0];
  assert.deepEqual(exported.attemptIds, ['first', 'second']);
  assert.deepEqual(turn.attemptIds, []);
  assert.equal(turn.attemptAssociation, 'unavailable');
  assert.equal(turn.startedAt, null);
  assert.equal(turn.permissionDecisions, 'unavailable');
  assert.equal(turn.items[0].outcomeAvailability, 'unavailable');
  assert.equal(turn.items[2].text, undefined);
  assert.equal(turn.items[3].payload, undefined);
  assert.ok(turn.items[3].unavailable);
});

test('retrospective exports redact tool arguments, outcomes, and unavailable diagnostics', () => {
  const exported = exportRetroThread('thread', {
    turns: [
      {
        items: [
          {
            type: 'dynamicToolCall',
            arguments: { text: 'Bearer test-secret-value' },
            content: [{ text: 'api_key=private-key' }],
          },
        ],
      },
    ],
  });
  assert.equal(exported.turns[0].items[0].arguments.text, 'Bearer [redacted]');
  assert.equal(exported.turns[0].items[0].content[0].text, 'api_key=[redacted]');
  const unavailable = exportRetroThread(
    'thread',
    null,
    [{ id: 'attempt', result: { threadId: 'thread' } }],
    'History unavailable'
  );
  assert.equal(unavailable.unavailable, true);
  assert.equal(unavailable.unavailableReason, 'History unavailable');
  assert.deepEqual(unavailable.attemptIds, ['attempt']);
  assert.equal(exportRetroThread('thread', null, [], 'Bearer hidden-value').unavailableReason, 'Bearer [redacted]');
});

test('retrospective exports retain archived public messages and separate call outputs', () => {
  const exported = exportRetroThread('thread', {
    turns: [
      {
        items: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'Checking.' },
              { type: 'reasoning_text', text: 'private' },
            ],
          },
          {
            type: 'function_call',
            call_id: 'call',
            name: 'exec',
            arguments: '{"cmd":"check"}',
            timestamp: '2026-11-21T15:35:00Z',
          },
          { type: 'function_call_output', call_id: 'call', output: 'passed', timestamp: '2026-11-21T15:35:01Z' },
          { type: 'message', role: 'system', content: [{ type: 'text', text: 'private instructions' }] },
        ],
      },
    ],
  });
  const items = exported.turns[0].items;
  assert.deepEqual(items[0].content, [{ type: 'output_text', text: 'Checking.' }]);
  assert.equal(items[1].call_id, items[2].call_id);
  assert.equal(items[2].output, 'passed');
  assert.equal(items[3].content, undefined);
});
