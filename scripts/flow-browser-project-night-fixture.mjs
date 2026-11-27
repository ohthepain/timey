import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importBrowserIssue } from './flow-browser-fixture.mjs';
import { nightDiscussionContext } from './factory-ui/flow-overnight.mjs';
import { requestBlock } from './factory-ui/flow-block-data.mjs';
import { resolveFolderSettings } from './factory-ui/issue-folder-settings.mjs';

const first = '20261127-night-first';
const second = '20261127-night-second';
const standalone = '20261127-night-independent';
const awaitingApproval = '20261127-night-approval';
const folders = ['Night repairs', 'Night reliability'];

async function issueInFolder({ project, flows, id, title, folder, status = 'backlog', number }) {
  await importBrowserIssue(
    project,
    id,
    `---
id: ${id}
title: ${title}
state: ${status}
request_type: feature
---

${title} behavior and proof.
`,
    'open',
    number
  );
  const issue = flows.selected(id);
  const flow = flows.read(issue);
  await flows.action({ action: 'folder', issueId: id, revision: flow.revision, folder });
  const updated = flows.read(flows.selected(id));
  requestBlock(updated).data.fields = { type: 'feature', goal: title };
  await flows.store.save(updated, updated.revision);
}

async function prepareIssues(project, flows) {
  for (const name of folders) await flows.action({ action: 'create-folder', name });
  await issueInFolder({ project, flows, id: first, title: 'Repair editor saves', folder: folders[0], number: 881 });
  await issueInFolder({ project, flows, id: second, title: 'Verify editor saves', folder: folders[1], number: 882 });
  await issueInFolder({ project, flows, id: standalone, title: 'Fix welcome text', folder: folders[0], number: 883 });
  await issueInFolder({
    project,
    flows,
    id: awaitingApproval,
    title: 'Approval exercise',
    folder: folders[0],
    status: 'needs-approval',
    number: 884,
  });
}

function installNightDiscussion(service) {
  const turns = [];
  service.projectDiscuss?.close();
  service.projectDiscuss = null;
  service.projectDiscussOptions = {
    skills: async () => [],
    modelSettings: () => ({
      defaults: { model: 'fixture', effort: 'high' },
      models: [{ id: 'fixture' }],
      efforts: ['high'],
    }),
    createProvider: () => ({
      async turn(session, message) {
        const run = nightDiscussionContext(service.flows, session.ownership.runId);
        turns.push({ run, prompt: message.text });
        const match = run.candidates.find(({ id }) => id === second);
        return {
          text: `${match.title} from ${match.folder} pairs with Repair editor saves. Both cover persisting editor changes.`,
          recommendations: [
            {
              id: 'context-0',
              label: 'Compare saved scope',
              prompt: 'Which editor save checks could the issues share?',
            },
          ],
        };
      },
      close() {},
    }),
  };
  return turns;
}

async function add(page, id) {
  await page.locator('#night-issue').selectOption(id);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
}

async function suggest(page, strategy, label) {
  await page.locator('#night-strategy').selectOption(strategy);
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await page.locator('#night-reasoning').getByText(label, { exact: false }).first().waitFor();
  return page.locator('#night-reasoning').innerText();
}

async function verifyRun({ page, service, poll, rows, master }) {
  const calls = [];
  const release = Promise.withResolvers();
  const executor = service.flows.executor;
  service.flows.executor = {
    ...executor,
    async run(input) {
      if (input.block.kind !== 'work') return executor.run(input);
      calls.push(input.issue.id);
      if (input.issue.id === standalone) await release.promise;
      return { status: 'blocked', summary: 'Fixture reached the Work approval boundary.' };
    },
  };
  try {
    await page.getByRole('button', { name: 'Start overnight run' }).click();
    await rows.first().getByText('running · Work', { exact: false }).waitFor();
    await poll(
      () => calls.length,
      (count) => count === 1,
      'The first saved item did not reach Work.'
    );
    assert.deepEqual(calls, [standalone]);
    const runningStatus = await rows.first().innerText();
    release.resolve();
    await poll(
      () => page.locator('#night-status').innerText(),
      (text) => text === 'finished',
      'Run did not finish.'
    );
    assert.deepEqual(calls, [standalone, master]);
    await rows.nth(1).getByText('Fixture reached the Work approval boundary.', { exact: false }).waitFor();
    return { calls, runningStatus, final: await rows.allInnerTexts() };
  } finally {
    release.resolve();
    service.flows.executor = executor;
  }
}

