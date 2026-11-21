import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIssueFolderSettings } from './factory-ui/issue-folder-settings.mjs';
import { git } from './factory-ui/common.mjs';

function setAttempt(service, entry, status, humanInput) {
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
  service.flows.store.save(flow, flow.revision);
}

function writeFixture(project, service, folders, reports, entry) {
  const content = `---\nid: ${entry.id}\ntitle: Status ${entry.key}\nstate: ${entry.state || 'backlog'}\nfolder_id: ${folders[entry.folder].id}\n---\n\nStatus fixture.\n`;
  const path = join(project, '.issues', entry.id + '.md');
  reports.set(path, content);
  writeFileSync(path, content);
  setAttempt(service, entry, entry.status, entry.humanInput);
  if (entry.active) service.flows.active.set(entry.id, { blockId: 'held-fixture' });
  if (entry.waiting) service.flows.autoplay.set(entry.id, { mode: 'waiting', blockId: 'confirmation' });
}

function createFixtures(project, service) {
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
  const reports = new Map();
  fixtures.forEach((entry) => writeFixture(project, service, folders, reports, entry));
  return { folders, fixtures, reports };
}

function removeFixtures(project, service, folders, fixtures) {
  for (const folder of folders) rmSync(folder.directory, { recursive: true, force: true });
  for (const entry of fixtures) {
    service.flows.active.delete(entry.id);
    service.flows.autoplay.delete(entry.id);
    rmSync(join(project, '.issues', entry.id + '.md'), { force: true });
  }
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

export async function issueStatusFoldersBrowserChecks({ page, project, service, poll, screenshot, output, root }) {
  const { folders, fixtures, reports } = createFixtures(project, service);
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
    setAttempt(service, paused, 'blocked', paused.humanInput);
    await service.flows.action({ action: 'pause', issueId: paused.id });
    await expectMembers('in-progress-issues', [fixtures[0].id]);
    await expectMembers('blocked-status-issues', initialBlocked);
    const running = fixtures[0];
    service.flows.active.delete(running.id);
    setAttempt(service, running, 'blocked');
    await expectMembers('in-progress-issues', []);
    await expectMembers('blocked-status-issues', [...initialBlocked, running.id]);
    await service.flows.action({ action: 'pause', issueId: running.id });
    await expectMembers('blocked-status-issues', initialBlocked);
    setAttempt(service, fixtures[1], 'stopped');
    await expectMembers(
      'blocked-status-issues',
      initialBlocked.filter((id) => id !== fixtures[1].id)
    );
    await page.locator('#blocked-status-issues summary').click();
    assert.equal(await page.locator('#blocked-status-issues').getAttribute('open'), null);
    await page.locator('#blocked-status-issues summary').click();
    await screenshot('issue-status-folders');
    const assignments = fixtures.map(({ id }) => ({
      id,
      folder: service.flows.read(service.flows.selected(id)).folder,
    }));
    for (const [path, content] of reports) assert.equal(readFileSync(path, 'utf8'), content);
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
    removeFixtures(project, service, folders, fixtures);
  }
}
