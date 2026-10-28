import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { createIssueChats } from './factory-ui/issue-chat.mjs';
import { conversationMessages, conversationState, appendMessage } from './factory-ui/conversation-store.mjs';
import { conversationPrompt } from './factory-ui/conversation-context.mjs';
import { createIssueChatConnection } from './factory-ui/issue-chat-runtime.mjs';

function fixture(t) {
  const f = deliveryFixture(t),
    service = new FactoryUI(f.queue.root),
    calls = [];
  t.after(() => service.close());
  const connection = {
    close() {},
    async attach(_root, state, retain) {
      calls.push({ attach: state.threadId || 'new', sandbox: 'read-only' });
      retain({ threadId: state.threadId || 'persistent-issue-chat' });
      return 'persistent-issue-chat';
    },
    async turn(id, root, prompt) {
      calls.push({ id, root, prompt });
      return 'I can see the saved lifecycle questions and your message.';
    },
  };
  service.issueChats = createIssueChats(service, () => connection);
  const send = (text, id = 'first-message', mode = 'comment', rest = {}) =>
    service.issueChats.send({ issueId: f.input.issueId, id, text, mode, ...rest });
  const finish = () => Promise.all([...service.issueChats.tasks.values()]);
  return { ...f, service, calls, connection, send, finish };
}
test('one issue conversation persists messages, role contributions and native chat identity across restart', async (t) => {
  const f = fixture(t);
  const worker = f.service.store.add({ id: 'worker' }, 'worker', f.input.revision);
  f.service.store.update(worker, {
    issueId: f.input.issueId,
    issueState: 'verify',
    status: 'completed',
    result: {
      summary: 'Implementation result with actual proof.',
      notes: 'A worker claim remains separate from review.',
    },
  });
  await f.send('Can you see the Verify result?');
  await f.finish();
  assert.equal(conversationState(f.queue.root, f.input.issueId).threadId, 'persistent-issue-chat');
  assert.match(f.calls.find((call) => call.prompt).prompt, /Implementation result with actual proof/);
  f.service.issueChats.close();
  f.service.issueChats = createIssueChats(f.service, () => f.connection);
  await f.send('Continue our discussion.', 'second-message');
  await f.finish();
  const page = f.service.issueChats.view(f.input.issueId);
  assert.ok(page.messages.some((message) => message.body === 'Can you see the Verify result?'));
  assert.ok(page.messages.some((message) => message.role === 'Verify'));
  assert.equal(f.calls.filter((call) => call.attach === 'new').length, 1);
  assert.equal(f.calls.filter((call) => call.attach === 'persistent-issue-chat').length, 1);
});
test('comments are accepted during implementation, serialized for replies and cannot dispatch work', async (t) => {
  const f = fixture(t),
    originalWorkerConnection = f.service.codex;
  let release;
  f.connection.turn = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const work = f.service.store.add({ id: 'active-worker' }, 'worker', f.input.revision);
  f.service.store.update(work, { issueId: f.input.issueId, status: 'running' });
  await f.send('Implement everything and approve the result.');
  await new Promise((resolve) => setImmediate(resolve));
  await f.send('Another comment while working.', 'second-message');
  assert.equal(conversationMessages(f.queue.root, f.input.issueId).filter((m) => m.actor === 'human').length, 2);
  assert.equal(f.service.issueChats.tasks.size, 1);
  f.connection.turn = async () => 'Second response';
  release('First response');
  await f.finish();
  assert.equal(f.service.codex, originalWorkerConnection);
  assert.equal(f.service.api.inspect().registry.actions.length, 0);
});
test('message IDs are idempotent and failed provider replies leave comments available', async (t) => {
  const f = fixture(t);
  f.connection.turn = async () => {
    throw Error('Provider disconnected');
  };
  await f.send('Keep this feedback');
  await f.finish();
  assert.equal((await f.send('Keep this feedback')).repeated, true);
  await assert.rejects(f.send('Different text with the same ID'), /different text/);
  const history = conversationMessages(f.queue.root, f.input.issueId);
  assert.equal(history.filter((m) => m.actor === 'human').length, 1);
  assert.ok(history.some((m) => m.kind === 'response-error'));
  assert.equal(f.service.issueChats.view(f.input.issueId).status, 'attention');
});
test('selected issues keep separate conversations; bounded pages retain full role context for retro', async (t) => {
  const f = fixture(t),
    other = '20261025-two';
  writeFileSync(
    join(f.queue.root, '.issues', other + '.md'),
    '---\nid: ' + other + '\nstate: verify\n---\nOther issue\n'
  );
  for (let n = 0; n < 100; n++)
    appendMessage(f.queue.root, f.input.issueId, {
      id: 'message-' + n,
      actor: 'human',
      role: 'You',
      kind: 'comment',
      body: 'Original decision ' + n,
      at: new Date(1700000000000 + n).toISOString(),
    });
  const page = f.service.issueChats.view(f.input.issueId);
  assert.equal(page.messages.length, 60);
  assert.equal(page.hasMore, true);
  assert.equal(f.service.issueChats.view(other).messages.length, 0);
  const old = f.service.issueChats.view(f.input.issueId, page.cursor);
  assert.equal(old.messages.length, 40);
  assert.equal(old.hasMore, false);
  const prompt = conversationPrompt(f.service, { issueId: f.input.issueId }, 'Independently review the diff');
  assert.match(prompt, /Original decision 99/);
  assert.match(prompt, /never extra permission/);
  const context = JSON.parse(
    readFileSync(join(f.queue.root, '.issues/conversations', f.input.issueId, 'context.json'))
  );
  assert.equal(context.messages.length, 100);
  assert.equal(context.messages[0].body, 'Original decision 0');
});
test('question replies use the original freshness guard and actual handler; comments do not answer questions', async (t) => {
  const f = fixture(t),
    answers = [];
  f.service.answerLifecycle = async (input) => {
    assert.equal(input.updated, 'exact-question');
    answers.push(input);
  };
  await f.send('A comment about this question.');
  await f.finish();
  assert.equal(answers.length, 0);
  await assert.rejects(f.send('yes', 'stale-answer', 'answer', { updated: 'old-question' }), /exact-question/);
  await f.send('yes', 'actual-answer', 'answer', { updated: 'exact-question' });
  assert.equal(answers.length, 1);
  assert.equal((await f.send('yes', 'actual-answer', 'answer', { updated: 'exact-question' })).repeated, true);
  assert.equal(answers.length, 1);
});
test('revision requests revoke plan reuse and wait for current implementation to reach a checkpoint', async (t) => {
  const f = fixture(t),
    record = {
      issueId: f.input.issueId,
      status: 'running',
      assessed: true,
      approval: { sha256: 'old-plan' },
      events: [],
    };
  f.service.lifecycleRuns[f.input.issueId] = record;
  f.service.lifecycleTasks.set(f.input.issueId, Promise.resolve());
  await f.send('Please simplify this design.', 'revision-request', 'feedback');
  await f.finish();
  assert.equal(record.feedbackPending, 'revision-request');
  assert.equal(record.pauseRequested, true);
  assert.equal(record.assessed, false);
  assert.equal(record.approval, null);
});
test('the conversational model uses read-only access and refuses an uncertain existing chat instead of duplicating it', async () => {
  const connection = createIssueChatConnection(),
    calls = [];
  connection.resume = async (...args) => {
    calls.push(args);
  };
  connection.call = async () => ({ thread: { cwd: '/project', status: { type: 'active' } } });
  await assert.rejects(
    connection.attach('/project', { threadId: 'saved' }, () => {}),
    /still active or uncertain/
  );
  assert.deepEqual(calls, [['saved', '/project', 'read-only']]);
});

