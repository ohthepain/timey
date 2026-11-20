import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

test('open actions menu refreshes changed work at the same count and preserves unchanged drafts', async () => {
  const dom = new JSDOM('<header><button id="project-actions"></button></header>', { runScripts: 'outside-only' });
  try {
    dom.window.eval(
      readFileSync(new URL('./factory-ui/server-control-ui.js', import.meta.url), 'utf8') +
        '\nwindow.controls = serverControlUI;'
    );
    const document = dom.window.document;
    const status = { actions: 1, chats: 0, phase: 'idle', supported: false, pauseSupported: true };
    let items = [{ id: 'first', title: 'First action', issues: [], canSteer: true }];
    const request = async () => items;
    const show = async () => {
      dom.window.controls.show(status, request);
      await new Promise((resolve) => setImmediate(resolve));
    };
    await show();
    document.getElementById('project-actions').click();
    await new Promise((resolve) => setImmediate(resolve));
    const field = document.querySelector('[data-steer-text]');
    field.value = 'Keep this draft';
    field.focus();
    await show();
    assert.equal(document.querySelector('[data-steer-text]'), field);
    assert.equal(document.activeElement, field);
    assert.equal(field.value, 'Keep this draft');
    items = [{ id: 'second', title: 'Second action', issues: [], canSteer: false }];
    await show();
    assert.equal(document.querySelectorAll('.server-action-card').length, 1);
    assert.equal(document.querySelector('.server-action-card h3').textContent, 'Second action');
    assert.equal(document.getElementById('project-actions').textContent, '1 action running');
  } finally {
    dom.window.close();
  }
});
