import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

function discussFixture(t) {
  const dom = new JSDOM(readFileSync(new URL('./factory-ui/flow.html', import.meta.url), 'utf8'), {
    url: 'http://localhost/?projectTab=discuss',
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const load = (name) => window.eval(readFileSync(new URL('./factory-ui/' + name, import.meta.url), 'utf8'));
  load('view-state.js');
  load('activity-indicator-ui.js');
  load('issue-chat-ui.js');
  load('skill-select.js');
  load('project-discuss-ui.js');
  const selected = {
    id: 'conversation-a',
    status: 'idle',
    settings: {},
    messages: [
      { id: 'message-a', role: 'assistant', text: 'An error you can copy.', events: [{ text: 'Tool output' }] },
    ],
  };
  const data = { selected, conversations: [{ id: selected.id }], models: [], efforts: [] };
  const ui = window.createProjectDiscussUI({
    request: async (path) => (path.includes('skills') ? [] : structuredClone(data)),
    post: async () => structuredClone(data),
  });
  return { window, selected, ui };
}

test('Discuss activity persists through streaming and refresh, and stops for input and terminal states', async (t) => {
  const { window, selected, ui } = discussFixture(t);
  ui.setVisible(true);
  await new Promise((resolve) => setImmediate(resolve));
  const indicator = () => window.document.querySelector('#discuss-messages > [data-chat-live] [data-sparkle-text]');
  assert.equal(indicator(), null);
  selected.status = 'running';
  await ui.refresh();
  const original = indicator();
  assert.equal(original.getAttribute('role'), 'status');
  assert.equal(original.textContent, 'Working');
  selected.messages[0].text += ' Streamed text.';
  await ui.refresh();
  assert.equal(indicator(), original, 'Streaming must not restart the animation or activity announcement.');
  selected.approvals = [{ requestId: 'permission', params: { reason: 'Allow fixture?' } }];
  await ui.refresh();
  assert.equal(indicator(), null, 'Waiting for human input must not look active.');
  selected.approvals = [];
  await ui.refresh();
  assert.ok(indicator());
  for (const status of ['idle', 'paused', 'stopped', 'interrupted', 'failed']) {
    selected.status = status;
    await ui.refresh();
    assert.equal(indicator(), null, status + ' must not animate.');
  }
});

test('Discuss keeps expanded tool activity and highlighted text through unchanged and growing refreshes', async (t) => {
  const { window, selected, ui } = discussFixture(t);
  ui.setVisible(true);
  await new Promise((resolve) => setImmediate(resolve));
  const activity = window.document.querySelector('.discuss-tool-activity');
  activity.open = true;
  const text = window.document.querySelector('.discuss-message-body p').firstChild;
  const selection = window.getSelection();
  selection.setBaseAndExtent(text, 3, text, 8);
  await ui.refresh();
  assert.equal(window.document.querySelector('.discuss-tool-activity').open, true);
  assert.equal(selection.toString(), 'error');
  selected.messages[0].events.push({ text: 'More output' });
  await ui.refresh();
  assert.equal(window.document.querySelector('.discuss-tool-activity').open, true);
  assert.equal(selection.toString(), 'error');
  window.document.querySelector('.discuss-tool-activity').open = false;
  selected.messages[0].status = 'completed';
  await ui.refresh();
  assert.equal(window.document.querySelector('.discuss-tool-activity').open, false);
  selected.messages.unshift({ id: 'older-message', role: 'assistant', text: 'Earlier text inserted above.' });
  await ui.refresh();
  assert.equal(selection.toString(), 'error', 'Earlier messages must not shift the selected text.');
  selected.messages = [
    { id: 'replacement', role: 'assistant', text: 'New activity', events: [{ text: 'New output' }] },
  ];
  await ui.refresh();
  assert.equal(
    window.document.querySelector('.discuss-tool-activity').open,
    false,
    'A new activity must use its own default.'
  );
  assert.notEqual(selection.toString(), 'error');
});

test('Discuss visibly reports a locked conversation while waiting and shows the reason after pausing', async (t) => {
  const { window, selected, ui } = discussFixture(t);
  ui.setVisible(true);
  await new Promise((resolve) => setImmediate(resolve));
  const status = window.document.querySelector('#discuss-status');
  const lock = 'This conversation is locked by the ChatGPT desktop app.';
  selected.status = 'running';
  selected.threadLock = lock + ' Factory will retry automatically.';
  await ui.refresh();
  assert.match(status.textContent, /ChatGPT desktop app/);
  assert.ok(!status.classList.contains('visually-hidden'));
  assert.equal(window.document.querySelector('#discuss-send').getAttribute('aria-label'), 'Stop response');
  assert.equal(window.document.querySelector('#discuss-messages > .activity-indicator'), null);

  selected.status = 'paused';
  delete selected.threadLock;
  selected.messages[0].error = lock;
  await ui.refresh();
  assert.ok(status.classList.contains('visually-hidden'));
  assert.equal(window.document.querySelector('#discuss-messages .inline-error').textContent, lock);
  assert.ok(!window.document.querySelector('[data-discuss-retry]').disabled);
});
