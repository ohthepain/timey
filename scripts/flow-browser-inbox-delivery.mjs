import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';
import { createProjectDiscussTools } from './factory-ui/project-discuss-tools.mjs';
import { retainBlockingError } from './factory-ui/block-errors.mjs';
import { importBrowserIssue, installBrowserHumanInput } from './flow-browser-fixture.mjs';

const manual = (page) => ({ Origin: new URL(page.url()).origin, 'X-Factory-Action': 'manual' });
async function post(page, path, data) {
  const response = await page.request.post('/api/' + path, { headers: manual(page), data });
  const result = await response.json();
  assert.ok(response.ok(), JSON.stringify(result));
  return result;
}
async function fixture(project, id, title, location = 'open') {
  const state = location === 'open' ? 'backlog' : 'closed';
  await importBrowserIssue(
    project,
    id,
    `---\nid: ${id}\ntitle: ${title}\nstate: ${state}\nrequest_type: feature\n---\n\n## Original request\n\nKeep ${title} visible.\n`,
    location
  );
}
function proof(output, name, result) {
  writeFileSync(join(output, name + '.json'), JSON.stringify(result, null, 2) + '\n');
}

function installDiscussionFixture(service) {
  const messages = [];
  const hold = Promise.withResolvers();
  service.projectDiscussOptions = {
    skills: async () => [],
    modelSettings: () => ({
      defaults: { model: 'fixture', effort: 'high' },
      models: [{ id: 'fixture' }],
      efforts: ['high'],
    }),
    createProvider: () => ({
      async turn(session, message, { event }) {
        messages.push({ issueId: session.ownership.issueId, text: message.text });
        event({ method: 'item/agentMessage/delta', params: { delta: 'Working on this issue' } });
        if (message.text === 'Hold this response') await hold.promise;
        return { text: 'Reply for ' + session.ownership.issueId };
      },
      close() {
        hold.resolve();
      },
    }),
  };
  return { messages, hold };
}

export async function issueDiscussWorkspaceChecks({ page, service, project, poll, screenshot, output }) {
  const first = '20261126-discuss-inbox-first';
  const second = '20261126-discuss-inbox-second';
  await fixture(project, first, 'First issue discussion');
  await fixture(project, second, 'Second issue discussion');
  const { messages, hold } = installDiscussionFixture(service);
  const panel = page.getByRole('region', { name: 'Issue Discuss' });
  const composer = panel.locator('[id$="discuss-draft"]');
  await page.goto('/?issue=' + first);
  await page.locator('#issue-discuss-toggle').click();
  await panel.waitFor();
  assert.equal(await page.locator('#graph-region').isVisible(), false);
  assert.equal(await page.getByRole('complementary', { name: 'Block inspector' }).isVisible(), true);
  await page.locator('#issue-discuss-expand').click();
  assert.equal(await page.getByRole('complementary', { name: 'Block inspector' }).isVisible(), false);
  assert.equal(messages.length, 0);
  await composer.fill('Hold this response');
  await panel.locator('[data-discuss-action="send"]').click();
  await poll(
    () => messages.length,
    (count) => count === 1,
    'First issue response did not start.'
  );
  await poll(
    () => composer.inputValue(),
    (value) => value === '',
    'Sent draft was retained.'
  );
  await composer.fill('Remember the first draft');
  await page.locator('#open-issues [data-issue="' + second + '"]').click();
  await page.getByRole('heading', { name: 'Second issue discussion' }).waitFor();
  await page.locator('#issue-discuss-expand').waitFor();
  await composer.waitFor();
  assert.equal(await composer.inputValue(), '');
  hold.resolve();
  await poll(
    () => service.projectDiscuss.view(undefined, { kind: 'issue', issueId: first }).selected.messages.at(-1)?.status,
    (status) => status === 'completed',
    'First response did not finish in its own conversation.'
  );
  await page.locator('#open-issues [data-issue="' + first + '"]').click();
  await panel.getByText('Reply for ' + first, { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), 'Remember the first draft');
  await screenshot('issue-discuss-expanded');
  await page.locator('#issue-discuss-expand').click();
  assert.equal(await page.getByRole('complementary', { name: 'Block inspector' }).isVisible(), true);
  await page.locator('#issue-discuss-flow').click();
  await page.locator('#graph-region').waitFor();
  assert.equal(messages.length, 1);
  proof(output, 'issue-discuss-workspace', {
    messages,
    restoredDraft: 'Remember the first draft',
    activeResponseCompleted: true,
  });
}

