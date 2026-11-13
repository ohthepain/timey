import { moveStoredIssue } from './factory-ui/issue-report-storage.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { FactoryUI } from './factory-test-service.mjs';
import { createIssueChats } from './factory-ui/issue-chat.mjs';
import { conversationMessages, conversationState, appendMessage } from './factory-ui/conversation-store.mjs';
import { conversationPrompt } from './factory-ui/conversation-context.mjs';
import { prepareNativeChat, bindNativeChat } from './factory-native-chat.mjs';
import { createIssueChatConnection, attachIssueChat } from './factory-ui/issue-chat-runtime.mjs';
import { CodexConnection } from './factory-ui/codex.mjs';
import { nameIssueChat } from './factory-ui/chat-name.mjs';

function fixture(t) {
  const f = deliveryFixture(t),
    service = new FactoryUI(f.queue.root),
    calls = [];
  t.after(() => service.close());
  const skillPath = join(f.queue.root, 'sample-skill.md');
  writeFileSync(skillPath, 'A sample Codex skill.\n');
  const connection = {
    close() {},
    async ready() {},
    async call(method, args) {
      if (method === 'thread/name/set') {
        calls.push({ name: args.name });
        return {};
      }
      assert.equal(method, 'skills/list');
      return {
        data: [
          { skills: [{ name: 'sample-skill', path: skillPath, enabled: true, shortDescription: 'A sample skill' }] },
          { skills: [{ name: 'retro', path: skillPath, enabled: true, shortDescription: 'Retrospective' }] },
        ],
      };
    },
    async attach(_root, state, retain) {
      calls.push({ attach: state.threadId || 'new', sandbox: 'read-only' });
      retain({ threadId: state.threadId || 'persistent-issue-chat' });
      return 'persistent-issue-chat';
    },
    async turn(id, root, prompt, schema, skills) {
      calls.push({ id, root, prompt, schema, skills });
      if (schema?.properties?.recommendations)
        return JSON.stringify({ summary: 'No follow-up needed.', recommendations: [] });
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
  assert.match(f.calls.find((call) => call.prompt).prompt, /For this discussion turn only/);
  assert.match(
    f.calls.find((call) => call.prompt).prompt,
    /this discussion restriction does not apply to that later assignment/
  );
  f.service.issueChats.close();
  f.service.issueChats = createIssueChats(f.service, () => f.connection);
  await f.send('Continue our discussion.', 'second-message');
  await f.finish();
  const page = f.service.issueChats.view(f.input.issueId);
  assert.ok(page.messages.some((message) => message.body === 'Can you see the Verify result?'));
  assert.ok(page.messages.some((message) => message.role === 'Verify'));
  assert.equal(f.calls.filter((call) => call.attach === 'new').length, 1);
  assert.equal(f.calls.filter((call) => call.attach === 'persistent-issue-chat').length, 1);
  assert.match(f.calls.findLast((call) => call.name)?.name, /^Issue: .* · waiting$/);
});

test('retro on a closed report retains its request and result in the saved issue conversation', async (t) => {
  const f = fixture(t);
  const report = join(f.queue.root, '.issues', f.input.issueId + '.md');
  writeFileSync(report, readFileSync(report, 'utf8').replace(/^state: .*$/m, 'state: closed'));
  moveStoredIssue(f.queue.root, f.input.issueId, 'open', 'closed');
  f.service.codex.ready = async () => {};
  f.service.codex.call = async () => ({
    data: [{ skills: [{ name: 'retro', path: join(f.queue.root, 'sample-skill.md'), enabled: true }] }],
  });
  const result = await f.service.issueChats.retro(f.input.issueId);
  assert.deepEqual(result, { summary: 'No follow-up needed.', recommendations: [] });
  const messages = conversationMessages(f.queue.root, f.input.issueId);
  assert.ok(messages.some((message) => message.kind === 'retro-request'));
  assert.ok(
    messages.some(
      (message) =>
        message.kind === 'discussion-instruction' && message.actor === 'factory' && message.skills?.includes('retro')
    )
  );
  assert.ok(
    messages.some((message) => message.kind === 'retro-result' && message.body.includes('No follow-up needed.'))
  );
  assert.match(f.calls.findLast((call) => call.name)?.name, /^Retro: .* · waiting$/);
  assert.equal(f.calls.filter((call) => call.attach === 'new').length, 1);
  assert.equal(conversationState(f.queue.root, f.input.issueId).threadId, 'persistent-issue-chat');
});

test('execution names the saved issue thread with the role first', async (t) => {
  const f = fixture(t);
  f.service.codex.call = async (_method, args) => {
    f.calls.push({ name: args.name });
    return {};
  };
  const run = f.service.store.add({ id: 'issue-work' }, 'issue-work', f.queue.head);
  f.service.store.update(run, { issueId: f.input.issueId });
  await nameIssueChat(f.service, run, 'persistent-issue-chat');
  assert.match(f.calls.findLast((call) => call.name)?.name, /^Execute: .* · active$/);
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
test('additional messages queue while the issue assistant is responding', async (t) => {
  const f = fixture(t);
  let releaseFirst;
  f.connection.turn = () =>
    new Promise((resolve) => {
      releaseFirst = resolve;
    });
  await f.send('First queued comment', 'first-queued-comment');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.service.issueChats.view(f.input.issueId).responseId, 'first-queued-comment');

  await f.send('Second queued comment', 'second-queued-comment');
  assert.equal(
    conversationMessages(f.queue.root, f.input.issueId).filter((message) => message.actor === 'human').length,
    2
  );
  f.connection.turn = async () => 'Second response';
  releaseFirst('First response');
  await f.finish();

  const messages = conversationMessages(f.queue.root, f.input.issueId);
  assert.equal(messages.find((message) => message.id === 'reply:first-queued-comment').body, 'First response');
  assert.equal(messages.find((message) => message.id === 'reply:second-queued-comment').body, 'Second response');
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
test('selected skills invoke through the issue thread and token-only messages are accepted', async (t) => {
  const f = fixture(t);
  await f.send('', 'skill-only', 'comment', { skills: ['sample-skill'] });
  await f.finish();
  const userMessage = conversationMessages(f.queue.root, f.input.issueId).find(
    (message) => message.id === 'skill-only'
  );
  assert.deepEqual(userMessage.skills, ['sample-skill']);
  assert.deepEqual(f.calls.find((call) => call.prompt).skills, [
    { type: 'skill', name: 'sample-skill', path: join(f.queue.root, 'sample-skill.md') },
  ]);
  assert.equal((await f.send('', 'skill-only', 'comment', { skills: ['sample-skill'] })).repeated, true);
  await assert.rejects(
    f.send('yes', 'answer-with-skill', 'answer', { skills: ['sample-skill'] }),
    /does not accept skill/
  );
  await f.send('', 'unknown-skill', 'comment', { skills: ['unknown'] });
  await f.finish();
  assert.ok(conversationMessages(f.queue.root, f.input.issueId).some((message) => message.kind === 'response-error'));
});
test('slash skill selector filters metadata and inserts a removable read-only composer token', async () => {
  const dom = new JSDOM('<form><textarea></textarea><button type="submit">Send</button></form>', {
    runScripts: 'outside-only',
  });
  dom.window.eval(readFileSync(join(process.cwd(), 'scripts/factory-ui/issue-chat-ui.js'), 'utf8'));
  const form = dom.window.document.querySelector('form'),
    draft = form.querySelector('textarea'),
    skill = { name: 'practice', description: 'Practice timing', source: 'Personal', icon: '✦' },
    composer = dom.window.createSkillComposer(form, draft, async () => ({ skills: [skill] }));
  draft.value = '/practice';
  draft.setSelectionRange(draft.value.length, draft.value.length);
  draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  const option = form.querySelector('[role="option"]');
  assert.match(option.textContent, /practice.*Practice timing.*Personal/);
  draft.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(Array.from(composer.skills()), ['practice']);
  assert.equal(draft.value, '');
  assert.equal(form.querySelector('.skill-chip').textContent, '✦practice×');
  assert.equal(composer.canSubmit(''), true);
  draft.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
  assert.deepEqual(Array.from(composer.skills()), []);
  assert.equal(form.querySelector('.skill-chips').hidden, true);
  dom.window.close();
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
  assert.equal(f.service.issueChats.view(other).messages.length, 1);
  assert.equal(f.service.issueChats.view(other).messages[0].kind, 'original-request');
  const old = f.service.issueChats.view(f.input.issueId, page.cursor);
  assert.equal(old.messages.length, 41);
  assert.equal(old.hasMore, false);
  const prompt = conversationPrompt(f.service, { issueId: f.input.issueId }, 'Independently review the diff');
  assert.match(prompt, /Original decision 99/);
  assert.match(prompt, /never extra permission/);
  const context = JSON.parse(
    readFileSync(join(f.queue.root, '.issues/conversations', f.input.issueId, 'context.json'))
  );
  assert.equal(context.messages.length, 101);
  assert.ok(context.messages.some((message) => message.body === 'Original decision 0'));
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
  const dom = new JSDOM('<div id="app"><div id="issue-chat-slot"></div></div>', {
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
  document.getElementById('app').innerHTML = '<div id="issue-chat-slot"></div>';
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
  const missingSkills = await fetch(origin + '/api/issue-chat-skills?issue=missing-issue', { headers: { cookie } });
  assert.equal(missingSkills.status, 400);
  assert.match((await missingSkills.json()).error, /Select an existing issue/);
  assert.equal((await fetch(origin + '/api/server-status', { headers: { cookie } })).status, 200);
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
  assert.equal(
    messages.some((entry) => entry.id === 'reply:queued'),
    false
  );
  assert.equal(f.service.issueChats.view(stop.issueId).queue.paused, true);
  await f.service.issueChats.control({ issueId: stop.issueId, operation: 'resume' });
  await f.finish();
  assert.equal(
    conversationMessages(f.queue.root, stop.issueId).find((entry) => entry.id === 'reply:queued').body,
    'Queued response'
  );
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
  await f.service.issueChats.control({ issueId: f.input.issueId, operation: 'resume' });
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
  await assert.rejects(reply, (error) => error.terminalStatus === 'interrupted' && error.partialText === 'Partial');
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
  const dom = new JSDOM('<div id="issue-chat-slot"></div>', { runScripts: 'outside-only' });
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
  assert.equal(dom.window.document.querySelector('[aria-label="Send message"]').disabled, false);
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
    dom.window.document.body.innerHTML = '<div id="issue-chat-slot"></div>';
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

test('durable queue retains pause, FIFO, selected skills and edited positions across restart', async (t) => {
  const f = fixture(t),
    id = f.input.issueId;
  await f.service.issueChats.control({ issueId: id, operation: 'pause' });
  await f.send('First', 'fifo-first', 'comment', { skills: ['sample-skill'] });
  await f.send('Remove this', 'fifo-remove');
  await f.send('Third', 'fifo-third');
  f.service.issueChats.close();
  f.service.issueChats = createIssueChats(f.service, () => f.connection);
  const paused = f.service.issueChats.view(id).queue;
  assert.equal(paused.paused, true);
  assert.deepEqual(
    paused.entries.map((entry) => entry.id),
    ['fifo-first', 'fifo-remove', 'fifo-third']
  );
  await assert.rejects(
    f.service.issueChats.control({
      issueId: id,
      operation: 'edit',
      id: 'fifo-first',
      revision: 1,
      text: 'Convert to feedback',
      mode: 'feedback',
    }),
    /without changing prompt type/
  );
  await f.service.issueChats.control({
    issueId: id,
    operation: 'edit',
    id: 'fifo-first',
    revision: 1,
    text: 'First edited',
    mode: 'comment',
    skills: ['retro'],
  });
  await f.service.issueChats.control({ issueId: id, operation: 'remove', id: 'fifo-remove', revision: 1 });
  await f.send('Remove this', 'fifo-remove');
  assert.equal(f.service.issueChats.view(id).queue.entries.length, 2);
  await f.service.issueChats.control({ issueId: id, operation: 'resume' });
  await f.finish();
  const calls = f.calls.filter((call) => call.prompt);
  assert.equal(calls.length, 2);
  assert.match(calls[0].prompt, /Latest prompt: First edited/);
  assert.equal(calls[0].skills[0].name, 'retro');
  assert.match(calls[1].prompt, /Latest prompt: Third/);
  assert.equal(f.service.issueChats.view(id).queue.entries.length, 0);
});

test('two tabs cannot dispatch or mutate a claimed prompt twice', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId;
  let complete;
  f.connection.turn = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  await Promise.all([f.send('One delivery', 'concurrent'), f.send('One delivery', 'concurrent')]);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    f.service.issueChats.control({ issueId, operation: 'remove', id: 'concurrent', revision: 1 }),
    /already dispatching/
  );
  await assert.rejects(
    f.service.issueChats.control({
      issueId,
      operation: 'edit',
      id: 'concurrent',
      revision: 1,
      text: 'Changed',
      mode: 'comment',
    }),
    /already dispatching/
  );
  complete('Delivered once');
  await f.finish();
  assert.equal(conversationMessages(f.queue.root, issueId).filter((entry) => entry.id === 'concurrent').length, 1);
  assert.equal(f.service.issueChats.view(issueId).queue.entries.length, 0);
});

test('lost start acknowledgement reconciles its original structured receipt without another turn', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId;
  let receipt,
    turns = 0;
  f.connection.turn = async (_id, _cwd, _text, _schema, _skills, _settings, options) => {
    turns++;
    receipt = options.clientId;
    throw Error('turn/start response lost');
  };
  await f.send('Reconcile me', 'lost-ack');
  await f.finish();
  assert.equal(f.service.issueChats.view(issueId).queue.entries[0].status, 'uncertain');
  f.service.issueChats.close();
  f.service.issueChats = createIssueChats(f.service, () => f.connection);
  f.service.codex.ready = async () => {};
  f.service.codex.call = async () => ({
    thread: {
      status: { type: 'idle' },
      turns: [
        {
          id: 'original-turn',
          status: 'completed',
          items: [
            { type: 'userMessage', id: 'provider-message', clientId: receipt },
            { type: 'agentMessage', text: 'Original answer' },
          ],
        },
      ],
    },
  });
  await f.service.issueChats.control({ issueId, operation: 'resume' });
  await f.finish();
  assert.equal(turns, 1);
  assert.equal(f.service.issueChats.view(issueId).queue.entries.length, 0);
  assert.equal(
    conversationMessages(f.queue.root, issueId).find((entry) => entry.id === 'reply:lost-ack').body,
    'Original answer'
  );
});

test('Factory yields to user FIFO at its next boundary and Pause preserves the continuation', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId,
    order = [];
  f.connection.turn = async (_id, _cwd, prompt) => {
    order.push(prompt.includes('Latest prompt: First queued') ? 'first' : 'second');
    return 'Answered';
  };
  f.service.lifecycleTasks.set(issueId, Promise.resolve());
  await f.send('First queued', 'boundary-first');
  await f.send('Second queued', 'boundary-second');
  await f.service.issueChats.control({ issueId, operation: 'pause' });
  let advanced = false;
  const operation = f.service.issueChats.runFactoryOperation(
    issueId,
    { id: 'verify-1', kind: 'verification', cancellable: false },
    async () => {
      advanced = true;
      order.push('factory');
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(advanced, false);
  await f.service.issueChats.control({ issueId, operation: 'resume' });
  await operation;
  assert.deepEqual(order, ['first', 'second', 'factory']);
  f.service.lifecycleTasks.delete(issueId);
});

test('merge operation keeps queueing available and offers pause without interrupting GitHub work', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId;
  let finish;
  const operation = f.service.issueChats.runFactoryOperation(
    issueId,
    { id: 'merge-1', kind: 'merge', cancellable: false },
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  await new Promise((resolve) => setImmediate(resolve));
  await f.send('After merge', 'after-merge');
  await f.service.issueChats.control({ issueId, operation: 'pause' });
  await assert.rejects(f.service.issueChats.control({ issueId, operation: 'stop' }), /No confirmed interruptible/);
  const view = f.service.issueChats.view(issueId).queue;
  assert.equal(view.operation.kind, 'merge');
  assert.equal(view.operation.cancellable, false);
  assert.equal(view.entries[0].status, 'waiting');
  finish();
  await operation;
  assert.equal(f.calls.filter((call) => call.prompt).length, 0);
  await f.service.issueChats.control({ issueId, operation: 'resume' });
  await f.finish();
  assert.equal(f.calls.filter((call) => call.prompt).length, 1);
});

test('Steer retains skills and pins the exact current turn while edit and remove lose the claim', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId;
  let finish, steering;
  f.connection.turns = new Map();
  f.connection.turn = async (_thread, _cwd, _prompt, _schema, _skills, _settings, options) => {
    options.accepted({ threadId: 'persistent-issue-chat', turnId: 'current-turn' });
    f.connection.turns.set('persistent-issue-chat', { id: 'current-turn' });
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const originalCall = f.connection.call;
  f.connection.call = async (method, input) => {
    if (method !== 'turn/steer') return originalCall(method, input);
    steering = input;
    return { turnId: input.expectedTurnId };
  };
  await f.send('Working', 'steer-owner');
  await new Promise((resolve) => setImmediate(resolve));
  await f.send('Use this direction', 'steer-prompt', 'comment', { skills: ['sample-skill'] });
  await f.service.issueChats.control({
    issueId,
    operation: 'steer',
    id: 'steer-prompt',
    revision: 1,
    turnId: 'current-turn',
  });
  assert.equal(steering.expectedTurnId, 'current-turn');
  assert.equal(steering.input[1].name, 'sample-skill');
  assert.ok(steering.clientUserMessageId);
  await assert.rejects(
    f.service.issueChats.control({ issueId, operation: 'remove', id: 'steer-prompt', revision: 1 }),
    /already dispatching/
  );
  finish('Done');
  await f.finish();
});

test('Steer losing acknowledgement stays uncertain and never targets a replacement turn', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId;
  f.service.codex.turns = new Map([['factory-thread', { id: 'original-turn' }]]);
  f.service.lifecycleRuns[issueId] = { workThreadId: 'factory-thread' };
  f.service.lifecycleTasks.set(issueId, Promise.resolve());
  let sent,
    calls = 0;
  f.service.codex.ready = async () => {};
  f.service.codex.call = async (method, input) => {
    if (method === 'skills/list') return { data: [] };
    if (method === 'turn/steer') {
      sent = input;
      calls++;
      throw Error('Lost response');
    }
    if (method === 'thread/read')
      return {
        thread: {
          status: { type: 'active' },
          turns: [
            {
              id: 'original-turn',
              status: 'completed',
              items: [{ id: 'received', type: 'userMessage', clientId: sent.clientUserMessageId }],
            },
            { id: 'replacement-turn', status: 'inProgress', items: [] },
          ],
        },
      };
    throw Error(method);
  };
  await f.send('One steer', 'uncertain-steer');
  await assert.rejects(
    f.service.issueChats.control({
      issueId,
      operation: 'steer',
      id: 'uncertain-steer',
      revision: 1,
      turnId: 'original-turn',
    }),
    /Lost response/
  );
  f.service.codex.turns.set('factory-thread', { id: 'replacement-turn' });
  assert.equal(f.service.issueChats.view(issueId).queue.entries[0].status, 'uncertain');
  await f.service.issueChats.control({ issueId, operation: 'resume' });
  assert.equal(calls, 1);
  assert.equal(f.service.issueChats.view(issueId).queue.entries.length, 0);
  f.service.lifecycleTasks.delete(issueId);
});

test('native active-writer rejection holds prompts and exposes unavailable controls', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId;
  f.connection.attach = async () => {
    throw Error('The saved chat already has an active writer');
  };
  await f.send('After native work', 'native-held');
  await f.finish();
  const queue = f.service.issueChats.view(issueId).queue;
  assert.equal(queue.entries[0].status, 'waiting');
  assert.equal(queue.native.status, 'unconfirmed');
  assert.equal(queue.activeTurn, null);
  assert.equal(f.calls.filter((call) => call.prompt).length, 0);
});

test('accepted turn disconnect retains uncertainty and reconciles interrupted partial output', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId;
  let clientId,
    turns = 0;
  f.connection.turn = async (_id, _cwd, _text, _schema, _skills, _settings, receipt) => {
    turns++;
    clientId = receipt.clientId;
    receipt.accepted({ threadId: 'persistent-issue-chat', turnId: 'accepted-turn' });
    throw Error('Connection closed after acceptance');
  };
  await f.send('Keep partial work', 'accepted-disconnect');
  await f.finish();
  assert.equal(f.service.issueChats.view(issueId).queue.entries[0].status, 'uncertain');
  f.service.codex.ready = async () => {};
  f.service.codex.call = async () => ({
    thread: {
      status: { type: 'idle' },
      turns: [
        {
          id: 'accepted-turn',
          status: 'interrupted',
          items: [
            { type: 'userMessage', id: 'original-message', clientId },
            { type: 'agentMessage', text: 'Partial output and retained edits' },
          ],
        },
      ],
    },
  });
  await f.service.issueChats.control({ issueId, operation: 'resume' });
  assert.equal(turns, 1);
  assert.ok(
    conversationMessages(f.queue.root, issueId).some(
      (entry) => entry.kind === 'response-stopped' && entry.body === 'Partial output and retained edits'
    )
  );
});

test('generated discussion instructions retain Factory attribution across queue persistence', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId;
  await f.service.issueChats.control({ issueId, operation: 'pause' });
  await f.send('Generate review', 'generated-review', 'comment', { generated: true });
  const instruction = conversationMessages(f.queue.root, issueId).find((entry) => entry.id === 'generated-review');
  assert.equal(instruction.actor, 'factory');
  assert.equal(instruction.kind, 'discussion-instruction');
  assert.equal(f.service.issueChats.view(issueId).queue.entries[0].generated, true);
});

test('shared Codex owner retains interrupted output through the issue queue', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId;
  const shared = new CodexConnection();
  shared.call = async () => ({ turn: { id: 'shared-turn' } });
  f.connection.turn = (...args) => shared.turn(...args);
  await f.send('Shared work', 'shared-stop');
  await new Promise((resolve) => setImmediate(resolve));
  shared.event({
    method: 'item/agentMessage/delta',
    params: { threadId: 'persistent-issue-chat', itemId: 'partial', delta: 'Shared partial output' },
  });
  shared.event({
    method: 'turn/completed',
    params: { threadId: 'persistent-issue-chat', turn: { id: 'shared-turn', status: 'interrupted' } },
  });
  await f.finish();
  assert.equal(f.service.issueChats.view(issueId).queue.entries.length, 0);
  assert.match(
    conversationMessages(f.queue.root, issueId).find((entry) => entry.id === 'stopped:shared-stop').body,
    /Shared partial output/
  );
});

test('confirmed failed Codex turn preserves partial output as a terminal outcome', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId;
  const shared = new CodexConnection();
  shared.call = async () => ({ turn: { id: 'failed-turn' } });
  f.connection.turn = (...args) => shared.turn(...args);
  await f.send('Work then fail', 'confirmed-failure');
  await new Promise((resolve) => setImmediate(resolve));
  shared.event({
    method: 'item/completed',
    params: {
      threadId: 'persistent-issue-chat',
      item: { id: 'partial', type: 'agentMessage', text: 'Confirmed partial' },
    },
  });
  shared.event({
    method: 'turn/completed',
    params: {
      threadId: 'persistent-issue-chat',
      turn: { id: 'failed-turn', status: 'failed', error: { message: 'Provider failed' } },
    },
  });
  await f.finish();
  assert.equal(f.service.issueChats.view(issueId).queue.entries.length, 0);
  assert.match(
    conversationMessages(f.queue.root, issueId).find((entry) => entry.id === 'failure:confirmed-failure').body,
    /Confirmed partial/
  );
});

