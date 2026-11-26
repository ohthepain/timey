import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importBrowserIssue } from './flow-browser-fixture.mjs';

export async function inboxFlowBrowserChecks({ page, service, project, poll, screenshot, output }) {
  const fixtures = [
    { id: '20261124-inbox-new', title: 'Newest Inbox issue', location: 'open', day: '24' },
    { id: '20261124-inbox-old', title: 'Older Inbox issue', location: 'open', day: '20' },
    { id: '20261124-inbox-closed', title: 'Closed Inbox issue', location: 'closed', day: '20' },
    { id: '20261124-inbox-archived', title: 'Archived Inbox issue', location: 'archive', day: '20' },
  ];
  for (const { id, title, location, day } of fixtures) {
    await importBrowserIssue(
      project,
      id,
      `---\nid: ${id}\ntitle: ${title}\nstate: ${location === 'open' ? 'backlog' : 'closed'}\ncreated: 2026-11-${day}T08:00:00Z\nupdated: 2026-11-24T11:00:00Z\n---\n\nCheck the Inbox controls.\n`,
      location
    );
  }
  const [newest, oldest, closed, archived] = fixtures;
  const issue = service.flows.selected(newest.id);
  for (const kind of ['advice', 'advice', 'advice']) {
    const { revision } = service.flows.read(issue);
    await service.flows.action({ action: 'add', issueId: issue.id, kind, revision });
  }
  const flow = service.flows.read(issue);
  const [first, middle, last] = flow.blocks.filter(({ kind }) => kind === 'advice');
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: 1250 });
  await page.goto('/?issue=' + newest.id);
  await page.locator('#issue-title').getByText(newest.title).waitFor();
  const layout = await checkIssueLayout(page, newest, oldest);
  const { preview, saved } = await checkDrag({ page, service, issue, flow, first, middle, last, poll, screenshot });
  await checkIssueSymbols({ page, service, issue, first, closed, archived });
  await page.setViewportSize(viewport);
  writeFileSync(
    join(output, 'inbox-flow.json'),
    JSON.stringify({ ...layout, preview, saved, symbols: ['blocked', 'closed', 'archived'] }, null, 2)
  );
}

async function checkIssueLayout(page, newest, oldest) {
  const timestamps = await page
    .locator('.flow-footer time')
    .evaluateAll((nodes) => nodes.map((node) => new Date(node.dateTime).toISOString()));
  assert.deepEqual(timestamps, ['2026-11-24T08:00:00.000Z', '2026-11-24T11:00:00.000Z']);
  assert.equal(await page.getByText('Flow runs from top to bottom ↓', { exact: true }).count(), 0);
  const folder = page
    .locator('#open-issues .issue-folder')
    .filter({ has: page.locator(`[data-issue="${newest.id}"]`) });
  const ordering = await folder.locator('[data-issue]').evaluateAll((rows) => rows.map((row) => row.dataset.issue));
  assert.ok(ordering.includes(oldest.id) && ordering.indexOf(newest.id) < ordering.indexOf(oldest.id));
  const caret = (locator) =>
    locator.evaluate((node) => {
      const marker = getComputedStyle(node, '::before');
      return node.getBoundingClientRect().left + (node.clientWidth - parseFloat(marker.width)) / 2;
    });
  const carets = [
    await caret(page.locator('#local-notes-toggle')),
    await caret(folder.locator('[data-toggle-folder]')),
  ];
  assert.equal(carets[0], carets[1]);

  return { timestamps, ordering, carets };
}

async function checkDrag({ page, service, issue, flow, first, middle, last, poll, screenshot }) {
  const card = (id) => page.locator(`#graph [data-block="${id}"]`);
  await card(first.id).click();
  assert.equal(await page.getByText('Sequence', { exact: true }).count(), 0);
  const graph = page.locator('#graph');
  const snapshot = () =>
    graph.evaluate((root) => ({
      blocks: [...root.querySelectorAll('[data-block]')].map((node) => node.dataset.block),
      edges: [...root.querySelectorAll('path[data-from]')].map((path) => [path.dataset.from, path.dataset.to]),
    }));
  const grip = card(first.id).locator('[data-block-grip]');
  await card(last.id).scrollIntoViewIfNeeded();
  const source = await grip.boundingBox();
  const target = await card(last.id).boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.locator('#graph[data-reorder-preview] [data-reorder-source]').waitFor();
  const preview = await poll(
    snapshot,
    ({ edges }) => edges.some(([from, to]) => from === last.id && to === first.id),
    'Projected connections did not render.'
  );
  assert.deepEqual(
    preview.blocks.filter((id) => [first.id, middle.id, last.id].includes(id)),
    [middle.id, last.id, first.id]
  );
  assert.equal(service.flows.read(issue).revision, flow.revision);
  await screenshot('inbox-block-drag-preview');
  await page.mouse.up();
  await poll(
    () => service.flows.read(issue).revision,
    (revision) => revision > flow.revision,
    'Drop did not save.'
  );
  await page.reload();
  const saved = await poll(
    snapshot,
    ({ edges }) => edges.some(([from, to]) => from === last.id && to === first.id),
    'Saved connections did not render.'
  );
  assert.deepEqual(saved, preview);

  return { preview, saved };
}

