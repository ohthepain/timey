import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

function storageFixture(t) {
  const html = readFileSync(new URL('./factory-ui/index.html', import.meta.url), 'utf8');
  const code = html.slice(html.indexOf('      const issueStorage = {'), html.indexOf('      function showRuntime('));
  const openReport = html.slice(
    html.indexOf('      async function openSavedReport('),
    html.indexOf('      async function openPlan(')
  );
  const dom = new JSDOM(
    '<div id="app"></div><div id="error"></div><dialog id="plan"><h2 id="plan-title"></h2><p id="plan-path"></p><pre id="plan-content"></pre></dialog>',
    { runScripts: 'outside-only', url: 'http://127.0.0.1/#/closed' }
  );
  t.after(() => dom.window.close());
  const win = dom.window;
  const { document } = win;
  document.getElementById('plan').showModal = function () {
    this.open = true;
  };
  win.eval(`
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    const closed = [
      { id: 'alpha', issueNumber: 1, title: 'Alpha' },
      { id: 'beta', issueNumber: 2, title: 'Beta' },
      { id: 'pending', issueNumber: 3, title: 'Pending', pending: true, prUrl: 'https://github.com/example/timey/pull/17' },
    ];
    const archive = [];
    const requests = [];
    const request = async (path, value) => {
      requests.push({ path, value });
      if (path.startsWith('issue-storage?location=')) return { issues: (path.endsWith('closed') ? closed : archive).slice() };
      if (path.startsWith('issue-storage-report?')) return { path: '.issues/archive/alpha.md', content: '<b>Report text</b>' };
      if (path === 'issue-storage-open-folder') return { opened: true };
      if (path === 'issue-storage-move') {
        const archiving = value.action === 'archive';
        const [from, to] = archiving ? [closed, archive] : [archive, closed];
        return { results: value.issueIds.map((id) => {
          to.push(from.splice(from.findIndex((issue) => issue.id === id), 1)[0]);
          return { id, status: archiving ? 'archived' : 'restored' };
        }) };
      }
      throw Error('Unexpected request: ' + path);
    };
    const act = async (task) => {
      await task();
      renderStorage();
    };
    ${code}
    ${openReport}
    function renderStorage() {
      const storage = issueStorageLocation();
      $('app').innerHTML = storedIssuesPage(storage);
      bindStoredIssues(storage);
    }
    window.fixture = {
      requests,
      async open(location, readOnly = false) {
        issueStorageReadOnly = readOnly;
        window.location.hash = '#/' + location;
        await loadStoredIssues(location);
        renderStorage();
      }
    };
  `);
  return { fixture: win.fixture, document, win };
}

test('Closed issues batches visible selections, skips pending rows, and can restore an archived report', async (t) => {
  const { fixture, document, win } = storageFixture(t);
  await fixture.open('closed');
  const $ = (selector) => document.querySelector(selector);
  assert.equal($('h1').textContent, 'Closed issues');
  const folders = $('h1 + nav[aria-label="Issue folders"]');
  assert.deepEqual(
    Array.from(folders.querySelectorAll('a'), (link) => link.getAttribute('href')),
    ['#/queue', '#/closed', '#/archive']
  );
  assert.equal(folders.querySelector('[aria-current="page"]').textContent, 'Closed');
  assert.equal(document.querySelectorAll('[data-finder-folder]').length, 1);
  $('[data-finder-folder="closed"]').click();
  await setImmediate();
  assert.equal(fixture.requests.find((entry) => entry.path === 'issue-storage-open-folder').value.location, 'closed');
  assert.equal($('a[href="#/issue/alpha"]').textContent, '#1 · Alpha');
  assert.equal($('a[href="https://github.com/example/timey/pull/17"]').textContent, 'Review report PR');
  assert.equal($('[data-storage-select="pending"]').disabled, true);
  const search = $('#stored-issue-search');
  search.value = '#2';
  search.dispatchEvent(new win.Event('input'));
  assert.equal(document.querySelectorAll('[data-storage-select]').length, 1);
  $('#stored-issue-select-all').click();
  search.value = '';
  search.dispatchEvent(new win.Event('input'));
  $('[data-storage-select="alpha"]').click();
  assert.equal($('#stored-issue-move').textContent, 'Archive selected (2)');
  $('#stored-issue-move').click();
  await setImmediate();
  const archiveRequest = fixture.requests.find((entry) => entry.value?.action === 'archive');
  assert.deepEqual(Array.from(archiveRequest.value.issueIds).sort(), ['alpha', 'beta']);
  assert.match($('[role="status"]').textContent, /Archived 2 issues/);
  assert.deepEqual(
    Array.from(document.querySelectorAll('[data-storage-select]'), (input) => input.dataset.storageSelect),
    ['pending']
  );

  await fixture.open('archive');
  assert.equal(document.querySelectorAll('[data-finder-folder]').length, 1);
  $('[data-finder-folder="archive"]').click();
  await setImmediate();
  assert.equal(
    fixture.requests.filter((entry) => entry.path === 'issue-storage-open-folder').at(-1).value.location,
    'archive'
  );

  $('[data-storage-report="alpha"]').click();
  await setImmediate();
  assert.equal($('#plan').open, true);
  assert.equal($('#plan-content').textContent, '<b>Report text</b>');
  assert.equal($('#plan-content').children.length, 0);
  assert.ok(fixture.requests.some((entry) => entry.path === 'issue-storage-report?issue=alpha&location=archive'));
  $('[data-storage-move="alpha"]').click();
  await setImmediate();
  const restoreRequest = fixture.requests.find((entry) => entry.value?.action === 'restore');
  assert.deepEqual(Array.from(restoreRequest.value.issueIds), ['alpha']);
  assert.match($('[role="status"]').textContent, /Restored 1 issue/);
});

test('preview offers read-only access to closed reports', async (t) => {
  const { fixture, document } = storageFixture(t);
  await fixture.open('closed', true);
  assert.equal(document.querySelector('[data-storage-report="alpha"]').disabled, false);
  assert.equal(document.querySelector('[data-storage-move="alpha"]').disabled, true);
  assert.equal(document.getElementById('stored-issue-select-all').disabled, true);
});