test('Factory rechecks pause after waking before claiming its operation', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId;
  const scheduler = f.service.issueChats.scheduler;
  await f.service.issueChats.control({ issueId, operation: 'pause' });
  let started = false;
  const operation = f.service.issueChats.runFactoryOperation(
    issueId,
    { kind: 'verification', id: 'pause-race', cancellable: false },
    async () => {
      started = true;
    }
  );
  scheduler.change(issueId, (queue) => {
    queue.paused = false;
  });
  queueMicrotask(() => scheduler.pause(issueId));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, false);
  assert.equal(f.service.issueChats.view(issueId).queue.operation, null);
  await f.service.issueChats.control({ issueId, operation: 'resume' });
  await operation;
  assert.equal(started, true);
});

test('Factory drains a prompt arriving between gate completion and operation claim', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId,
    order = [];
  f.connection.turn = async () => {
    order.push('prompt');
    return 'Done';
  };
  const scheduler = f.service.issueChats.scheduler;
  await f.service.issueChats.control({ issueId, operation: 'pause' });
  const operation = f.service.issueChats.runFactoryOperation(
    issueId,
    { kind: 'verification', id: 'prompt-race', cancellable: false },
    async () => {
      order.push('operation');
    }
  );
  scheduler.change(issueId, (queue) => {
    queue.paused = false;
  });
  let sent;
  queueMicrotask(() => {
    sent = f.send('Before verification', 'boundary-arrival');
  });
  await new Promise((resolve) => setImmediate(resolve));
  await sent;
  await operation;
  assert.deepEqual(order, ['prompt', 'operation']);
});