async function checkIssueSymbols({ page, service, issue, first, closed, archived }) {
  const blockedFlow = service.flows.read(issue);
  blockedFlow.blocks
    .find(({ id }) => id === first.id)
    .attempts.push({
      id: 'inbox-blocked-attempt',
      status: 'blocked',
      startedAt: '2026-11-24T10:00:00Z',
    });
  await service.flows.store.save(blockedFlow, blockedFlow.revision);
  await page.reload();
  await page.locator('#issue-playback .status-icon.blocked').waitFor();
  await page.goto('/?issue=' + closed.id);
  await page.locator('.issue-playback .status-icon.closed').waitFor();
  await page.goto('/?issue=' + archived.id);
  await page.locator('.issue-playback .status-icon.archived').waitFor();
}

export async function inboxDiscussBrowserChecks({ page, service, screenshot, output }) {
  service.projectDiscuss?.close();
  service.projectDiscuss = null;
  const calls = [];
  const prompt = 'Can you accept this prompt?';
  const reply = 'Prompt accepted while work was paused.';
  const history = Array.from({ length: 60 }, (_, index) => `Conversation detail ${index + 1}.`).join('\n\n');
  service.projectDiscussOptions = {
    modelSettings: () => ({
      defaults: { model: 'fixture', effort: 'high' },
      models: [{ id: 'fixture' }],
      efforts: ['high'],
    }),
    skills: async () => [],
    createProvider: () => ({
      async turn(_session, { text }) {
        calls.push(text);
        return { text: `${reply}\n\n${history}` };
      },
      close() {},
    }),
  };
  await page.goto('/?projectTab=discuss');
  await page.locator('#discuss-new').click();
  const draft = page.locator('#discuss-draft:not(:disabled)');
  await draft.waitFor();
  const composerGap = () =>
    page
      .locator('#project-discuss .discuss-composer')
      .evaluate((composer) =>
        Math.round(
          document.querySelector('.flow-main').getBoundingClientRect().bottom - composer.getBoundingClientRect().bottom
        )
      );
  const emptyGap = await composerGap();
  assert.ok(emptyGap >= 0 && emptyGap <= 60, `Empty composer is ${emptyGap}px from the bottom.`);
  const run = service.store.add({ id: 'inbox-running-work' }, 'issue-work');
  service.store.update(run, { status: 'running' });
  try {
    await page.locator('[data-server-toggle]').check();
    await draft.fill(prompt);
    await page.locator('#discuss-send').click();
    const messages = page.locator('#discuss-messages');
    await messages.getByText(prompt, { exact: true }).waitFor();
    await messages.getByText(reply, { exact: true }).waitFor();
    assert.deepEqual(calls, [prompt]);
    const { actions, phase } = service.serverControl.status();
    assert.equal(actions, 1);
    assert.equal(phase, 'paused');
    const populatedGap = await composerGap();
    assert.equal(populatedGap, emptyGap);
    await screenshot('project-discuss');
    const scroll = (edge) =>
      messages.evaluate((node, edge) => {
        node.scrollTop = edge === 'top' ? 0 : node.scrollHeight;
        return node.scrollTop;
      }, edge);
    const top = await scroll('top');
    assert.equal(top, 0);
    assert.equal(await composerGap(), emptyGap);
    const bottom = await scroll('bottom');
    assert.ok(bottom > 0, 'The conversation scrolls.');
    assert.equal(await composerGap(), emptyGap);
    writeFileSync(
      join(output, 'project-discuss-inbox.json'),
      JSON.stringify(
        {
          runningActions: actions,
          phase,
          acceptedPrompt: prompt,
          renderedReply: reply,
          emptyGap,
          populatedGap,
          scrollPositions: { top, bottom },
        },
        null,
        2
      )
    );
  } finally {
    service.store.update(run, { status: 'completed' });
    service.store.connected.delete(run.id);
    service.serverControl.cancel();
  }
}