async function verifyIssueControls({ page, service, master, screenshot, output }) {
  await page.goto('/?issue=' + master);
  const title = page.locator('#rename-issue');
  const list = page.getByRole('list', { name: 'Sub-issues', exact: true });
  await list.waitFor();
  const dividers = await list.locator(':scope > li').evaluateAll((rows) =>
    rows.map((row) => {
      const style = getComputedStyle(row);
      return { top: style.borderTopWidth, bottom: style.borderBottomWidth, padding: style.paddingTop };
    })
  );
  assert.deepEqual(dividers, [
    { top: '0px', bottom: '0px', padding: '2px' },
    { top: '0px', bottom: '0px', padding: '2px' },
  ]);
  const original = service.flows.selected(master);
  assert.equal(await page.title(), `#${original.issueNumber} - ${original.title}`);
  const issueTitle = await page.title();
  const editor = page.locator('#rename-issue-form').getByRole('textbox', { name: 'Issue title', exact: true });
  await title.click();
  assert.equal(await editor.evaluate((field) => field === document.activeElement), true);
  await editor.press('Escape');
  assert.equal(await title.evaluate((button) => button === document.activeElement), true);
  await title.press('Enter');
  await editor.fill('Night save master');
  await editor.press('Enter');
  await page.getByRole('heading', { name: 'Night save master', exact: true }).waitFor();
  assert.equal(await page.title(), `#${original.issueNumber} - Night save master`);
  await screenshot('compact-master-title');
  await page.goto('/?issue=' + awaitingApproval);
  const approve = page.getByRole('button', { name: 'Approve', exact: true });
  await approve.waitFor();
  const color = await approve.evaluate((node) => getComputedStyle(node).backgroundColor);
  const [red, green, blue] = color.match(/\d+/g).map(Number);
  assert.ok(green > red && green > blue);
  await screenshot('issue-approval-color');
  writeFileSync(
    join(output, 'issue-ui-controls.json'),
    JSON.stringify({ issueTitle, dividers, approveBackground: color, renamed: true }, null, 2)
  );
}

export async function projectNightBrowserChecks({ page, service, project, poll, screenshot, output }) {
  const flows = service.flows;
  await prepareIssues(project, flows);
  assert.equal(
    resolveFolderSettings(project, folders[0]).values.branch,
    resolveFolderSettings(project, folders[1]).values.branch
  );
  const turns = installNightDiscussion(service);
  const before = flows.folderSelection.recommend;
  flows.folderSelection.recommend = async (strategy, issues) =>
    strategy === 'same-blast-radius'
      ? issues
          .filter(({ id }) => [first, second].includes(id))
          .map(({ id }) => ({ id, reason: 'Shared editor save behavior.' }))
      : issues.map(({ id }) => ({ id, reason: 'Check independent execution scope.' }));
  try {
    await page.goto('/');
    const moon = page.getByRole('tab', { name: 'Work All Night' });
    await moon.click();
    assert.equal((await moon.innerText()).trim(), '☾');
    const rows = page.locator('#night-order > li');
    await add(page, awaitingApproval);
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByRole('button', { name: 'Start overnight run' }).click();
    const guard = page.getByRole('alert').filter({ hasText: 'Approve this issue before starting work.' });
    await guard.waitFor();
    const approvalGuard = await guard.innerText();
    await rows.first().getByRole('button', { name: 'Remove' }).click();
    for (const id of [first, second, standalone]) await add(page, id);
    const same = await suggest(page, 'same-blast-radius', 'Shared editor save behavior.');
    const different = await suggest(page, 'different-blast-radii', 'Check independent execution scope.');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByRole('tab', { name: 'Discussion' }).click();
    await page.locator('#night-discuss-draft').fill('Which issue pairs with Repair editor saves in a master?');
    await page.locator('#night-discuss-send').click();
    await page.getByText('Both cover persisting editor changes.', { exact: false }).waitFor();
    assert.deepEqual(turns[0].run.run.issueIds, [first, second, standalone]);
    await page.getByRole('button', { name: 'Compare saved scope' }).waitFor();
    await screenshot('night-discussion');
    await page.getByRole('tab', { name: 'Plan' }).click();
    await suggest(page, 'same-blast-radius', 'Shared editor save behavior.');
    await page.getByRole('button', { name: 'Review master' }).click();
    await page.getByRole('button', { name: 'Create master', exact: true }).click();
    await rows
      .first()
      .getByRole('list', { name: 'Sub-issues' })
      .getByText('Verify editor saves', { exact: false })
      .waitFor();
    const master = await rows.first().getAttribute('data-night-id');
    assert.equal(flows.read(flows.selected(first)).folder, folders[0]);
    assert.equal(flows.read(flows.selected(second)).folder, folders[1]);
    await rows.nth(1).getByRole('button', { name: 'Move up' }).click();
    await suggest(page, 'different-blast-radii', 'Check independent execution scope.');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByRole('button', { name: 'Start overnight run' }).waitFor();
    await poll(
      () => page.locator('#night-status').innerText(),
      (text) => text === 'draft',
      'Draft did not save.'
    );
    await page.reload();
    await rows.nth(1).getByRole('list', { name: 'Sub-issues' }).waitFor();
    assert.deepEqual(await rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.nightId)), [
      standalone,
      master,
    ]);
    await screenshot('night-draft');
    const run = await verifyRun({ page, service, poll, rows, master });
    await screenshot('night-status');
    await verifyIssueControls({ page, service, master, screenshot, output });
    writeFileSync(
      join(output, 'project-night.json'),
      JSON.stringify({ approvalGuard, same, different, turns, run }, null, 2)
    );
  } finally {
    flows.folderSelection.recommend = before;
  }
}
