import { localNotesBrowserChecks } from './flow-browser-local-notes.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDiscuss } from './factory-ui/project-discuss.mjs';

const choices = {
  defaults: { model: 'model-a', effort: 'high' },
  models: [
    { id: 'model-a', name: 'A' },
    { id: 'model-b', name: 'B' },
  ],
  efforts: ['high', 'low'],
};
async function until(read, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Expected conversation state was not reached.');
}
function fixture(t, turn) {
  const root = mkdtempSync(join(tmpdir(), 'timey-project-discuss-'));
  const calls = [];
  let stopped = 0;
  const provider = {
    async turn(session, message, controls) {
      calls.push({ session, message, controls });
      return turn ? turn(session, message, controls, calls.length) : { text: 'Reply', suggestion: 'What next?' };
    },
    async stop() {
      stopped++;
    },
    async steer() {},
    async answer() {},
    async skills() {
      return [];
    },
    close() {},
  };
  const service = { root, ownServer() {}, serverControl: { allow() {} } };
  const options = { modelSettings: () => choices, createProvider: () => provider };
  const discuss = new ProjectDiscuss(service, options);
  t.after(() => {
    discuss.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, service, options, discuss, calls, provider, stopped: () => stopped };
}

test('project conversations are idle on read, create is idempotent, and histories are independent', async (t) => {
  const f = fixture(t);
  assert.equal(f.discuss.view().selected, null);
  const first = (await f.discuss.action({ action: 'create', requestId: 'first' })).selected;
  assert.equal((await f.discuss.action({ action: 'create', requestId: 'first' })).selected.id, first.id);
  const second = (await f.discuss.action({ action: 'create', requestId: 'second' })).selected;
  assert.notEqual(first.id, second.id);
  await f.discuss.action({ action: 'draft', conversationId: first.id, draft: { text: 'Preserved draft' } });
  assert.equal(f.discuss.view(first.id).selected.draft.text, 'Preserved draft');
  assert.equal(f.discuss.view(second.id).selected.draft.text, '');
  const note = (await f.discuss.prepareNote({ id: 'keep', text: 'Keep this thought', issueId: 'linked-issue' }))
    .selected;
  const ownership = { kind: 'investigation', issueId: 'linked-issue' };
  const report = (await f.discuss.action({ action: 'create' }, { ownership })).selected;
  assert.deepEqual(new Set(f.discuss.view().conversations.map(({ id }) => id)), new Set([first.id, second.id]));
  assert.equal(f.discuss.view(note.id).selected.noteContext.id, 'keep');
  assert.equal(f.discuss.view(report.id, ownership).selected.id, report.id);
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    () => f.discuss.action({ action: 'settings', conversationId: '../escape', settings: {} }),
    /valid project/
  );
});

test('queued edits freeze settings, retain attachments, and dispatch one response at a time', async (t) => {
  const held = Promise.withResolvers();
  const f = fixture(t, async (_session, message, { event }, number) => {
    event({ method: 'item/agentMessage/delta', params: { delta: 'Live partial' } });
    if (number === 1) await held.promise;
    return { text: 'Reply to ' + message.text, suggestion: 'Next question' };
  });
  const id = (await f.discuss.action({ action: 'create' })).selected.id;
  const send = (clientId, text, extra = {}) =>
    f.discuss.action({ action: 'send', conversationId: id, clientId, text, ...extra });
  await send('first', 'First');
  await until(
    () => f.calls.length,
    (n) => n === 1
  );
  await send('second', 'Second', {
    attachments: [{ name: 'note.txt', mime: 'text/plain', data: Buffer.from('Original contents').toString('base64') }],
  });
  await send('second', 'Second');
  assert.equal(f.discuss.read(id).queue.length, 1);
  await f.discuss.action({ action: 'settings', conversationId: id, settings: { model: 'model-b', effort: 'low' } });
  assert.equal(f.discuss.read(id).queue[0].settings.model, 'model-a');
  await f.discuss.action({
    action: 'edit-queued',
    conversationId: id,
    messageId: 'second',
    text: 'Edited second',
    settings: { model: 'model-b', effort: 'low' },
  });
  const queued = f.discuss.read(id).queue[0];
  assert.equal(readFileSync(queued.attachments[0].path, 'utf8'), 'Original contents');
  assert.equal(f.discuss.view(id).selected.queue[0].attachments[0].path, undefined);
  assert.match(f.discuss.view(id).selected.messages.at(-1).text, /Live partial/);
  held.resolve();
  await until(
    () => f.discuss.read(id),
    (s) => s.messages.filter((m) => m.role === 'assistant' && m.status === 'completed').length === 2
  );
  assert.equal(f.calls[0].message.settings.model, 'model-a');
  assert.equal(f.calls[1].message.settings.model, 'model-b');
  assert.equal(f.calls[1].message.text, 'Edited second');
  assert.equal(f.discuss.read(id).queue.length, 0);
});