async function reopenInBrowser(page, id, title) {
  await page.goto('/?issue=' + id);
  const heading = page.getByRole('heading', { name: title, exact: true });
  await heading.waitFor();
  const headingBox = await heading.boundingBox();
  const reopen = page.locator('#reopen-issue');
  assert.ok((await reopen.boundingBox()).y >= headingBox.y + headingBox.height);
  await reopen.click();
  await page.getByRole('region', { name: 'Issue Discuss' }).waitFor();
  assert.equal(await reopen.isVisible(), false);
}

async function verifyFollowUpStart({ page, service, issueId, poll }) {
  const { flows } = service;
  const executor = flows.executor;
  flows.executor = {
    ...executor,
    async run(input) {
      if (input.issue.id === issueId && input.block.kind === 'work')
        return { status: 'stopped', summary: 'Fixture Work ended after explicit Start.' };
      return executor.run(input);
    },
  };
  try {
    const start = page.locator('#issue-playback[data-playback-mode="start"]');
    const [submitted] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/flow-action') && response.request().postDataJSON()?.action === 'play'
      ),
      start.click(),
    ]);
    assert.equal(submitted.ok(), true);
    return await poll(
      async () => ({
        active: flows.active.has(issueId),
        claim: await service.projectStores.coordination.get('claims/' + issueId),
        status: flows
          .read(flows.selected(issueId))
          .blocks.find(({ kind }) => kind === 'work')
          ?.attempts.at(-1)?.status,
      }),
      ({ active, claim, status }) => !active && !claim && status === 'stopped',
      'Follow-up Work did not finish and release ownership before the next scenario.'
    );
  } finally {
    flows.executor = executor;
  }
}

export async function reopenWorkspaceChecks({ page, project, root, service, output, screenshot, poll }) {
  initializeProjectLifecycle(service, { digest: readProjectSettings(project).lifecycle.digest });
  installBrowserHumanInput(project, root);
  const longTitle =
    'Closed issue with a long title so the closure actions must move to the next row and the title can use the full center column width';
  const closed = '20261126-follow-up-closed';
  const archived = '20261126-follow-up-archived';
  await fixture(project, closed, longTitle, 'closed');
  await fixture(project, archived, 'Archived issue with a merged fix', 'archive');
  const flows = service.flows;
  const old = flows.read(flows.selected(archived));
  old.blocks
    .find(({ kind }) => kind === 'merge')
    .attempts.push({
      id: 'old-merge',
      status: 'completed',
      startedAt: '2026-11-25T10:00:00Z',
      summary: 'Merged fixture',
      result: { pr: 91, revision: 'previous-candidate' },
    });
  await flows.store.save(old, old.revision);
  await reopenInBrowser(page, closed, longTitle);
  await reopenInBrowser(page, archived, 'Archived issue with a merged fix');
  const feedback = 'Keep the previous shortcut and add a keyboard label.';
  await page.getByText('Save agreed follow-up feedback', { exact: true }).click();
  await page.locator('#reopen-feedback-text').fill(feedback);
  await page.locator('#reopen-feedback button[type="submit"]').click();
  await page.getByText('Follow-up feedback saved to Your words.', { exact: true }).waitFor();
  const selected = flows.selected(archived);
  const saved = flows.read(selected);
  const request = saved.blocks.find(({ kind }) => kind === 'request');
  const history = saved.blocks.find(({ kind }) => kind === 'merge').attempts;
  assert.equal(request.attempts.length, 0);
  assert.match(
    request.data.wording,
    /Keep Archived issue with a merged fix visible[\s\S]*## Requested changes after the previous implementation/
  );
  assert.ok(request.data.wording.endsWith(feedback));
  assert.equal(history[0].result.pr, 91);
  assert.equal(selected.location, 'open');
  await screenshot('reopened-issue-chat');
  const followUpWork = await verifyFollowUpStart({ page, service, issueId: archived, poll });
  proof(output, 'reopen-workspace', {
    closed,
    archived,
    wording: request.data.wording,
    mergeHistory: history,
    attemptsBeforeStart: 0,
    explicitStartAccepted: true,
    followUpWork,
  });
  await page.goto('about:blank', { waitUntil: 'commit' });
}