test('restart projects a persisted operation as uncertain and never replays it on Resume', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId;
  f.service.issueChats.scheduler.change(issueId, (queue) => {
    queue.operation = {
      id: 'verify-before-crash',
      kind: 'verification',
      owner: 'previous-server',
      status: 'running',
      cancellable: true,
    };
  });
  f.service.issueChats.close();
  f.service.issueChats = createIssueChats(f.service, () => f.connection);
  const queue = f.service.issueChats.view(issueId).queue;
  assert.equal(queue.status, 'uncertain');
  assert.equal(queue.operation.status, 'uncertain');
  assert.equal(queue.operation.cancellable, false);
  await f.send('After recovery', 'operation-recovery');
  await f.service.issueChats.control({ issueId, operation: 'resume' });
  await f.finish();
  assert.equal(f.calls.filter((call) => call.prompt).length, 0);
  await assert.rejects(
    f.service.issueChats.runFactoryOperation(issueId, { id: 'new-operation', kind: 'verification' }, async () =>
      assert.fail('Must not replay')
    ),
    /previous server operation is unconfirmed/
  );
  assert.equal(f.service.issueChats.view(issueId).queue.operation.id, 'verify-before-crash');
});

test('native registration after service initialization holds foreign work then reuses the same idle thread', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId,
    threadId = '12345678-1234-4234-8234-123456789012';
  const report = join(f.queue.root, '.issues', issueId + '.md');
  writeFileSync(report, readFileSync(report, 'utf8') + '\nDiscuss this disposable issue.\n');
  const native = prepareNativeChat(f.queue.root, { issueId, mode: 'discuss' });
  bindNativeChat(f.queue.root, issueId, native.requestId, threadId);
  assert.equal(conversationState(f.queue.root, issueId).threadId, threadId);
  let foreign = true,
    starts = 0;
  f.connection.attach = (...args) => attachIssueChat(f.connection, ...args);
  f.connection.start = async () => {
    starts++;
    throw Error('Must never start a replacement');
  };
  f.connection.resume = async (id) => {
    assert.equal(id, threadId);
    if (foreign) throw Error('already has an active writer');
  };
  const call = f.connection.call;
  f.connection.call = async (method, args) =>
    method === 'thread/read'
      ? { thread: { id: threadId, cwd: f.service.root, status: { type: 'idle' } } }
      : call(method, args);
  await f.send('After native turn', 'native-first');
  await f.finish();
  assert.equal(f.service.issueChats.view(issueId).queue.entries[0].status, 'waiting');
  assert.equal(f.service.issueChats.view(issueId).queue.native.status, 'unconfirmed');
  foreign = false;
  f.service.codex = f.connection;
  await f.service.issueChats.control({ issueId, operation: 'resume' });
  await f.finish();
  assert.equal(starts, 0);
  assert.deepEqual(f.service.issueChats.view(issueId).queue.entries, []);
  assert.equal(f.calls.find((call) => call.prompt).id, threadId);
});

