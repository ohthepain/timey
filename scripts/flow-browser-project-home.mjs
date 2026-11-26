import { importBrowserIssue, writeBrowserIssue } from './flow-browser-fixture.mjs';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectHome } from './factory-ui/project-home.mjs';
import { InvestigationOutputs } from './factory-ui/investigation-outputs.mjs';
import { InvestigationReports } from './factory-ui/investigation-reports.mjs';
import { digest, git } from './factory-ui/common.mjs';

const draft = `---\nname: fixture-mode\ndescription: Work in the fixture user's style when explicitly selected.\ndisable-model-invocation: true\n---\n\nKeep responses concise. Verify changed behavior.\n`;
const findings =
  'Observed source.txt:1. The project needs input validation. Add a bounded validation boundary and prove invalid input is rejected.';
const proposal = {
  title: 'Validate project operation input',
  type: 'bug',
  description: 'Reject invalid project operation input.',
  reason: 'The investigation observed missing validation at source.txt:1.',
  verification: 'An invalid operation returns a useful error without writing source.',
};

function browserReport(service, ctx) {
  const path = join(service.root, '.issues/browser-report-' + ctx.attempt.id + '.md');
  writeFileSync(
    path,
    '# Investigation report\n\n## Executive summary\n\n' + findings + '\n\n## Recommendations\n\nValidate the boundary.'
  );
  const report = new InvestigationReports(service.root).publish({
    source: ctx.attempt.investigationSource,
    attemptId: ctx.attempt.id,
    publicationId: ctx.attempt.publicationId,
    workspace: service.root,
    title: 'Validation investigation',
    report: path,
    additionalFindings: 'A report observation.',
    inspectedRevisions: [ctx.flow.startingPoint.commit],
  });
  return {
    output: 'Published report.',
    summary: 'Published report.',
    evidence: [],
    artifacts: {
      values: {
        reportId: report.id,
        additionalFindings: report.additionalFindings,
        inspectedRevisions: report.inspectedRevisions,
      },
      files: {},
    },
  };
}
async function browserIssues(service, ctx) {
  const saved = await new InvestigationOutputs(service.flows).createIssues({
    source: ctx.attempt.investigationSource,
    items: [
      {
        ...proposal,
        title: proposal.title + ' for ' + ctx.attempt.investigationSource.issueId,
        key: 'validation-boundary',
      },
    ],
  });
  return {
    output: 'Saved actionable work.',
    summary: 'Saved actionable work.',
    evidence: [],
    artifacts: { values: { issues: saved.items.map(({ key, result }) => ({ key, ...result })) }, files: {} },
  };
}
function isInvestigationOperation(ctx) {
  return (
    ctx.flow.routeType === 'investigation' &&
    ['understand', 'investigate', 'generate-report', 'create-issues'].includes(ctx.block.kind)
  );
}
function configureHome(service, calls) {
  const original = service.flows.executor.run.bind(service.flows.executor);
  service.flows.executor.run = async (ctx) => {
    if (!isInvestigationOperation(ctx)) return original(ctx);
    if (ctx.block.kind === 'generate-report') return browserReport(service, ctx);
    if (ctx.block.kind === 'create-issues') return browserIssues(service, ctx);
    calls.investigations++;
    const path = join(service.root, '.issues/factory-ui/flow-evidence', ctx.attempt.id, 'response.txt');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, findings);
    const proof = { path, sha256: digest(findings), label: 'Block response' };
    return {
      output: findings,
      summary: 'Found one validation improvement.',
      evidence: [proof],
      artifacts: { values: {}, files: { response: proof } },
    };
  };
  service.projectHome?.close();
  service.projectHome = new ProjectHome(service, service.flows, {
    investigations: { propose: async () => [proposal] },
    automateMe: {
      history: async (_service, window) => ({
        messages: [{ role: 'user', text: 'Keep replies concise.', at: window.until }],
        coverage: {
          ...window,
          messageCount: 1,
          threadCount: 1,
          gaps: ['Synthetic browser history.'],
          truncated: false,
        },
      }),
      providerFactory: () => ({
        async turn(_session, input) {
          calls.automate++;
          calls.duration = input.context.duration;
          await calls.beforeTurn?.();
          return calls.automate === 1
            ? { message: 'Which working habit matters most?', draft: null }
            : { message: 'Review this proposed skill.', draft: { name: 'fixture-mode', content: draft } };
        },
        close() {},
      }),
    },
  });
}