async function ephemeralAppServer() {
  const server = createServer((_request, reply) => reply.end('Previously running app'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}
async function openAppTab(page, button) {
  const [popup] = await Promise.all([page.waitForEvent('popup'), button.click()]);
  await popup.waitForURL(/127\.0\.0\.1/);
  return popup;
}
export async function projectAppWorkspaceChecks({ page, project, service, output, root, poll }) {
  const { server, url } = await ephemeralAppServer();
  try {
    await verifyAppWorkspace({ page, project, service, output, server, url, poll });
    await verifyTimeyApp({ page, project, output, root, service, poll });
  } finally {
    server.close();
    service.projectApp?.close();
    service.projectApp = null;
    delete service.detectProjectApp;
    removeAppFixtures(project);
  }
}
const timeySources = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'vite.config.ts',
  '.oxfmtrc.json',
  'tsconfig.json',
  'postcss.config.mjs',
  'tailwind.config.mjs',
  'public',
  'auth',
  'domain',
  'src',
];

function removeAppFixtures(project) {
  const files = [
    ...timeySources,
    'vite.timey.config.ts',
    '.env',
    '.nitro',
    '.output',
    '.tanstack',
    'node_modules',
    'sample-app',
    '.issues/factory-ui/project-app.json',
  ];
  for (const file of files) rmSync(join(project, file), { force: true, recursive: true });
}

function copyTimeyApp(root, project) {
  for (const file of timeySources) cpSync(join(root, file), join(project, file), { recursive: true });
  const dependencies = realpathSync(join(root, 'node_modules'));
  symlinkSync(dependencies, join(project, 'node_modules'), 'dir');
  // The verifier links dependencies from outside the exported workspace.
  const config = join(project, 'vite.config.ts');
  renameSync(config, join(project, 'vite.timey.config.ts'));
  writeFileSync(
    config,
    `import config from './vite.timey.config.ts';\n` +
      `export default { ...config, server: { ...config.server, fs: { ...config.server?.fs, allow: ${JSON.stringify([project, dependencies])} } } };\n`
  );
  writeFileSync(
    join(project, '.env'),
    [
      'DATABASE_URL=postgresql://fixture@127.0.0.1:1/timey?schema=domain',
      'AUTH_DATABASE_URL=postgresql://fixture@127.0.0.1:1/timey',
      'BETTER_AUTH_URL=http://localhost:3000',
      'BETTER_AUTH_SECRET=disposable-factory-browser-fixture-123456',
      'SMTP_HOST=127.0.0.1',
      'SMTP_PORT=1',
      'SMTP_FROM=fixture@example.invalid',
      'SMTP_SECURE=false',
    ].join('\n') + '\n'
  );
  rmSync(join(project, '.issues/factory-ui/project-app.json'));
}

async function verifyTimeyApp({ page, project, output, root, service, poll }) {
  copyTimeyApp(root, project);
  const title = 'Your intelligent meter management assistant';
  const changed = 'Timey Factory hot-reload proof';
  const path = join(project, 'src/routes/index.tsx');
  const source = readFileSync(path, 'utf8');
  assert.ok(source.includes(title));
  await page.goto('/');
  const button = page.locator('#project-app');
  const launch = page.waitForResponse(
    (response) => response.url().endsWith('/api/project-app') && response.request().method() === 'POST',
    { timeout: 50000 }
  );
  const [popup] = await Promise.all([page.waitForEvent('popup'), button.click()]);
  try {
    const response = await launch;
    assert.ok(response.ok(), await response.text());
    await popup.waitForURL('http://localhost:3000/');
    await popup.getByText(title, { exact: true }).waitFor();
    writeFileSync(path, source.replace(title, changed));
    await popup.getByText(changed, { exact: true }).waitFor();
    await popup.screenshot({ path: join(output, 'timey-hot-reload.png') });
    assert.equal(popup.url(), 'http://localhost:3000/');
  } finally {
    await popup.close();
    writeFileSync(path, source);
  }
  service.projectApp.close();
  await appStops(poll, 'http://localhost:3000');
  proof(output, 'timey-hot-reload', {
    url: 'http://localhost:3000/',
    before: title,
    after: changed,
    manuallyReloaded: false,
    stoppedOnShutdown: true,
  });
}

async function appStops(poll, url) {
  await poll(
    () =>
      fetch(url, { signal: AbortSignal.timeout(500) }).then(
        () => false,
        () => true
      ),
    Boolean,
    'The Factory-owned application kept listening after it was stopped.'
  );
}

async function verifyAppWorkspace({ page, project, service, output, server, url, poll }) {
  const button = page.locator('#project-app');
  const menu = page.locator('#project-settings-dialog');
  const settings = { command: 'node start.mjs', url, directory: 'sample-app', expected: '', checkUrl: '' };
  mkdirSync(join(project, settings.directory), { recursive: true });
  service.detectProjectApp = async () => ({ ...settings, sources: 'sample-app/start.mjs', undetermined: 'checkUrl' });
  await page.goto('/');
  await button.click();
  await menu.locator('input[name="command"]').waitFor();
  await menu.locator('[data-detect-app]').click();
  await menu.getByText(/sample-app\/start.mjs/).waitFor();
  assert.equal(await menu.locator('input[name="command"]').inputValue(), 'node start.mjs');
  const view = await (await page.request.get('/api/project-app')).json();
  assert.equal(view.settings.command, '');
  await menu.locator('[data-settings-form] button[type="submit"]').click();
  await menu.getByText('Saved', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await button.click();
  await page
    .getByRole('status')
    .getByText(/could not recognize/)
    .waitFor();
  const updated = await (await page.request.get('/api/project-app')).json();
  await post(page, 'project-app', {
    action: 'save',
    revision: updated.revision,
    settings: { ...settings, expected: 'Previously running app' },
  });
  const external = await openAppTab(page, button);
  await external.getByText('Previously running app').waitFor();
  assert.equal(await page.locator('#project-app-stop').isVisible(), false);
  await external.close();
  assert.equal(await (await fetch(url)).text(), 'Previously running app');
  await new Promise((resolve) => server.close(resolve));
  await button.click();
  await page
    .locator('#project-app-status')
    .getByText(/App command stopped/)
    .waitFor();
  const script = `import { createServer } from 'node:http'; import { readFileSync } from 'node:fs'; createServer((_, res) => res.end(readFileSync('message.txt'))).listen(${new URL(url).port}, '127.0.0.1');`;
  writeFileSync(join(project, settings.directory, 'start.mjs'), script);
  const liveFile = join(project, settings.directory, 'message.txt');
  writeFileSync(liveFile, 'Previously running app, now Factory managed');
  const [managed, concurrent] = await Promise.all([
    openAppTab(page, button),
    post(page, 'project-app', { action: 'start' }),
  ]);
  assert.equal(concurrent.managed, true);
  await managed.getByText('Previously running app, now Factory managed').waitFor();
  writeFileSync(liveFile, 'Previously running app reads a local edit');
  await managed.reload();
  await managed.getByText('Previously running app reads a local edit').waitFor();
  await managed.close();
  assert.equal(await (await fetch(url)).text(), 'Previously running app reads a local edit');
  const issueId = '20261126-project-app-issue-view';
  await fixture(project, issueId, 'App available from the issue workspace');
  await page.goto('/?issue=' + issueId);
  await page.getByRole('heading', { name: 'App available from the issue workspace' }).waitFor();
  const reused = await openAppTab(page, button);
  await reused.getByText('Previously running app reads a local edit').waitFor();
  await reused.close();
  await page.locator('#project-app-stop').click();
  await page.locator('#project-app-status').getByText('App stopped.').waitFor();
  await appStops(poll, url);
  proof(output, 'project-app-workspace', {
    settings,
    detectionSavedOnlyOnSave: true,
    conflict: true,
    externalKeptRunning: true,
    startupFailureRetried: true,
    managedReadLocalEdit: true,
    concurrentManagedStartup: concurrent,
    reusedManagedApp: true,
  });
}

async function createSequentialMaster(page, project, service) {
  const folder = 'Sequential fixture';
  const children = ['20261126-sequential-one', '20261126-sequential-two', '20261126-sequential-three'];
  await page.goto('/');
  await post(page, 'flow-action', { action: 'create-folder', name: folder });
  for (const [index, id] of children.entries()) {
    await fixture(project, id, 'Sequential child ' + (index + 1));
    const selected = service.flows.selected(id);
    await service.flows.moveIssueToFolder(selected, service.flows.read(selected), folder);
  }
  await page.goto('/?folder=' + encodeURIComponent(folder));
  await page.locator('#folder-selection-strategy').selectOption('sequential');
  const members = page.getByRole('list', { name: 'Issues in this folder', exact: true });
  for (const id of children) await members.locator('input[value="' + id + '"]').check();
  await page.locator('[data-folder-command="group"]').click();
  await page.locator('#folder-master-wording').waitFor();
  await page.locator('#folder-group-form button[type="submit"]').click();
  await page.locator('#issue-sub-issues [data-ordered-child]').first().waitFor();
  return new URL(page.url()).searchParams.get('issue');
}

function fixturePublication(issueId, input, calls) {
  assert.equal(input.automaticPublication, true);
  calls.push({ issueId, publication: 91 });
  return { result: { pr: 91, target: 'dev', url: 'https://github.com/test/fixture/pull/91' } };
}

async function recordFixtureWork(calls, first, issueId, attempt) {
  calls.push({ issueId, id: attempt.sequentialChild?.id, verification: attempt.sequentialVerification });
  if (calls.length === 1) await first.promise;
}

function watchSequentialWork(flows) {
  const calls = [];
  const first = Promise.withResolvers();
  const original = flows.executor;
  flows.executor = {
    ...original,
    async run({ block, attempt, issue, input }) {
      if (block.kind === 'publish') return fixturePublication(issue.id, input, calls);
      if (block.kind === 'work') await recordFixtureWork(calls, first, issue.id, attempt);
      return { summary: 'Fixture finished ' + block.label };
    },
  };
  return {
    calls,
    first,
    restore: () => {
      first.resolve();
      flows.executor = original;
    },
  };
}

export async function sequentialWorkspaceChecks({ page, project, service, output, poll, screenshot }) {
  const master = await createSequentialMaster(page, project, service);
  const rows = page.locator('#issue-sub-issues [data-ordered-child]');
  const order = () => rows.evaluateAll((elements) => elements.map((row) => row.dataset.orderedChild));
  const [a, b, c] = await order();
  await rows.nth(2).dragTo(rows.first());
  await poll(order, (ids) => ids[0] === c, 'The master order was not saved.');
  await page.reload();
  await rows.first().waitFor();
  assert.deepEqual(await order(), [c, a, b]);
  const blocker = await post(page, 'issue-annotation', {
    action: 'add',
    issueId: a,
    type: 'label',
    label: 'blocked',
    note: 'Waiting for the fixture approval.',
  });
  const { calls, first, restore } = watchSequentialWork(service.flows);
  try {
    await exerciseSequentialRun({ page, poll, screenshot, master, rows, calls, first, blocker, order: [c, a, b] });
    const pr = await verifySequentialPublication({ page, flows: service.flows, master, poll });
    assert.deepEqual(
      calls.filter(({ publication }) => publication),
      [{ issueId: master, publication: 91 }]
    );
    proof(output, 'sequential-workspace', { master, savedOrder: [c, a, b], calls, fixturePr: pr });
  } finally {
    restore();
  }
}

async function verifySequentialPublication({ page, flows, master, poll }) {
  const saved = await poll(
    () => flows.read(flows.selected(master)),
    ({ destination }) => destination?.pr === 91,
    'The shared master did not retain the fixture PR.'
  );
  assert.equal(saved.blocks.filter(({ kind }) => kind === 'publish').length, 1);
  await page.locator('#issue-pr-menu').waitFor();
  await page.locator('#issue-pr-label').click();
  assert.equal(await page.locator('#issue-pr-link').getAttribute('href'), saved.destination.url);
  return saved.destination;
}

async function exerciseSequentialRun({ page, poll, screenshot, master, rows, calls, first, blocker, order }) {
  await page.locator('#issue-playback[data-playback-mode="start"]').click();
  await poll(
    () => calls.length,
    (count) => count === 1,
    'The first sub-issue did not start.'
  );
  assert.equal(await rows.first().getAttribute('draggable'), 'false');
  first.resolve();
  await page
    .locator('#issue-blocker-message')
    .getByText(/Waiting for the fixture approval/)
    .waitFor();
  assert.deepEqual(
    calls.map(({ id }) => id),
    [order[0]]
  );
  await screenshot('sequential-blocked-middle');
  await post(page, 'issue-annotation', { action: 'clear', issueId: order[1], annotationId: blocker.id });
  await page.locator('#issue-playback[data-playback-mode="resume"]').click();
  await poll(
    () => calls.length,
    (count) => count === 4,
    'Sequential Work stopped before the shared verification.'
  );
  assert.deepEqual(
    calls.slice(0, 3).map(({ id }) => id),
    order
  );
  assert.deepEqual(new Set(calls[3].verification), new Set(order));
  assert.deepEqual(new Set(calls.map(({ issueId }) => issueId)), new Set([master]));
  await page.locator('#issue-blocker').waitFor({ state: 'hidden' });
}

function watchBlockerRetries(flowService) {
  const prior = flowService.executor;
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers());
  let attempts = 0;
  flowService.executor = {
    ...prior,
    async run({ block }) {
      if (block.kind !== 'work') return { summary: 'Fixture finished ' + block.label };
      const index = attempts++;
      if (gates[index - 1]) await gates[index - 1].promise;
      return { status: 'failed', summary: 'Fixture Work failure ' + (index + 1) };
    },
  };
  return {
    gates,
    restore() {
      for (const gate of gates) gate.resolve();
      flowService.executor = prior;
    },
  };
}

function installRetryChat(service, issueId) {
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
      async turn() {
        const { flows } = service;
        const flow = flows.read(flows.selected(issueId));
        const tools = createProjectDiscussTools(service);
        await tools.invoke('issue_control', { action: 'continue', issueId, blockId: 'work', revision: flow.revision });
        return {
          text: 'Work retry started.',
          recommendations: [
            { id: 'context-0', label: 'Inspect the retry outcome', prompt: 'Review the current Work outcome.' },
          ],
        };
      },
      close() {},
    }),
  };
}