test('pending native registration blocks Factory creation and conflicting saved identity fails closed', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId,
    threadId = '12345678-1234-4234-8234-123456789012';
  const report = join(f.queue.root, '.issues', issueId + '.md');
  writeFileSync(report, readFileSync(report, 'utf8') + '\nDiscuss this disposable issue.\n');
  const native = prepareNativeChat(f.queue.root, { issueId, mode: 'discuss' });
  f.connection.attach = (...args) => attachIssueChat(f.connection, ...args);
  f.connection.start = async () => assert.fail('Must not create during native registration');
  await f.send('Wait for registration', 'native-pending');
  await f.finish();
  assert.equal(f.service.issueChats.view(issueId).queue.entries[0].status, 'waiting');
  bindNativeChat(f.queue.root, issueId, native.requestId, threadId);
  const path = join(f.queue.root, '.issues/conversations', issueId, 'chat.json');
  writeFileSync(path, JSON.stringify({ version: 1, issueId, status: 'idle', threadId: 'other-thread' }));
  assert.throws(() => conversationState(f.queue.root, issueId), /conflicts with its native binding/);
});

test('discussion thread resumes for work in its real managed checkout despite immutable original cwd', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId;
  f.queue.git('branch', '-M', 'main');
  const remote = join(f.queue.root, '.issues/target.git');
  f.queue.git('init', '--bare', '-q', remote);
  f.queue.git('remote', 'add', 'origin', remote);
  f.queue.git('push', 'origin', 'HEAD:refs/heads/main');
  writeFileSync(
    join(f.queue.root, '.issues/issue-delivery-config.json'),
    JSON.stringify({ provider: 'github', repository: 'fixture/timey', remote: 'origin', target: 'main' })
  );
  await f.send('Discuss before checkout', 'cwd-discussion');
  await f.finish();
  const originalThread = conversationState(f.queue.root, issueId).threadId;
  const resumed = [];
  f.connection.attach = (...args) => attachIssueChat(f.connection, ...args);
  f.connection.resume = async (...args) => {
    resumed.push(args);
  };
  const call = f.connection.call;
  f.connection.call = async (method, args) =>
    method === 'thread/read'
      ? { thread: { id: originalThread, cwd: realpathSync(f.queue.root), status: { type: 'idle' } } }
      : call(method, args);
  await f.send('Edit in the managed checkout', 'cwd-work', 'work');
  await f.finish();
  const checkout = f.service.lifecycleRuns[issueId].chatCheckout.checkout;
  assert.notEqual(realpathSync(checkout), realpathSync(f.queue.root));
  assert.equal(conversationState(f.queue.root, issueId).threadId, originalThread);
  assert.deepEqual(resumed, [[originalThread, checkout, 'workspace-write']]);
  const work = f.calls.find((call) => call.prompt?.includes('Latest request: Edit in the managed checkout'));
  assert.equal(work.id, originalThread);
  assert.equal(work.root, checkout);
  assert.equal(f.service.issueChats.view(issueId).queue.entries.length, 0);
});