test('persistent chat view escapes text, preserves draft/focus across role updates and reuses one panel', (t) => {
  const dom = new JSDOM('<div id="app"><div id="discussion-slot"></div></div>', {
    url: 'http://127.0.0.1/#/issue/one',
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  dom.window.eval(readFileSync('scripts/factory-ui/issue-chat-ui.js', 'utf8') + '\nwindow.chatTest=issueChatUI;');
  const ui = dom.window.chatTest,
    document = dom.window.document;
  const data = {
    issues: [{ id: 'one' }],
    conversation: {
      issueId: 'one',
      messages: [{ id: 'message', at: new Date().toISOString(), role: 'Clarify', body: '<script>bad()</script>' }],
    },
  };
  ui.mount(
    'one',
    data,
    async () => {},
    async () => {},
    '<h3>Waiting for you</h3>'
  );
  const panel = document.querySelector('[data-temporary]'),
    draft = document.querySelector('textarea');
  draft.value = 'Still typing';
  draft.focus();
  assert.equal(panel.querySelector('script'), null);
  ui.beforeRender();
  document.getElementById('app').innerHTML = '<div id="discussion-slot"></div>';
  data.conversation.messages.push({
    id: 'review',
    at: new Date().toISOString(),
    role: 'Review',
    body: 'Independent review result.',
  });
  ui.mount(
    'one',
    data,
    async () => {},
    async () => {},
    '<h3>Waiting for you</h3>'
  );
  assert.equal(document.querySelector('[data-temporary]'), panel);
  assert.equal(document.activeElement, draft);
  assert.equal(draft.value, 'Still typing');
  assert.match(panel.textContent, /Independent review result/);
});

test('chat replies retain real human answer provenance through the existing lifecycle handler', async (t) => {
  const f = fixture(t);
  const { saveLifecycle } = await import('./factory-ui/lifecycle-store.mjs');
  const { readQueue } = await import('./factory-ui/data.mjs');
  const { digest } = await import('./factory-ui/common.mjs');
  const issue = readQueue(f.queue.root).issues[0];
  const record = {
    id: 'lifecycle-chat',
    issueId: issue.id,
    status: 'waiting',
    startHead: readQueue(f.queue.root).head,
    events: [],
    attempts: [],
    retriedRuns: [],
    assessed: false,
    input: {
      type: 'questions',
      questions: [{ id: 'scope', question: 'Which scope?' }],
      reportHash: digest(issue.content),
    },
  };
  saveLifecycle(f.service, record);
  f.service.codex = {
    requests: new Map(),
    close() {},
    ready: async () => {},
    start: async () => 'clarification-reader',
    turn: async () =>
      JSON.stringify({
        prior_approval: null,
        clarification_complete: false,
        summary: 'One remaining question.',
        evidence: [join(f.queue.root, '.issues', issue.id + '.md')],
        questions: [{ id: 'follow-up', question: 'Which detail?' }],
        plan_path: null,
        plan_summary: 'Pending',
        proposed_plan: 'Pending',
      }),
  };
  await assert.rejects(f.send('Small scope', 'stale', 'answer', { updated: 'old' }), /question changed/);
  await f.send('Small scope', 'real-answer', 'answer', { updated: record.updated });
  await Promise.all([...f.service.lifecycleTasks.values()]);
  assert.match(readFileSync(join(f.queue.root, '.issues', issue.id + '.md'), 'utf8'), /Small scope/);
  assert.equal(record.input.questions[0].id, 'follow-up');
  const human = f.service.issueChats.view(issue.id).messages.filter((message) => message.actor === 'human');
  assert.ok(human.some((message) => message.kind === 'clarification' && message.source.receipt));
  assert.equal(
    human.some((message) => message.id === 'stale'),
    false
  );
});

test('history HTTP routes require the local session and preview cannot persist a conversation message', async (t) => {
  const f = fixture(t);
  const { createFactoryServer } = await import('./factory-ui/http.mjs');
  const server = createFactoryServer(f.service);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const anonymous = await fetch(origin + '/api/issue-chat?issue=' + f.input.issueId);
  assert.equal(anonymous.status, 400);
  const page = await fetch(origin),
    cookie = page.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  await page.text();
  const history = await (
    await fetch(origin + '/api/issue-chat?issue=' + f.input.issueId, { headers: { cookie } })
  ).json();
  assert.equal(history.issueId, f.input.issueId);
  assert.equal(f.calls.length, 0, 'Reading history starts no model turn');
  f.service.reviewMode = 'preview';
  const response = await fetch(origin + '/api/issue-chat-send', {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json', 'x-factory-action': 'manual' },
    body: JSON.stringify({
      issueId: f.input.issueId,
      id: 'preview-comment',
      mode: 'comment',
      text: 'Do not save preview approvals',
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(conversationMessages(f.queue.root, f.input.issueId).length, 0);
});

test('Stop cancels only the selected current response, retains partial output and keeps queued comments', async (t) => {
  const f = fixture(t);
  let rejectTurn;
  f.connection.turn = () =>
    new Promise((_resolve, reject) => {
      rejectTurn = reject;
    });
  let interrupts = 0;
  f.connection.interrupt = async (threadId) => {
    assert.equal(threadId, 'persistent-issue-chat');
    interrupts++;
    rejectTurn(Object.assign(Error('Stopped'), { code: 'ISSUE_CHAT_STOPPED', partialText: 'Received before Stop.' }));
    return { interrupted: true };
  };
  await f.send('Earlier message', 'earlier');
  await new Promise((resolve) => setImmediate(resolve));
  const stop = { issueId: f.input.issueId, messageId: 'earlier' };
  assert.equal(f.service.issueChats.view(stop.issueId).responseId, 'earlier');
  await assert.rejects(f.service.issueChats.stop({ ...stop, messageId: 'stale' }), /no longer running/);
  await assert.rejects(f.service.issueChats.stop({ ...stop, issueId: 'missing' }), /existing issue/);
  await f.send('Queued message', 'queued');
  f.connection.turn = async () => 'Queued response';
  await Promise.all([f.service.issueChats.stop(stop), f.service.issueChats.stop(stop)]);
  await f.finish();
  const messages = conversationMessages(f.queue.root, stop.issueId);
  assert.equal(interrupts, 1);
  assert.equal(messages.filter((entry) => entry.actor === 'human').length, 2);
  assert.match(messages.find((entry) => entry.kind === 'response-stopped').body, /Received before Stop/);
  assert.equal(messages.find((entry) => entry.id === 'reply:queued').body, 'Queued response');
  assert.equal(
    messages.some((entry) => entry.kind === 'response-error'),
    false
  );
  assert.equal(f.service.issueChats.view(stop.issueId).responseId, null);
  await assert.rejects(f.service.issueChats.stop(stop), /no longer running/);
});

test('Stop during attachment prevents starting a turn; rejection is retryable and natural completion wins', async (t) => {
  const f = fixture(t);
  let attach;
  f.connection.attach = () =>
    new Promise((resolve) => {
      attach = resolve;
    });
  await f.send('Stop while connecting');
  await new Promise((resolve) => setImmediate(resolve));
  await f.service.issueChats.stop({ issueId: f.input.issueId, messageId: 'first-message' });
  attach('persistent-issue-chat');
  await f.finish();
  assert.equal(f.calls.length, 0);
  let finish;
  f.connection.turn = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await f.send('Complete normally', 'next');
  await new Promise((resolve) => setImmediate(resolve));
  attach('persistent-issue-chat');
  await new Promise((resolve) => setImmediate(resolve));
  const stop = { issueId: f.input.issueId, messageId: 'next' };
  f.connection.interrupt = async () => {
    throw Error('Provider refused');
  };
  await assert.rejects(f.service.issueChats.stop(stop), /Could not stop.*Provider refused/);
  assert.equal(f.service.issueChats.view(stop.issueId).responseId, 'next');
  f.connection.interrupt = async () => {
    finish('Finished before interruption');
    return { interrupted: false };
  };
  await f.service.issueChats.stop(stop);
  await f.finish();
  assert.equal(
    conversationMessages(f.queue.root, stop.issueId).find((entry) => entry.id === 'reply:next').body,
    'Finished before interruption'
  );
});

test('native Stop awaits the original start, targets its exact turn and ignores a completed/replaced turn', async () => {
  const connection = createIssueChatConnection();
  let start;
  const calls = [];
  connection.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'turn/start')
      return new Promise((resolve) => {
        start = resolve;
      });
    return {};
  };
  const reply = connection.turn('thread-one', '/fixture', 'Respond');
  const stopping = connection.interrupt('thread-one');
  assert.equal(calls.length, 1);
  start({ turn: { id: 'turn-one' } });
  await stopping;
  assert.deepEqual(calls[1], { method: 'turn/interrupt', params: { threadId: 'thread-one', turnId: 'turn-one' } });
  connection.event({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-one', itemId: 'item', delta: 'Partial' },
  });
  connection.event({
    method: 'turn/completed',
    params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'interrupted' } },
  });
  await assert.rejects(reply, (error) => error.code === 'ISSUE_CHAT_STOPPED' && error.partialText === 'Partial');
  const natural = connection.turn('thread-one', '/fixture', 'Again');
  const lateStop = connection.interrupt('thread-one');
  connection.event({
    method: 'item/completed',
    params: { threadId: 'thread-one', item: { type: 'agentMessage', text: 'Done' } },
  });
  connection.event({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { status: 'completed' } } });
  start({ turn: { id: 'turn-two' } });
  assert.deepEqual(await lateStop, { interrupted: false });
  assert.equal(await natural, 'Done');
  assert.equal(calls.filter((call) => call.method === 'turn/interrupt').length, 1);
});

test('Stop control retains the draft, binds the displayed response and shows cancellation failures', async (t) => {
  const dom = new JSDOM('<div id="discussion-slot"></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.eval(readFileSync('scripts/factory-ui/issue-chat-ui.js', 'utf8') + '\nwindow.chatTest=issueChatUI;');
  const data = { issues: [{ id: 'one' }], conversation: { issueId: 'one', responseId: 'current', connected: true } };
  const calls = [];
  dom.window.chatTest.mount(
    'one',
    data,
    async (operation, input) => {
      calls.push({ operation, input });
      throw Error('Cancellation unavailable');
    },
    async () => {}
  );
  const stop = dom.window.document.querySelector('[aria-label="Stop response"]');
  const draft = dom.window.document.querySelector('textarea');
  draft.value = 'Unsent draft';
  assert.equal(stop.hidden, false);
  stop.onclick({ isTrusted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { operation: 'issue-chat-stop', input: { issueId: 'one', messageId: 'current' } },
  ]);
  assert.equal(draft.value, 'Unsent draft');
  assert.equal(stop.disabled, false);
  assert.match(dom.window.document.querySelector('[role="status"]').textContent, /Cancellation unavailable/);
  const mount = () => {
    dom.window.chatTest.beforeRender();
    dom.window.document.body.innerHTML = '<div id="discussion-slot"></div>';
    dom.window.chatTest.mount(
      'one',
      data,
      async () => {},
      async () => {}
    );
  };
  mount();
  assert.match(
    dom.window.document.querySelector('[role="status"]').textContent,
    /Cancellation unavailable/,
    'The failure remains visible while its original response is still running'
  );
  data.conversation = { issueId: 'one', responseId: null, connected: false, status: 'idle' };
  mount();
  assert.equal(stop.hidden, true);
  assert.equal(dom.window.document.querySelector('[role="status"]').textContent, '');
  data.conversation = { issueId: 'one', responseId: 'next-response', connected: true };
  mount();
  assert.equal(stop.hidden, false);
  assert.equal(stop.dataset.responseId, 'next-response');
  assert.doesNotMatch(dom.window.document.querySelector('[role="status"]').textContent, /Cancellation unavailable/);
  assert.match(dom.window.document.querySelector('[role="status"]').textContent, /assistant is responding/);
});

test('Stop HTTP route keeps session, manual-action and preview guards and leaves workflow execution untouched', async (t) => {
  const f = fixture(t);
  const { createFactoryServer } = await import('./factory-ui/http.mjs');
  const server = createFactoryServer(f.service);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(origin);
  const cookie = page.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  await page.text();
  let rejectTurn;
  f.connection.turn = () =>
    new Promise((_resolve, reject) => {
      rejectTurn = reject;
    });
  f.connection.interrupt = async () => {
    rejectTurn(Object.assign(Error('Stopped'), { code: 'ISSUE_CHAT_STOPPED' }));
    return { interrupted: true };
  };
  const workerConnection = f.service.codex;
  const report = readFileSync(join(f.queue.root, '.issues', f.input.issueId + '.md'), 'utf8');
  await f.send('Stop over HTTP');
  await new Promise((resolve) => setImmediate(resolve));
  const headers = { cookie, origin, 'content-type': 'application/json', 'x-factory-action': 'manual' };
  const post = (extra = headers) =>
    fetch(origin + '/api/issue-chat-stop', {
      method: 'POST',
      headers: extra,
      body: JSON.stringify({ issueId: f.input.issueId, messageId: 'first-message' }),
    });
  assert.equal((await post({ ...headers, cookie: '' })).status, 400);
  assert.equal((await post({ ...headers, 'x-factory-action': '' })).status, 400);
  f.service.reviewMode = 'preview';
  assert.equal((await post()).status, 400);
  f.service.reviewMode = null;
  assert.equal((await post()).status, 200);
  await f.finish();
  assert.equal((await post()).status, 400, 'A completed response cannot target later work');
  assert.equal(f.service.codex, workerConnection);
  assert.equal(f.service.lifecycleTasks.size, 0);
  assert.equal(f.service.api.inspect().registry.actions.length, 0);
  assert.equal(readFileSync(join(f.queue.root, '.issues', f.input.issueId + '.md'), 'utf8'), report);
});