test('Stop retains partial output and queue; Retry uses original settings and retains previous attempts', async (t) => {
  const f = fixture(t, async (_session, _message, { event, signal }, number) => {
    event({ method: 'item/agentMessage/delta', params: { delta: 'Kept partial' } });
    if (number === 1)
      await new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(Error('Stopped')), { once: true })
      );
    return { text: 'Retried response', suggestion: '' };
  });
  const id = (await f.discuss.action({ action: 'create' })).selected.id;
  await f.discuss.action({ action: 'send', conversationId: id, clientId: 'original', text: 'Original request' });
  await until(
    () => f.calls.length,
    (n) => n === 1
  );
  await f.discuss.action({ action: 'send', conversationId: id, clientId: 'queued', text: 'Waiting' });
  await f.discuss.action({ action: 'stop', conversationId: id });
  await until(
    () => f.discuss.read(id),
    (s) => s.status === 'paused' && !s.activeMessageId
  );
  assert.equal(f.stopped(), 1);
  assert.equal(f.discuss.read(id).messages.at(-1).text, 'Kept partial');
  assert.equal(f.discuss.read(id).queue.length, 1);
  await f.discuss.action({ action: 'settings', conversationId: id, settings: { model: 'model-b' } });
  await f.discuss.action({ action: 'remove-queued', conversationId: id, messageId: 'queued' });
  await f.discuss.action({ action: 'retry', conversationId: id, messageId: 'original', clientId: 'retry' });
  await until(
    () => f.discuss.read(id),
    (s) => s.messages.at(-1).status === 'completed'
  );
  assert.equal(f.calls[1].message.settings.model, 'model-a');
  assert.equal(f.discuss.read(id).messages.filter((m) => m.role === 'assistant').length, 2);
});

test('reopening an interrupted saved conversation never silently dispatches another turn', async (t) => {
  const f = fixture(t);
  const id = (await f.discuss.action({ action: 'create' })).selected.id;
  f.discuss.change(id, (s) => {
    s.activeMessageId = 'unknown-turn';
    s.status = 'running';
  });
  const reopened = new ProjectDiscuss(f.service, f.options);
  t.after(() => reopened.close());
  assert.equal(reopened.view(id).selected.status, 'interrupted');
  assert.equal(f.calls.length, 0);
  await assert.rejects(() => reopened.action({ action: 'resume', conversationId: id }), /Retry the interrupted/);
});

test('reading Discuss in a new or preview project creates no settings or conversation files', (t) => {
  const f = fixture(t);
  f.service.reviewMode = 'preview';
  const discuss = new ProjectDiscuss(f.service);
  t.after(() => discuss.close());
  assert.equal(discuss.view().selected, null);
  assert.deepEqual(readdirSync(f.root), []);
});

test('a new message after failure uses current settings before older queued messages', async (t) => {
  const f = fixture(t, async (_session, message) => {
    if (message.settings.clarificationSkill !== 'none') throw Error('Missing clarification skill');
    return { text: 'Recovered', suggestion: '' };
  });
  const id = (await f.discuss.action({ action: 'create' })).selected.id;
  await f.discuss.action({
    action: 'send',
    conversationId: id,
    clientId: 'failed',
    text: 'First',
    settings: { clarificationSkill: 'grilling' },
  });
  await until(
    () => f.discuss.read(id),
    (s) => s.status === 'paused' && !s.activeMessageId
  );
  f.discuss.change(id, (s) => s.queue.push({ ...s.messages[0], id: 'older', status: 'queued' }));
  assert.equal(f.discuss.view(id).selected.queue.length, 1);
  assert.equal(f.calls.length, 1, 'Reading a failed chat must not restart it');
  await f.discuss.action({
    action: 'send',
    conversationId: id,
    clientId: 'fresh',
    text: 'Continue without grilling',
    settings: { clarificationSkill: 'none' },
  });
  await until(
    () => f.calls.length,
    (n) => n >= 2
  );
  assert.equal(f.calls[1].message.id, 'fresh');
  await until(
    () => f.discuss.read(id),
    (s) => !s.activeMessageId
  );
  const saved = f.discuss.read(id);
  assert.equal(saved.messages.find((m) => m.replyTo === 'failed').status, 'failed');
  assert.equal(saved.messages.find((m) => m.replyTo === 'fresh').text, 'Recovered');
  assert.ok(saved.messages.some((m) => m.id === 'older') || saved.queue.some((m) => m.id === 'older'));
});

test('Add skill opens the chat Markdown extension without creating or starting a conversation', async (t) => {
  const f = fixture(t);
  const opened = [];
  f.options.openFile = async (path) => opened.push(path);
  const result = await f.discuss.action({ action: 'open-skill-extension' });
  assert.equal(result.selected, null);
  assert.deepEqual(opened, [join(f.root, 'user/chat/grilling.md')]);
  assert.match(readFileSync(opened[0], 'utf8'), /# Skill list/);
  assert.equal(f.calls.length, 0);
});

test('the Notes browser handoff saves an outgoing Discuss draft before replacing its model fixture', async (t) => {
  const f = fixture(t);
  const session = (await f.discuss.action({ action: 'create', settings: { model: 'model-b' } })).selected;
  f.service.projectDiscuss = f.discuss;
  f.service.projectDiscussOptions = f.options;
  const navigated = Error('Outgoing page navigation completed');
  const page = {
    locator() {
      return { isVisible: async () => false };
    },
    async goto() {
      const discuss = (f.service.projectDiscuss ||= new ProjectDiscuss(f.service, f.service.projectDiscussOptions));
      await discuss.action({ action: 'settings', conversationId: session.id, settings: { skills: [] } });
      await discuss.action({ action: 'draft', conversationId: session.id, draft: { text: 'Outgoing draft' } });
      throw navigated;
    },
  };
  await assert.rejects(
    localNotesBrowserChecks({ page, project: f.root, service: f.service }),
    (error) => error === navigated
  );
  assert.equal(f.discuss.view(session.id).selected.draft.text, 'Outgoing draft');
});
