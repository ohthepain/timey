import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIssueFolderSettings } from './factory-ui/issue-folder-settings.mjs';
import { git } from './factory-ui/common.mjs';
import { importBrowserIssues, removeBrowserIssues } from './flow-browser-fixture.mjs';

async function setAttempt(service, entry, status, humanInput) {
  const flow = service.flows.read(service.flows.selected(entry.id));
  const block = flow.blocks.find(({ kind }) => kind === 'work');
  block.attempts = status
    ? [
        {
          id: 'status-fixture-' + entry.key,
          status,
          startedAt: '2026-11-21T15:00:00Z',
          result: humanInput ? { humanInput } : {},
        },
      ]
    : [];
  await service.flows.store.save(flow, flow.revision);
}

async function createFixtures(project, service) {
  const folders = ['Status folder one', 'Status folder two'].map((name) => createIssueFolderSettings(project, name));
  const fixtures = [
    { key: 'running', folder: 0, active: true },
    { key: 'blocked', folder: 1, status: 'blocked' },
    { key: 'input', folder: 0, status: 'blocked', humanInput: { kind: 'human-input', message: 'Answer me.' } },
    { key: 'approval', folder: 1, state: 'needs-approval' },
    { key: 'confirmation', folder: 1, waiting: true },
    { key: 'uncertain', folder: 1, status: 'uncertain' },
    { key: 'paused', folder: 0, status: 'blocked', humanInput: { kind: 'human-input', message: 'Retained input.' } },
    { key: 'stopped', folder: 1, status: 'stopped' },
  ].map((entry) => ({ ...entry, id: '20261121-status-' + entry.key }));
  const reports = fixtures.map(({ id, key, state, folder }) => ({
    id,
    report: `---\nid: ${id}\ntitle: Status ${key}\nstate: ${state || 'backlog'}\nfolder_id: ${folders[folder].id}\n---\n\nStatus fixture.\n`,
  }));
  await importBrowserIssues(service, reports);
  for (const entry of fixtures) {
    await setAttempt(service, entry, entry.status, entry.humanInput);
    if (entry.active) service.flows.active.set(entry.id, { blockId: 'held-fixture' });
    if (entry.waiting) service.flows.autoplay.set(entry.id, { mode: 'waiting', blockId: 'confirmation' });
  }
  return { folders, fixtures, reports };
}

async function removeFixtures(service, folders, fixtures) {
  for (const folder of folders) rmSync(folder.directory, { recursive: true, force: true });
  for (const entry of fixtures) {
    service.flows.active.delete(entry.id);
    service.flows.autoplay.delete(entry.id);
  }
  await removeBrowserIssues(
    service,
    fixtures.map(({ id }) => id)
  );
}

async function checkDirectStart(service, paused, running, expectMembers) {
  const executor = service.flows.executor;
  const held = Promise.withResolvers();
  service.flows.executor = { run: () => held.promise, close() {} };
  try {
    const flow = service.flows.read(service.flows.selected(paused.id));
    const work = flow.blocks.find(({ kind }) => kind === 'work');
    await service.flows.action({ action: 'start', issueId: paused.id, blockId: work.id, revision: flow.revision });
    await expectMembers('in-progress-issues', [running.id, paused.id]);
    assert.equal(Boolean(service.flows.autoplay.get(paused.id)?.userPaused), false);
  } finally {
    const task = service.flows.active.get(paused.id)?.task;
    held.resolve({ summary: 'Focused status fixture finished.' });
    if (task) await task;
    service.flows.executor = executor;
  }
}

async function checkStatusCarets(page, screenshot, output, poll) {
  const regularCaret = page.locator('.sidebar-files .folder-disclosure').first();
  const caretStyle = (element) => {
    const style = getComputedStyle(element, '::before');
    return {
      content: style.content,
      clipPath: style.clipPath,
      width: style.width,
      height: style.height,
      transform: style.transform,
    };
  };
  await regularCaret.waitFor();
  if ((await regularCaret.getAttribute('aria-expanded')) === 'true') await regularCaret.click();
  await poll(
    () => regularCaret.getAttribute('aria-expanded'),
    (value) => value === 'false',
    'Regular folder collapsed'
  );
  const collapsedCaret = await regularCaret.evaluate(caretStyle);
  await regularCaret.click();
  await poll(
    () => regularCaret.getAttribute('aria-expanded'),
    (value) => value === 'true',
    'Regular folder expanded'
  );
  const expandedCaret = await regularCaret.evaluate(caretStyle);
  assert.notEqual(collapsedCaret.transform, expandedCaret.transform);
  const carets = [];
  for (const id of ['in-progress-issues', 'blocked-status-issues']) {
    const collection = page.locator('#' + id);
    const summary = collection.locator('summary');
    assert.notEqual(await collection.getAttribute('open'), null);
    await summary.click();
    await poll(
      () => collection.getAttribute('open'),
      (value) => value === null,
      id + ' collapsed'
    );
    assert.equal(await collection.getAttribute('open'), null);
    const collapsed = await summary.evaluate(caretStyle);
    await screenshot(id + '-collapsed');
    await summary.click();
    await poll(
      () => collection.getAttribute('open'),
      (value) => value !== null,
      id + ' expanded'
    );
    assert.notEqual(await collection.getAttribute('open'), null);
    const expanded = await summary.evaluate(caretStyle);
    carets.push({ id, collapsed, expanded });
    await screenshot(id + '-expanded');
  }
  writeFileSync(
    join(output, 'issue-status-carets.json'),
    JSON.stringify({ collapsedCaret, expandedCaret, carets }, null, 2) + '\n'
  );
  for (const caret of carets) {
    assert.deepEqual(caret.collapsed, collapsedCaret, caret.id + ' must use the regular collapsed caret.');
    assert.deepEqual(caret.expanded, expandedCaret, caret.id + ' must use the regular expanded caret.');
  }
}

