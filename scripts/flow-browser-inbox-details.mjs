import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';
import { withBrowserScenarioFixture } from './flow-browser-scenario-fixture.mjs';
import { writeBrowserIssue } from './flow-browser-fixture.mjs';

const completed = (id, evidence = []) => ({
  id,
  status: 'completed',
  startedAt: '2026-11-22T19:00:00Z',
  endedAt: '2026-11-22T19:01:00Z',
  summary: 'Completed in the browser fixture.',
  evidence,
});

async function selectDetails(page, block) {
  await page.locator('#graph [data-block="' + block + '"]').click();
  await page.locator('#tab-details').click();
}

async function checkPlayback(page, service, id, work, poll, screenshot) {
  const running = Promise.withResolvers();
  const clarify = service.flows.clarify;
  service.flows.clarify = () => running.promise;
  try {
    await page.goto('/?issue=' + id);
    for (const kind of ['request', work]) {
      await selectDetails(page, kind);
      await page.locator('#inspector-body .block-markdown-menu summary').waitFor();
      await page.locator('#inspector-body .system-prompt summary').waitFor();
      assert.equal(await page.locator('#inspector-body .block-content').count(), 0);
    }
    await page.locator('#issue-playback[data-playback-mode="start"]').click();
    await poll(() => service.flows.active.has(id), Boolean, 'Fixture Request started');
    const status = page.locator('#playback-status');
    await status.locator('.active-spinner').waitFor();
    assert.equal(await status.textContent(), '');
    await screenshot('inbox-issue-running');
    await page.locator('#issue-playback[data-playback-mode="pause"]').click();
    await status.getByText('Paused', { exact: true }).waitFor();
    assert.equal(await status.locator('.active-spinner').count(), 0);
    const title = await page.locator('#issue-title').boundingBox();
    const paused = await status.boundingBox();
    assert.ok(paused.y >= title.y + title.height, 'Paused status must appear below the issue title.');
    await screenshot('inbox-issue-paused');
    return { runningSpinner: true, runningText: '', pausedText: await status.textContent(), title, paused };
  } finally {
    running.resolve({ summary: 'Finished fixture Request.', artifacts: { values: {} } });
    await poll(() => !service.flows.active.has(id), Boolean, 'Fixture Request ended');
    service.flows.clarify = clarify;
  }
}

function proofFiles(project, labels) {
  const directory = join(project, '.issues/evidence');
  mkdirSync(directory, { recursive: true });
  return labels.map((label) => {
    const path = join(directory, label + '.txt');
    writeFileSync(path, label);
    return { path, label };
  });
}

async function checkMergeDetails(page, block, screenshot) {
  await selectDetails(page, block);
  const details = page.locator('#inspector-body');
  await details.getByText('2 proof artifacts from the latest run.', { exact: false }).waitFor();
  assert.equal(
    await details.getByText(/Issue title|Issue type|request\.type|Requested proof|Known facts|Delivery target/).count(),
    0
  );
  assert.equal(await details.locator('.block-content').count(), 0);
  assert.equal(await details.locator('.evidence-link').count(), 0);
  const icon = details.locator('[data-model-help] button');
  const tooltip = details.getByRole('tooltip');
  const help = 'This model is used only if AI conflict repair is needed.';
  assert.equal(await tooltip.isVisible(), false);
  await icon.hover();
  await tooltip.waitFor();
  assert.equal(await tooltip.textContent(), help);
  await page.mouse.move(0, 0);
  await icon.focus();
  await tooltip.waitFor();
  assert.equal(await tooltip.textContent(), help);
  await screenshot('inbox-merge-details');
  await details.locator('[data-open-merge-artifacts]').click();
  assert.equal(await page.locator('#tab-artifacts').getAttribute('aria-selected'), 'true');
  await details.getByText('latest-proof-one', { exact: true }).waitFor();
  await details.getByText('latest-proof-two', { exact: true }).waitFor();
  await details.getByText('Previous artifacts · Run 1', { exact: true }).click();
  await details.getByText('previous-proof', { exact: true }).waitFor();
  await screenshot('inbox-merge-artifacts');
}

export async function inboxDetailsBrowserChecks({ page, service, project, poll, screenshot, output }) {
  await withBrowserScenarioFixture({ project, service }, async () => {
    initializeProjectLifecycle(service, { digest: readProjectSettings(project).lifecycle.digest });
    const id = '20261126-inbox-details';
    await writeBrowserIssue(service, {
      id,
      title: 'Inbox Details keeps the full title width while playback controls and the Paused status remain visible',
      body: 'Keep fixture proof inputs.',
    });
    const flows = service.flows;
    const work = flows.read(flows.selected(id)).blocks.find(({ kind }) => kind === 'work');
    const playback = await checkPlayback(page, service, id, work.id, poll, screenshot);
    const flow = flows.read(flows.selected(id));
    const merge = flow.blocks.find(({ kind }) => kind === 'merge');
    merge.attempts.push(completed('earlier-merge', proofFiles(project, ['previous-proof'])));
    merge.attempts.push(completed('latest-merge', proofFiles(project, ['latest-proof-one', 'latest-proof-two'])));
    await flows.store.save(flow, flow.revision);
    await page.reload();
    await checkMergeDetails(page, merge.id, screenshot);
    const current = flows.read(flows.selected(id));
    current.blocks.find(({ id }) => id === merge.id).attempts.push(completed('empty-merge'));
    await flows.store.save(current, current.revision);
    await page.reload();
    await selectDetails(page, merge.id);
    await page.getByText('0 proof artifacts from the latest run.', { exact: false }).waitFor();
    const response = await page.request.get('/api/flow?issue=' + id);
    const details = (await response.json()).flow.blocks.find(({ id }) => id === merge.id).details;
    for (const key of ['title', 'type', 'goal', 'requestedProof', 'knownFacts', 'delivery'])
      assert.ok(
        details.some((detail) => detail.key === key),
        key
      );
    writeFileSync(
      join(output, 'inbox-details.json'),
      JSON.stringify(
        {
          playback,
          merge: {
            latestCount: 2,
            emptyLatestCount: 0,
            priorProof: true,
            hover: true,
            focus: true,
            inputKeys: details.map(({ key }) => key),
          },
        },
        null,
        2
      )
    );
  });
}