async function runInvestigationBlock(page, service, issueId, kind, poll) {
  await page.reload();
  const block = service.flows.read(service.flows.selected(issueId)).blocks.find((entry) => entry.kind === kind);
  await page.locator('#graph [data-block="' + block.id + '"]').click();
  const start = page.waitForResponse(
    (response) => response.url().endsWith('/api/flow-action') && response.request().postDataJSON()?.action === 'start'
  );
  await page.locator('#run-block[data-action="start"]').click();
  const response = await start;
  assert.ok(response.ok(), await response.text());
  return poll(
    () =>
      service.flows.active.has(issueId)
        ? null
        : service.flows
            .read(service.flows.selected(issueId))
            .blocks.find(({ id }) => id === block.id)
            .attempts.at(-1),
    (attempt) => attempt?.status === 'completed',
    kind + ' did not complete.'
  );
}
async function investigate(page, service, calls, screenshot, poll) {
  await page.getByRole('button', { name: 'Start an investigation', exact: true }).click();
  const dialog = page.locator('#home-investigation-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('#home-investigation-branch').inputValue(), 'refs/heads/dev');
  await dialog.locator('#home-investigation-branch').selectOption('refs/heads/recent');
  await dialog.locator('#home-investigation-focus').selectOption('Architecture');
  await dialog.locator('#home-investigation-prompt').fill('Investigate validation across the project.');
  await dialog.locator('#home-investigation-instructions').fill('Prioritize clear boundaries.');
  await dialog.locator('#home-investigation-reusable').check();
  await dialog.getByRole('button', { name: 'Create investigation', exact: true }).click();
  await page.locator('#graph-scroll:not([hidden])').waitFor();
  await page.locator('#graph [data-block="generate-report"]').waitFor();
  assert.equal(calls.investigations, 0, 'Creation starts no model work.');
  assert.equal(await page.locator('#investigation-page').isVisible(), false);
  assert.equal(await page.locator('#issue-playback').isVisible(), true);
  const toolbar = await page.locator('.investigation-flow-controls').boundingBox();
  const graphRegion = await page.locator('#graph-region').boundingBox();
  assert.ok(toolbar && graphRegion);
  assert.ok(
    toolbar.y + toolbar.height <= graphRegion.y + 1,
    'Investigation controls remain above the graph instead of creating a side column.'
  );
  await screenshot('investigation-toolbar-layout');
  const issueId = new URL(page.url()).searchParams.get('issue');
  const owner = service.projectHome.investigations;
  const inquiry = await runInvestigationBlock(page, service, issueId, 'investigate', poll);
  assert.equal(calls.investigations, 1);
  const issueOutput = await runInvestigationBlock(page, service, issueId, 'create-issues', poll);
  assert.equal(issueOutput.investigationSource.attemptId, inquiry.id);
  assert.deepEqual(issueOutput.supplementalFindings, []);
  const reportOutput = await runInvestigationBlock(page, service, issueId, 'generate-report', poll);
  const reports = new InvestigationReports(service.root);
  assert.equal(reports.list().filter((entry) => entry.source.issueId === issueId).length, 1);
  assert.equal(reportOutput.investigationSource.attemptId, inquiry.id);
  const first = owner.issueView(issueId);
  assert.equal(first.runs.length, 1);
  assert.equal(first.runs[0].issues[0].state, 'needs-approval');
  await screenshot('investigation-independent-outputs');
  await page.locator('[data-investigation-again]').click();
  await poll(
    () => owner.issueView(issueId),
    (view) => view.runs.length === 2 && !view.active,
    'Run again did not finish the inquiry and included outputs.'
  );
  assert.equal(calls.investigations, 2);
  assert.equal(reports.list().filter((entry) => entry.source.issueId === issueId).length, 2);
  assert.equal(
    service.flows.issues().filter(({ source_issue }) => source_issue === issueId).length,
    1,
    'Matching work remains linked without duplicate issue creation.'
  );
  await screenshot('investigation-run-history');
  await page.reload();
  await page.locator('#graph [data-block="generate-report"]').waitFor();
  assert.equal(calls.investigations, 2, 'Reload starts no investigation.');
  page.once('dialog', (confirmation) => void confirmation.accept());
  await page.locator('[data-investigation-archive]').click();
  await poll(() => owner.issueView(issueId).archived, Boolean, 'The investigation was not archived.');
  assert.equal(owner.issueView(issueId).runs.length, 2);
  assert.equal(
    reports.list().filter((entry) => entry.source.issueId === issueId).length,
    2,
    'Archival preserves retained reports.'
  );
  await page.goto('/');
  await page.locator('#project-home:not([hidden])').waitFor();
}
async function prepareHome(page, service) {
  const labels = join(service.root, '.issues/triage-labels.md');
  if (!existsSync(labels)) copyFileSync(new URL('../.issues/triage-labels.md', import.meta.url), labels);
  const calls = { investigations: 0, automate: 0 };
  configureHome(service, calls);
  await page.goto('/');
  return calls;
}
export async function investigationToolbarBrowserChecks({ page, service, screenshot }) {
  const id = '20261123-investigation-toolbar';
  await writeBrowserIssue(service.root, {
    id,
    title: 'Investigation toolbar layout',
    body: 'Check layout without running an investigation.',
  });
  const issue = service.flows.selected(id);
  const flow = service.flows.read(issue);
  const originalType = flow.routeType;
  flow.routeType = 'investigation';
  await service.flows.store.save(flow, flow.revision);
  await page.goto('/?issue=' + id);
  const panel = page.locator('.investigation-flow-controls');
  await panel.waitFor();
  const toolbar = await panel.boundingBox(),
    graph = await page.locator('#graph-region').boundingBox();
  assert.ok(toolbar && graph);
  assert.ok(toolbar.y + toolbar.height <= graph.y + 1, 'Investigation controls stay above the graph.');
  assert.ok(graph.width > toolbar.width, 'The toolbar does not consume a column beside the graph.');
  await screenshot('investigation-toolbar-layout');
  const saved = service.flows.read(service.flows.selected(id));
  saved.routeType = originalType;
  await service.flows.store.save(saved, saved.revision);
  await page.reload();
  await panel.waitFor({ state: 'hidden' });
}

export async function investigationFlowsBrowserChecks({ page, service, screenshot, poll }) {
  const calls = await prepareHome(page, service);
  await page.locator('#home-title').waitFor();
  await investigate(page, service, calls, screenshot, poll);
}

async function prepareLongAutomateChat({ page, service, poll, sessionId }) {
  const automate = service.projectHome.automateMe;
  const session = automate.selected(sessionId);
  session.messages.push(
    ...Array.from({ length: 32 }, (_, index) => ({ role: 'assistant', text: 'Working-style message ' + (index + 1) }))
  );
  automate.save(session);
  const messages = page.locator('#home-automate-messages');
  const metrics = () =>
    messages.evaluate((node) => ({ top: node.scrollTop, end: node.scrollHeight - node.clientHeight }));
  const atLatest = (position) => position.end > 100 && position.end - position.top < 3;
  await messages.getByText('Working-style message 32', { exact: true }).waitFor();
  await poll(metrics, atLatest, 'Automate me did not follow incoming history at the bottom.');
  const followed = await metrics();
  await messages.evaluate((node) => {
    node.scrollTop = 90;
  });
  return { sessionId, metrics, atLatest, followed };
}

async function verifyAutomateChatReopening({ page, dialog, poll, output, chat }) {
  const reading = await chat.metrics();
  assert.equal(reading.top, 90, 'An Automate me reply preserves the older reading position.');
  await dialog.getByRole('button', { name: 'Close Automate me', exact: true }).click();
  await page.locator(`[data-home-session="automate"][data-session-id="${chat.sessionId}"]`).click();
  await poll(chat.metrics, chat.atLatest, 'Reopened Automate me did not show the latest reply.');
  writeFileSync(
    join(output, 'automate-chat-scroll.json'),
    JSON.stringify({ followed: chat.followed, reading, reopened: await chat.metrics() }, null, 2) + '\n'
  );
}

export async function automateActivityBrowserChecks({ page, service, screenshot, poll, output }) {
  const calls = await prepareHome(page, service);
  let turn = Promise.withResolvers();
  calls.beforeTurn = () => turn.promise;
  try {
    await page.getByRole('tab', { name: 'Automate me', exact: true }).click();
    await page.getByRole('button', { name: 'Run Automate me', exact: true }).click();
    const dialog = page.locator('#home-automate-dialog');
    const indicator = dialog.locator('#home-automate-messages > .chat-live .SparkleText');
    const started = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/project-home-action') &&
        response.request().postDataJSON()?.action === 'automate-start'
    );
    await dialog.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await indicator.waitFor();
    await screenshot('automate-activity-running');
    turn.resolve();
    await dialog.getByText('Which working habit matters most?', { exact: true }).waitFor();
    await indicator.waitFor({ state: 'detached' });
    const { session } = await (await started).json();
    const chat = await prepareLongAutomateChat({ page, service, poll, sessionId: session.id });
    turn = Promise.withResolvers();
    await dialog.locator('#home-automate-message').fill('Make verification explicit.');
    await dialog.getByRole('button', { name: 'Send reply', exact: true }).click();
    await indicator.waitFor();
    turn.resolve();
    await dialog.locator('#home-automate-review:not([hidden])').waitFor();
    await indicator.waitFor({ state: 'detached' });
    await verifyAutomateChatReopening({ page, dialog, poll, output, chat });
    await dialog.getByRole('button', { name: 'Close Automate me', exact: true }).click();
  } finally {
    turn.resolve();
    calls.beforeTurn = null;
  }
}