async function assertBlocker(page, text) {
  const alert = page.locator('#issue-blocker-message');
  await alert.getByText(text, { exact: true }).waitFor();
  assert.equal(await page.locator('#issue-results').getByText(text, { exact: true }).isVisible(), false);
  assert.equal(await page.locator('#error-banner').getByText(text, { exact: true }).isVisible(), false);
}

export async function blockerWorkspaceChecks({ page, project, service, output, screenshot }) {
  const issueId = '20261126-inbox-blocker';
  await fixture(project, issueId, 'Blocker retry proof');
  const flows = service.flows;
  const issue = flows.selected(issueId);
  const flow = flows.read(issue);
  flow.blocks = flow.blocks.filter(({ kind }) => ['request', 'work'].includes(kind));
  flow.blocks[0].data.fields = { type: 'feature', goal: 'Demonstrate the blocker' };
  retainBlockingError(flow, { action: 'update-worktree', error: Error('Unrelated worktree error') });
  await flows.store.save(flow, flow.revision);
  const retry = watchBlockerRetries(flows);
  installRetryChat(service, issueId);
  try {
    const transitions = await exerciseBlockerRetries({ page, issueId, gates: retry.gates, screenshot });
    proof(output, 'blocker-retries', transitions);
  } finally {
    retry.restore();
  }
}

