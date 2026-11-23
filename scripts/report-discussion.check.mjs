import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendMessage, conversationMessages } from './factory-ui/conversation-store.mjs';
import { ProjectDiscuss } from './factory-ui/project-discuss.mjs';
import { reportDiscussionAction, reportDiscussionView } from './factory-ui/report-discussion.mjs';

function fixture(t, provider) {
  const root = mkdtempSync(join(tmpdir(), 'timey-report-discussion-'));
  const calls = [];
  const discuss = new ProjectDiscuss(
    { root, ownServer() {} },
    {
      modelSettings: () => ({
        defaults: { model: 'fixture', effort: 'high' },
        models: [{ id: 'fixture' }],
        efforts: ['high'],
      }),
      createProvider: () => ({
        async turn(session, message, controls) {
          calls.push(message);
          return provider ? provider(session, message, controls, calls.length) : { text: 'Answer', suggestion: '' };
        },
        close() {},
      }),
    }
  );
  t.after(() => {
    discuss.close();
    rmSync(root, { recursive: true, force: true });
  });
  const investigations = {
    sessions: new Map([
      [
        'old-session',
        {
          id: 'old-session',
          issueId: 'archived-investigation',
          attemptId: 'run-one',
          messages: [
            { role: 'user', text: 'Original question', at: '2026-11-20T10:00:00Z' },
            { role: 'assistant', text: 'Original findings', at: '2026-11-20T10:01:00Z' },
          ],
        },
      ],
    ]),
  };
  const report = {
    id: 'report-one',
    title: 'Retained report',
    publishedAt: '2026-11-20T11:00:00Z',
    source: { issueId: 'archived-investigation', attemptId: 'run-one', revision: '1'.repeat(40) },
    attemptId: 'output-one',
    content: 'Immutable report content',
    evidence: [],
  };
  return {
    root,
    calls,
    discuss,
    investigations,
    report,
    action: (input, selected = report) => reportDiscussionAction(discuss, investigations, selected, input),
  };
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected the report conversation operation to finish.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('archived investigation reports share actual history and remain separate from project conversations', async (t) => {
  const f = fixture(t);
  assert.equal(reportDiscussionView(f.discuss, f.report).selected, null);
  assert.equal(f.calls.length, 0, 'Reading creates no turn.');
  const first = (await f.action({ action: 'create' })).selected;
  assert.deepEqual(
    first.messages.map(({ text }) => text),
    ['Original question', 'Original findings']
  );
  assert.equal((await f.action({ action: 'create' })).selected.id, first.id);
  assert.equal(f.discuss.view().selected, null);
  assert.throws(() => f.discuss.view(first.id), /belonging to this workspace/);
  await f.action({ action: 'send', clientId: 'first-message', text: 'Discuss the archived report.' });
  await until(() => f.calls.length === 1 && f.discuss.read(first.id).status === 'idle');
  assert.equal(f.calls[0].reportContext.reportId, f.report.id);
  const second = { ...f.report, id: 'report-two', source: { ...f.report.source, attemptId: 'run-two' } };
  await f.action({ action: 'send', clientId: 'second-message', text: 'Discuss the next report.' }, second);
  await until(() => f.calls.length === 2 && f.discuss.read(first.id).status === 'idle');
  assert.equal(f.calls[1].reportContext.reportId, second.id);
  assert.equal(
    conversationMessages(f.root, f.report.source.issueId).find(({ id }) => id === 'first-message').reportContext
      .reportId,
    f.report.id
  );
  assert.equal(
    conversationMessages(f.root, f.report.source.issueId).find(({ replyTo }) => replyTo === 'first-message').body,
    'Answer'
  );
  const saved = f.discuss.read(first.id);
  assert.equal(saved.messages.find(({ id }) => id === 'first-message').reportContext.reportId, f.report.id);
  assert.equal(saved.messages.find(({ replyTo }) => replyTo === 'first-message').reportContext.reportId, f.report.id);
  assert.equal(f.investigations.sessions.size, 1, 'Discussion starts no investigation run.');
});

test('retry after switching reports preserves the original report context', async (t) => {
  const f = fixture(t, async (_session, _message, _controls, number) => {
    if (number === 1) throw Error('Fixture failure');
    return { text: 'Recovered', suggestion: '' };
  });
  const session = (await f.action({ action: 'create' })).selected;
  await f.action({ action: 'send', clientId: 'original', text: 'Original report question' });
  await until(() => f.discuss.read(session.id).messages.at(-1).status === 'failed');
  const other = { ...f.report, id: 'other-report' };
  await f.action({ action: 'retry', messageId: 'original', clientId: 'retry' }, other);
  await until(() => f.calls.length === 2 && f.discuss.read(session.id).messages.at(-1).status === 'completed');
  assert.equal(f.calls[1].reportContext.reportId, f.report.id);
  assert.equal(f.discuss.read(session.id).messages.filter(({ status }) => status === 'historical').length, 2);
});

test('ordinary flow conversation messages remain available as later inquiries finish', async (t) => {
  const f = fixture(t);
  f.investigations.sessions.clear();
  appendMessage(f.root, f.report.source.issueId, {
    id: 'ordinary-user',
    actor: 'human',
    role: 'You',
    kind: 'flow-block-request',
    body: 'Investigate the current branch.',
    blockId: 'investigate',
  });
  appendMessage(f.root, f.report.source.issueId, {
    id: 'ordinary-result',
    actor: 'agent',
    role: 'Investigate',
    kind: 'flow-block-result',
    body: 'Observed inquiry findings.',
    blockId: 'investigate',
    source: { attemptId: 'run-one' },
  });
  const first = (await f.action({ action: 'create' })).selected;
  assert.deepEqual(
    first.messages.map(({ id }) => id),
    ['ordinary-user', 'ordinary-result']
  );
  appendMessage(f.root, f.report.source.issueId, {
    id: 'later-result',
    actor: 'agent',
    role: 'Investigate',
    kind: 'flow-block-result',
    body: 'Later inquiry findings.',
    source: { attemptId: 'run-two' },
  });
  const returned = reportDiscussionView(f.discuss, f.report).selected;
  assert.equal(returned.messages.length, 3);
  assert.equal(returned.messages.at(-1).investigationContext.source.attemptId, 'run-two');
  assert.equal(reportDiscussionView(f.discuss, f.report).selected.messages.length, 3);
  assert.equal(f.calls.length, 0, 'Importing retained history starts no model turn.');
});