async function automate(page, service, calls, screenshot) {
  await page.getByRole('tab', { name: 'Automate me', exact: true }).click();
  await page.getByRole('button', { name: 'Run Automate me', exact: true }).click();
  const dialog = page.locator('#home-automate-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('#home-automate-duration').inputValue(), '4');
  assert.equal(await dialog.locator('#home-automate-unit').inputValue(), 'weeks');
  await dialog.locator('#home-automate-duration').fill('10');
  await dialog.locator('#home-automate-unit').selectOption('days');
  await dialog.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await dialog.getByText('Which working habit matters most?', { exact: true }).waitFor();
  assert.equal(calls.duration.durationValue, 10);
  assert.equal(calls.duration.durationUnit, 'days');
  await dialog.locator('#home-automate-message').fill('Make verification explicit.');
  await dialog.getByRole('button', { name: 'Send reply', exact: true }).click();
  await dialog.locator('#home-automate-review:not([hidden])').waitFor();
  assert.match(await dialog.locator('#home-automate-path').textContent(), /\.agents\/skills\/fixture-mode\/SKILL.md$/);
  const apply = dialog.getByRole('button', { name: 'Apply reviewed skill', exact: true });
  await dialog.locator('#home-automate-content').fill(draft + '\nKeep evidence with the result.\n');
  assert.equal(await apply.isDisabled(), true);
  await dialog.getByRole('button', { name: 'Review destination and changes', exact: true }).click();
  await apply.waitFor({ state: 'visible' });
  await screenshot('project-automate-review');
  await apply.click();
  await dialog.locator('#home-automate-status').getByText('applied', { exact: true }).waitFor();
  assert.match(
    readFileSync(join(service.root, '.agents/skills/fixture-mode/SKILL.md'), 'utf8'),
    /Keep evidence with the result/
  );
  await dialog.getByRole('button', { name: 'Close Automate me', exact: true }).click();
  await page.reload();
  await page.locator('[data-home-session="automate"]').first().waitFor();
  assert.equal(calls.automate, 2, 'Reload starts no Automate me turn.');
  await page.setViewportSize({ width: 720, height: 960 });
  await screenshot('project-home-narrow');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 960 });
}