export async function issueStatusFoldersBrowserChecks({ page, project, service, poll, screenshot, output, root }) {
  const { folders, fixtures, reports } = await createFixtures(project, service);
  async function members(id) {
    return page
      .locator('#' + id + ' [data-issue]')
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.issue).sort());
  }
  async function expectMembers(id, expected) {
    await poll(
      () => members(id),
      (actual) => JSON.stringify(actual) === JSON.stringify(expected.toSorted()),
      id + ' membership'
    );
  }
  try {
    const paused = fixtures.find(({ key }) => key === 'paused');
    await service.flows.action({ action: 'pause', issueId: paused.id });
    const otherProject = join(output, 'other-project');
    mkdirSync(join(otherProject, '.issues'), { recursive: true });
    const foreignId = '20261121-status-other-project';
    writeFileSync(
      join(otherProject, '.issues', foreignId + '.md'),
      `---\nid: ${foreignId}\ntitle: Foreign blocked issue\nstate: needs-approval\n---\n`
    );
    await page.goto('/');
    await expectMembers('in-progress-issues', [fixtures[0].id]);
    const initialBlocked = fixtures
      .filter(({ key }) => ['blocked', 'input', 'confirmation', 'uncertain'].includes(key))
      .map(({ id }) => id);
    await expectMembers('blocked-status-issues', initialBlocked);
    const approval = fixtures.find(({ key }) => key === 'approval');
    assert.equal(await page.locator('#open-issues [data-issue="' + approval.id + '"]').count(), 1);
    assert.equal(
      await page.locator('#blocked-status-issues .folder-count').textContent(),
      String(initialBlocked.length)
    );
    const order = await page.locator('#issue-list').evaluate((node) => [...node.children].map((child) => child.id));
    assert.deepEqual(order.slice(0, 3), ['in-progress-issues', 'blocked-status-issues', 'open-issues']);
    assert.equal(await page.locator('#issue-list [data-issue="' + foreignId + '"]').count(), 0);
    const initial = { running: await members('in-progress-issues'), blocked: await members('blocked-status-issues') };
    await checkDirectStart(service, paused, fixtures[0], expectMembers);
    await setAttempt(service, paused, 'blocked', paused.humanInput);
    await service.flows.action({ action: 'pause', issueId: paused.id });
    await expectMembers('in-progress-issues', [fixtures[0].id]);
    await expectMembers('blocked-status-issues', initialBlocked);
    const running = fixtures[0];
    service.flows.active.delete(running.id);
    await setAttempt(service, running, 'blocked');
    await expectMembers('in-progress-issues', []);
    await expectMembers('blocked-status-issues', [...initialBlocked, running.id]);
    await service.flows.action({ action: 'pause', issueId: running.id });
    await expectMembers('blocked-status-issues', initialBlocked);
    await setAttempt(service, fixtures[1], 'stopped');
    await expectMembers(
      'blocked-status-issues',
      initialBlocked.filter((id) => id !== fixtures[1].id)
    );
    await checkStatusCarets(page, screenshot, output, poll);
    await screenshot('issue-status-folders');
    const assignments = fixtures.map(({ id }) => ({
      id,
      folder: service.flows.read(service.flows.selected(id)).folder,
    }));
    for (const { id, report } of reports)
      assert.equal(readFileSync(join(project, '.issues', id + '.md'), 'utf8'), report);
    fixtures.forEach((entry, index) => assert.equal(assignments[index].folder, folders[entry.folder].name));
    writeFileSync(
      join(output, 'issue-status-folders-proof.json'),
      JSON.stringify(
        {
          sourceCommit: git(root, 'rev-parse', 'HEAD'),
          sourceStatus: git(root, 'status', '--porcelain'),
          observedAt: new Date().toISOString(),
          execution:
            'Disposable project reports and saved Flow attempts, with an injected active registry entry. Status transitions observed through normal browser polling. No live model work.',
          initial,
          final: { running: await members('in-progress-issues'), blocked: await members('blocked-status-issues') },
          assignments,
          reportBytesUnchanged: true,
          directStartClearsPause: true,
          pausedExcluded: [paused.id, running.id],
          unapprovedExcluded: approval.id,
          foreignIssueExcluded: foreignId,
          sidebarOrder: order,
        },
        null,
        2
      ) + '\n'
    );
  } finally {
    await page.goto('about:blank');
    await removeFixtures(service, folders, fixtures);
  }
}