test('Stop control interrupts a prompt owned by the shared base Codex connection exactly once', async (t) => {
  const f = fixture(t),
    issueId = f.input.issueId,
    shared = new CodexConnection();
  const threadId = 'shared-strategy-thread';
  f.service.lifecycleRuns[issueId] = { workThreadId: threadId };
  f.service.codex = shared;
  shared.ready = async () => {};
  shared.resume = async () => {};
  const calls = [];
  let start;
  shared.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: threadId, status: { type: 'idle' } } };
    if (method === 'turn/start')
      return new Promise((resolve) => {
        start = resolve;
      });
    return {};
  };
  await f.send('Shared prompt', 'shared-control-stop');
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = f.service.issueChats.control({ issueId, operation: 'stop', id: 'shared-control-stop' });
  assert.equal(calls.filter((call) => call.method === 'turn/interrupt').length, 0);
  start({ turn: { id: 'exact-shared-turn' } });
  await stopping;
  assert.deepEqual(
    calls.filter((call) => call.method === 'turn/interrupt').map((call) => call.params),
    [{ threadId, turnId: 'exact-shared-turn' }]
  );
  shared.event({
    method: 'item/agentMessage/delta',
    params: { threadId, itemId: 'partial', delta: 'Saved shared partial' },
  });
  shared.event({
    method: 'turn/completed',
    params: { threadId, turn: { id: 'exact-shared-turn', status: 'interrupted' } },
  });
  await f.finish();
  assert.equal(f.service.issueChats.view(issueId).queue.paused, true);
  assert.match(
    conversationMessages(f.queue.root, issueId).find((entry) => entry.id === 'stopped:shared-control-stop').body,
    /Saved shared partial/
  );
});