async function retryInChat(page) {
  await page.locator('#issue-discuss-toggle').click();
  await page.locator('#issue-discuss-draft').fill('Retry the Work block.');
  await page.locator('#issue-discuss-send').click();
  await page.getByText('Work retry started.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Inspect the retry outcome', exact: true }).waitFor();
}

async function retryInBlock(page) {
  await page.locator('#issue-blocker-open').click();
  await page.locator('#tab-details').click();
  await page.locator('#run-block[data-action="continue"]').click();
}

async function exerciseBlockerRetries({ page, issueId, gates, screenshot }) {
  await page.goto('/?issue=' + issueId);
  await page.locator('#issue-playback[data-playback-mode="start"]').click();
  await assertBlocker(page, 'Fixture Work failure 1');
  const issueTitle = await page.title();
  const observations = [];
  const resume = page.locator('#issue-playback[data-playback-mode="resume"]:enabled');
  const controls = [
    ['Issue', () => resume.click()],
    ['Block', () => retryInBlock(page)],
    ['Chat', () => retryInChat(page)],
  ];
  for (const [index, [entry, start]] of controls.entries()) {
    await resume.waitFor();
    await start();
    await assertBlocker(page, 'Unrelated worktree error');
    const during = await page.locator('#issue-blocker-message').innerText();
    await screenshot('issue-blocker-retrying-' + entry.toLowerCase());
    gates[index].resolve();
    await assertBlocker(page, 'Fixture Work failure ' + (index + 2));
    observations.push({ entry, during, after: await page.locator('#issue-blocker-message').innerText() });
  }
  const chatPrompts = await page.locator('#issue-discuss-recommendations button').allTextContents();
  assert.deepEqual(chatPrompts, ['Inspect the retry outcome']);
  return { issueTitle, observations, chatPrompts };
}