export async function projectHomeBrowserChecks({ page, service, screenshot, poll }) {
  const calls = await prepareHome(page, service);
  await page.locator('#home-title').getByText(service.root.split('/').at(-1), { exact: true }).waitFor();
  assert.equal(calls.investigations, 0);
  assert.equal(calls.automate, 0);
  await page.locator('#home-title').click();
  assert.equal(await page.locator('#home-investigation-dialog').isVisible(), false);
  await screenshot('project-home');
  await pruneWorktrees(page, service, screenshot);
  await cleanRemoteBranches(page, screenshot);
  await cleanLocalBranches(page, service, screenshot);
  await deleteArchivedReports(page, service, screenshot);
  await investigate(page, service, calls, screenshot, poll);
  await automate(page, service, calls, screenshot);
}

async function deleteArchivedReports(page, { root }, screenshot) {
  const id = '20261118-archive-fixture';
  const title = 'Disposable archived issue';
  const branch = `codex/issue-${id}`;
  const archive = join(root, '.issues/archive');
  mkdirSync(archive, { recursive: true });
  const report = join(archive, id + '.md');
  await importBrowserIssue(
    root,
    id,
    `---\nid: ${id}\ntitle: ${title}\nstate: closed\n---\nDisposable archive record.\n`,
    'archive'
  );
  git(root, 'branch', branch, 'dev');
  await page.getByRole('tab', { name: 'Admin' }).click();
  await page.getByRole('button', { name: 'Preview archived issues' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete archived issues' });
  const choice = dialog.getByRole('checkbox', { name: new RegExp('^(?:#\\d+ )?' + title + '$') });
  await choice.check();
  const branchChoice = dialog.getByRole('checkbox', { name: `Also delete local branch ${branch}` });
  assert.equal(await branchChoice.isChecked(), false);
  await branchChoice.check();
  await dialog.getByRole('button', { name: 'Review deletion' }).click();
  await dialog.getByRole('heading', { name: 'Confirm archive deletion' }).waitFor();
  assert.match(readFileSync(report, 'utf8'), /Disposable archive record/);
  assert.equal(git(root, 'branch', '--format=%(refname:short)', '--list', branch), branch);
  await screenshot('project-admin-archive-deletion-confirmation');
  const deletion = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/project-archive-deletion' && response.request().method() === 'POST',
    { timeout: 60_000 }
  );
  await dialog.getByRole('button', { name: 'Permanently delete 1 archived issue' }).click();
  const response = await deletion;
  const result = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(result));
  assert.deepEqual(result.results, [{ id, status: 'deleted', branches: [{ name: branch, status: 'deleted' }] }]);
  await dialog.getByText(`${branch} · deleted`).waitFor();
  assert.equal(git(root, 'branch', '--list', branch), '');
  assert.throws(() => readFileSync(report), /ENOENT/);
  await screenshot('project-admin-archive-deletion-result');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Home' }).click();
}

