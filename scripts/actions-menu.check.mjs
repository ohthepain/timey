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
    let now = 0;
    dom.window.Date.now = () => now;
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
    now = 2000;
    await show();
    assert.equal(document.querySelector('[data-steer-text]'), field);
    assert.equal(document.activeElement, field);
    assert.equal(field.value, 'Keep this draft');
    now = 4000;
    items = [{ id: 'second', title: 'Second action', issues: [], canSteer: false }];
    await show();
    assert.equal(document.querySelectorAll('.server-action-card').length, 1);
    assert.equal(document.querySelector('.server-action-card h3').textContent, 'Second action');
    assert.equal(document.getElementById('project-actions').textContent, '1 action running');
  } finally {
    dom.window.close();
  }
});

test('actions menu limits polling and keeps refresh feedback stable while requests are pending', async () => {
  const dom = new JSDOM('<header><button id="project-actions"></button></header>', { runScripts: 'outside-only' });
  try {
    dom.window.eval(
      readFileSync(new URL('./factory-ui/server-control-ui.js', import.meta.url), 'utf8') +
        '\nwindow.controls = serverControlUI;'
    );
    let now = 0;
    dom.window.Date.now = () => now;
    let calls = 0;
    let finish;
    const request = () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const status = { actions: 1, chats: 0, phase: 'idle', supported: false, pauseSupported: true };
    const show = () => dom.window.controls.show(status, request);
    show();
    dom.window.document.getElementById('project-actions').click();
    show();
    assert.equal(calls, 1);
    finish([
      {
        id: 'publish',
        title: 'Publish PR',
        trigger: 'Block: Publish PR',
        purpose: 'Publish the checked issue changes.',
        issues: [],
      },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    const feedback = dom.window.document.querySelector('[data-actions-empty]');
    const ready = feedback.textContent;
    now = 1999;
    show();
    assert.equal(calls, 1);
    now = 2000;
    show();
    assert.equal(calls, 2);
    assert.equal(feedback.textContent, ready);
    now = 6000;
    show();
    assert.equal(calls, 2);
    const card = dom.window.document.querySelector('.server-action-card');
    assert.match(card.textContent, /Block: Publish PR/);
    assert.match(card.textContent, /Publish the checked issue changes/);
    finish([]);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    dom.window.close();
  }
});