async function cleanRemoteBranches(page, screenshot) {
  const endpoint = '**/api/project-remote-branch-cleanup';
  const requests = [];
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: {
          id: 'reviewed-preview',
          repository: 'fixture/timey',
          target: 'dev',
          readOnly: false,
          entries: [
            { name: 'merged-one' },
            { name: 'merged-two' },
            { name: 'still-open', reason: 'Used by an open pull request.' },
          ],
        },
      });
    }
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        results: [
          { name: 'merged-one', status: 'deleted' },
          { name: 'merged-two', status: 'deleted' },
        ],
      },
    });
  });
  await page.getByRole('tab', { name: 'Admin' }).click();
  await page.getByRole('button', { name: 'Preview remote branches' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clean up remote branches' });
  await dialog.getByText('fixture/timey · merged into dev · 2 eligible').waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Review deletion' }).isDisabled(), true);
  await dialog.getByText('Branches kept (1)').click();
  await dialog.getByText('still-open · Used by an open pull request.').waitFor();
  await dialog.getByRole('checkbox', { name: 'Select all eligible branches' }).check();
  await dialog.getByRole('button', { name: 'Review deletion' }).click();
  await dialog.getByRole('heading', { name: 'Confirm branch deletion' }).waitFor();
  assert.deepEqual(requests, []);
  await screenshot('project-admin-remote-branch-confirmation');
  await dialog.getByRole('button', { name: 'Delete 2 remote branches' }).click();
  await dialog.getByText('merged-two · deleted').waitFor();
  assert.deepEqual(requests, [{ id: 'reviewed-preview', selected: ['merged-one', 'merged-two'] }]);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Home' }).click();
  await page.unroute(endpoint);
}

async function cleanLocalBranches(page, service, screenshot) {
  const { root } = service;
  const { repository } = JSON.parse(readFileSync(join(root, '.issues/issue-delivery-config.json'), 'utf8'));
  service.projectLocalBranchCleanup = null;
  service.projectArchiveDeletion = null;
  service.localBranchCleanupOptions = {
    provider: () => ({
      gh: async (args) =>
        args.includes(`repos/${repository}`)
          ? JSON.stringify({ full_name: repository, node_id: 'fixture', default_branch: 'dev' })
          : JSON.stringify([[]]),
    }),
  };
  const branch = 'admin-unused-local';
  git(root, 'branch', branch, 'dev');
  await page.getByRole('tab', { name: 'Admin' }).click();
  await page.getByRole('button', { name: 'Preview local branches' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clean up local branches' });
  await dialog.getByRole('checkbox', { name: branch, exact: true }).check();
  await dialog.getByRole('button', { name: 'Review deletion' }).click();
  await dialog.getByRole('heading', { name: 'Confirm branch deletion' }).waitFor();
  assert.equal(git(root, 'branch', '--format=%(refname:short)', '--list', branch), branch);
  await screenshot('project-admin-local-branch-confirmation');
  await dialog.getByRole('button', { name: 'Delete 1 local branch' }).click();
  await dialog.getByText(`${branch} · deleted`).waitFor();
  assert.equal(git(root, 'branch', '--list', branch), '');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Home' }).click();
}

async function pruneWorktrees(page, { root }, screenshot) {
  const checkout = join(root, 'missing checkout');
  const branch = 'admin-worktree-fixture';
  git(root, 'worktree', 'add', '-b', branch, checkout, 'dev');
  rmSync(checkout, { recursive: true });
  await page.getByRole('tab', { name: 'Admin' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Prune worktrees' }).click();
  const dialog = page.getByRole('dialog', { name: 'Prune worktrees' });
  const branchChoice = dialog.getByRole('checkbox', { name: `Delete local branch ${branch}`, exact: true });
  await dialog.getByLabel('Comparison branch').selectOption('refs/heads/dev');
  await branchChoice.waitFor();
  assert.equal(await branchChoice.isChecked(), true);
  assert.match(git(root, 'worktree', 'list', '--porcelain'), /missing checkout/);
  await screenshot('project-admin-worktree-preview');
  await dialog.getByRole('button', { name: 'Remove 1 worktree record and 1 branch' }).click();
  await dialog.getByText(`Worktree record removed. Deleted ${branch}.`).waitFor();
  assert.equal(git(root, 'branch', '--list', branch), '');
  assert.doesNotMatch(git(root, 'worktree', 'list', '--porcelain'), /missing checkout/);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Home' }).click();
}
