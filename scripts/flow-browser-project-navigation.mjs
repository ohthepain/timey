import { fixtureRoute } from './flow-browser-routes.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  importBrowserIssue,
  installBrowserHumanInput,
  removeBrowserIssue,
  writeBrowserIssue,
} from './flow-browser-fixture.mjs';

const projectTabs = [
  { name: 'Home', route: null, target: '#home-title', screenshot: 'project-navigation' },
  {
    name: 'Issues',
    route: 'issues',
    target: 'iframe[title="Project issues"]',
    screenshot: 'project-navigation-issues',
  },
  { name: 'Reports', route: 'reports', target: '.reports-heading h1' },
  { name: 'Discuss', route: 'discuss', target: '#discuss-new', screenshot: 'project-navigation-discuss' },
  {
    name: 'Automate me',
    route: 'automate',
    target: '#home-automate-sessions',
    screenshot: 'project-navigation-automate',
  },
  { name: 'Admin', route: 'admin', target: '#admin-prune-worktrees' },
];

async function checkHeaderBounds(page, header) {
  const bounds = await header.boundingBox();
  const workspace = await page.locator('.workspace').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(Math.abs(bounds.x) <= 1 && Math.abs(bounds.y) <= 1, 'The header starts at the top left.');
  assert.ok(Math.abs(bounds.width - viewport.width) <= 1, 'The header spans the viewport.');
  assert.ok(bounds.y + bounds.height <= workspace.y + 1, 'The header sits above the workspace.');
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'The page fits the viewport.'
  );
  return { viewport, header: bounds, workspaceTop: workspace.y };
}

async function checkTab(page, tablist, { name, route, target }) {
  await tablist.getByRole('tab', { name, exact: true }).click();
  await page.getByRole('tabpanel', { name, exact: true }).locator(target).waitFor();
  const active = (await tablist.getByRole('tab', { selected: true }).allTextContents()).map((label) => label.trim());
  const url = new URL(page.url());
  assert.deepEqual(active, [name]);
  assert.equal(url.searchParams.get('projectTab'), route);
  return { tab: name, active: active[0], url: url.pathname + url.search };
}

async function checkProjectControls(page, header, poll) {
  const controls = [];
  for (const [trigger, panel] of [
    ['#diagnostics-trigger', '#diagnostics-panel'],
    ['#github-calls-button', '#github-calls'],
  ]) {
    const button = header.locator(trigger);
    await button.click();
    await page.locator(`${panel}:popover-open`).waitFor();
    await button.click();
    await page.locator(panel).waitFor({ state: 'hidden' });
    controls.push({ trigger, result: `Opened and closed ${panel}` });
  }
  for (const [trigger, dialog, close] of [
    ['#project-settings', '#project-settings-dialog', 'Close Factory settings'],
    ['[data-project-home="investigate"]', '#home-investigation-dialog', 'Close investigation'],
    ['#new-issue', '#capture-dialog', 'Close new issue'],
    ['#project-actions', '#server-actions-dialog', 'Close'],
  ]) {
    await header.locator(trigger).click();
    const popup = page.locator(dialog);
    await popup.waitFor();
    await popup.getByRole('button', { name: close, exact: true }).click();
    await popup.waitFor({ state: 'hidden' });
    controls.push({ trigger, result: `Opened and closed ${dialog}` });
  }
  const search = header.getByRole('searchbox', { name: 'Find an issue' });
  const folders = page.locator('#open-issues .issue-folder');
  const count = await poll(() => folders.count(), Boolean, 'Issue folders did not load.');
  await search.fill('no-matching-project-header-issue');
  await page.locator('#open-issues').getByText('No matching issues.').waitFor();
  await search.clear();
  await poll(
    () => folders.count(),
    (value) => value === count,
    'Clearing search did not restore the folder list.'
  );
  controls.push({ trigger: 'Find an issue', result: 'Filtered and restored the issue list' });
  return controls;
}

async function checkServerControls(page, header) {
  const response = await page.request.get('/api/server-status');
  assert.equal(response.status(), 200);
  const idle = { ...(await response.json()), phase: 'idle', actions: 0, supported: true, pauseSupported: true };
  let state = idle;
  const endpoints = new Map([
    ['server-status', () => state],
    ['server-pause', () => ({ ...idle, phase: 'paused' })],
    ['server-cancel-restart', () => idle],
    ['server-restart', () => ({ ...idle, phase: 'draining', actions: 1 })],
  ]);
  const removeRoutes = [];
  for (const [endpoint, next] of endpoints) {
    removeRoutes.push(
      await fixtureRoute(page, '**/api/' + endpoint, (route) => {
        state = next();
        return route.fulfill({ json: state });
      })
    );
  }
  try {
    await page.reload();
    const pause = header.getByRole('switch', { name: 'No new actions' });
    const restart = header.getByRole('button', { name: 'Restart server' });
    await restart.waitFor();
    await pause.check();
    await header.getByText('No actions running. New work is paused.', { exact: true }).waitFor();
    await pause.uncheck();
    await header.getByText('No actions running. New work is paused.', { exact: true }).waitFor({ state: 'hidden' });
    await restart.click();
    await header.getByText('New work is paused. Finishing current actions.', { exact: true }).waitFor();
    assert.equal(await restart.isDisabled(), true);
  } finally {
    await Promise.all(removeRoutes.map((remove) => remove()));
  }
  return [
    { trigger: 'No new actions', result: 'Paused and resumed action admission through fixture responses' },
    { trigger: 'Restart server', result: 'Started draining through a fixture response' },
  ];
}

async function checkProjectTab(page, tablist, tab, firstVisit) {
  if (tab.route !== 'issues') return checkTab(page, tablist, tab);
  const queue = firstVisit && page.waitForResponse((response) => new URL(response.url()).pathname === '/api/queue');
  const destination = await checkTab(page, tablist, tab);
  if (queue) {
    const response = await queue;
    assert.equal(response.status(), 200, await response.text());
  }
  await page.frameLocator('#project-issues iframe').getByRole('button', { name: 'Open', exact: true }).waitFor();
  return destination;
}

async function captureTab(screenshot, name, suffix) {
  if (!name) return null;
  const image = name + suffix;
  await screenshot(image);
  return image + '.png';
}

async function checkTabsAtViewport({ page, header, tablist, screenshot }, viewport, suffix = '') {
  await page.setViewportSize(viewport);
  const observations = [];
  for (const tab of projectTabs) {
    const destination = await checkProjectTab(page, tablist, tab, !suffix);
    observations.push({
      ...destination,
      ...(await checkHeaderBounds(page, header)),
      screenshot: await captureTab(screenshot, tab.screenshot, suffix),
    });
  }
  return observations;
}

async function checkAutomateAndHome(page, tablist, header) {
  await tablist.getByRole('tab', { name: 'Automate me', exact: true }).click();
  const automate = page.getByRole('tabpanel', { name: 'Automate me', exact: true });
  await automate.getByRole('button', { name: 'Run Automate me', exact: true }).click();
  await page.getByRole('button', { name: 'Close Automate me' }).click();
  await page.reload();
  await automate.getByRole('heading', { name: 'Automate me sessions' }).waitFor();
  assert.equal(await tablist.getByRole('tab', { name: 'Automate me', selected: true }).count(), 1);
  await header.getByRole('link', { name: 'Project home' }).click();
  await page.getByRole('tabpanel', { name: 'Home', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.has('projectTab'), false);
}

export const unavailableNavigationIssue = '20261125-navigation-second';

async function navigationFixtures(project, service, root) {
  installBrowserHumanInput(project, root);
  const first = '20261125-navigation-first';
  const second = unavailableNavigationIssue;
  const investigation = '20261125-navigation-investigation';
  await writeBrowserIssue(project, { id: first, title: 'Fix login', body: '## Original request\n\nFix login.' });
  await writeBrowserIssue(project, { id: second, title: 'Fix search', body: '## Original request\n\nFix search.' });
  await importBrowserIssue(
    project,
    investigation,
    `---\nid: ${investigation}\ntitle: Trace navigation\nstate: backlog\nrequest_type: investigation\n---\n\n## Original request\n\nInvestigate navigation.\n`
  );
  const issue = service.flows.selected(first);
  const flow = service.flows.read(issue);
  const request = flow.blocks.find(({ kind }) => kind === 'request');
  const work = flow.blocks.find(({ kind }) => kind === 'work');
  assert.ok(request && work, 'The fixture must have Request and Work blocks.');
  return { first, second, investigation, request, work };
}

function observeNavigation(page, poll) {
  const observations = [];
  const expect = async (target, title, locator) => {
    await page.waitForURL((url) =>
      ['projectTab', 'folder', 'issue', 'block'].every((key) => url.searchParams.get(key) === (target[key] || null))
    );
    await locator.waitFor();
    await poll(
      () => page.title(),
      (value) => value === title + ' · Factory',
      'Unexpected browser history title'
    );
    observations.push({ url: page.url(), title: await page.title() });
  };
  return { expect, observations };
}

async function checkFreshBlock(page, copiedURL, block) {
  const fresh = await page.context().newPage();
  try {
    const card = fresh.locator(`#graph [data-block="${block}"][aria-pressed="true"]`);
    await fresh.goto(copiedURL);
    await card.waitFor();
    const length = await fresh.evaluate(() => history.length);
    await fresh.reload();
    await card.waitFor();
    assert.equal(await fresh.evaluate(() => history.length), length, 'Reload must not add history.');
    return { url: fresh.url(), selected: block, reloadLength: length };
  } finally {
    await fresh.close();
  }
}

async function checkHistoryDraft(page, destinations, wording) {
  const draft = 'Unsaved login request entered before navigating';
  await page.locator('#tab-details').click();
  await wording.fill(draft);
  await destinations.work.open();
  await destinations.request.open();
  await wording.waitFor();
  const inApp = await wording.inputValue();
  await page.goBack();
  await destinations.work.check();
  await page.goBack();
  await destinations.request.check();
  await page.locator('#tab-details').click();
  const browser = await wording.inputValue();
  assert.deepEqual({ inApp, browser }, { inApp: draft, browser: draft });
  return { inApp, browser };
}

async function checkNativeHistory({ page, poll, tablist, project, service, root, screenshot }) {
  const fixtures = await navigationFixtures(project, service, root);
  const { first, second, investigation, request, work } = fixtures;
  await page.goto('/');
  await page.evaluate(() => {
    // Exercise history eviction even when this scenario runs on its own.
    for (let index = 0; index < 50; index++) history.pushState(null, '', location.href);
  });
  const { expect, observations } = observeNavigation(page, poll);
  const openIssue = (id) => page.locator(`#open-issues [data-issue="${id}"]`).click();
  const blockCard = (id) => page.locator(`#graph [data-block="${id}"]`);
  const visit = (open, target, title, locator) => ({ open, check: () => expect(target, title, locator) });
  const byTab = (name, projectTab, title) => {
    const selected = tablist.getByRole('tab', { name, exact: true, selected: true });
    const open = async () => {
      await tablist.getByRole('tab', { name, exact: true }).click();
      if (projectTab === 'issues')
        await page.frameLocator('#project-issues iframe').getByRole('button', { name: 'Open', exact: true }).waitFor();
    };
    return visit(open, { projectTab }, title || name, selected);
  };
  const folderButton = page.locator('#open-issues [data-folder]').first();
  await folderButton.waitFor();
  const folder = await folderButton.getAttribute('data-folder');
  const issueHeading = (title) => page.locator('#issue-title').filter({ hasText: title });
  const entries = {
    home: byTab('Home', undefined, 'Project Home'),
    issues: byTab('Issues', 'issues'),
    reports: byTab('Reports', 'reports'),
    discuss: byTab('Discuss', 'discuss'),
    folder: visit(() => folderButton.click(), { folder }, folder, page.locator('#folder-workspace-title')),
    first: visit(() => openIssue(first), { issue: first }, 'Fix login', issueHeading('Fix login')),
    request: visit(
      () => blockCard(request.id).click(),
      { issue: first, block: request.id },
      'Fix login / Request',
      page.locator(`#graph [data-block="${request.id}"][aria-pressed="true"]`)
    ),
    work: visit(
      () => blockCard(work.id).click(),
      { issue: first, block: work.id },
      'Fix login / Work',
      page.locator(`#graph [data-block="${work.id}"][aria-pressed="true"]`)
    ),
    second: visit(() => openIssue(second), { issue: second }, 'Fix search', issueHeading('Fix search')),
    investigation: visit(
      () => openIssue(investigation),
      { issue: investigation },
      'Trace navigation',
      issueHeading('Trace navigation')
    ),
  };
  const history = await page.context().newCDPSession(page);
  try {
    await entries.home.check();
    const initial = await history.send('Page.getNavigationHistory');
    for (const entry of Object.values(entries).slice(1)) {
      await entry.open();
      await entry.check();
    }
    const final = await history.send('Page.getNavigationHistory');
    const homeEntryId = initial.entries[initial.currentIndex].id;
    const start = final.entries.findIndex(({ id }) => id === homeEntryId);
    assert.ok(start >= 0, 'The Project Home history entry was lost.');
    const recorded = final.entries.slice(start, final.currentIndex + 1);
    assert.deepEqual(
      recorded.map(({ title }) => title),
      observations.map(({ title }) => title)
    );
    const order = Object.values(entries);
    for (const entry of order.slice(0, -1).reverse()) {
      await page.goBack();
      await entry.check();
    }
    for (const entry of order.slice(1)) {
      await page.goForward();
      await entry.check();
    }
    const workEntry = recorded.find(({ url }) => new URL(url).searchParams.get('block') === work.id);
    await history.send('Page.navigateToHistoryEntry', { entryId: workEntry.id });
    await entries.work.check();
    const copied = await checkFreshBlock(page, page.url(), work.id);
    const beforeRefresh = await history.send('Page.getNavigationHistory');
    await page.locator('#tab-artifacts').click();
    await page.locator('#issue-search').fill('filter-navigation-proof');
    await page.locator('#open-issues').getByText('No matching issues.').waitFor();
    await page.locator('#issue-search').clear();
    const badges = page.locator('#issue-badge-controls [data-issue-badge-filter]');
    await badges.selectOption({ index: 1 });
    await badges.selectOption('');
    const refreshed = page.waitForResponse(
      (response) => new URL(response.url()).searchParams.get('refresh') === 'true'
    );
    await page.locator('#refresh').click();
    assert.ok((await refreshed).ok());
    const afterRefresh = await history.send('Page.getNavigationHistory');
    assert.deepEqual(afterRefresh, beforeRefresh, 'Inspector tabs, filters and refresh must retain native history.');
    await page.goBack();
    await entries.request.check();
    const drafts = await checkHistoryDraft(page, entries, page.locator('[data-field="wording"]'));
    await screenshot('project-native-history');

    await entries.work.open();
    await entries.work.check();
    await entries.second.open();
    await entries.second.check();
    await entries.home.open();
    await entries.home.check();
    const flow = service.flows.read(service.flows.selected(first));
    await service.flows.action({ action: 'remove', issueId: first, revision: flow.revision, blockId: work.id });
    await removeBrowserIssue(project, second);
    const unavailable = () =>
      expect({ issue: second }, 'Issue unavailable', page.getByText('This issue is unavailable.', { exact: false }));
    await page.goBack();
    await unavailable();
    await page.goBack();
    await entries.first.check();
    await page.goForward();
    await unavailable();
    await page.goForward();
    await entries.home.check();
    return { recorded, observations, copied, drafts, historyIndexAfterRefresh: afterRefresh.currentIndex };
  } finally {
    await history.detach();
    await removeBrowserIssue(project, first);
    await removeBrowserIssue(project, investigation);
  }
}

export async function projectNavigationBrowserChecks({
  page,
  poll,
  screenshot,
  output,
  candidate,
  project,
  service,
  root,
}) {
  const desktop = { width: 1440, height: 960 };
  const narrow = { width: 390, height: 844 };
  const header = page.locator('.factory-header');
  const tablist = header.getByRole('tablist', { name: 'Project workspace' });
  const navigation = { page, header, tablist, screenshot };
  await page.setViewportSize(desktop);
  await page.goto('/');
  await page.locator('#connection-status').filter({ hasText: 'Live' }).waitFor();
  assert.deepEqual(
    (await tablist.getByRole('tab').allTextContents()).map((name) => name.trim()),
    projectTabs.map(({ name }) => name)
  );
  try {
    const observations = [
      ...(await checkTabsAtViewport(navigation, desktop)),
      ...(await checkTabsAtViewport(navigation, narrow, '-narrow')),
    ];
    await page.setViewportSize(desktop);
    await checkAutomateAndHome(page, tablist, header);
    const controls = await checkProjectControls(page, header, poll);
    controls.push({ trigger: 'Project home', result: 'Returned to Home and cleared the selected-tab URL' });
    controls.push(...(await checkServerControls(page, header)));
    writeFileSync(
      join(output, 'project-header-proof.json'),
      JSON.stringify({ candidate, observations, controls }, null, 2)
    );
    const native = await checkNativeHistory({ page, poll, tablist, project, service, root, screenshot });
    writeFileSync(join(output, 'project-native-history.json'), JSON.stringify({ candidate, ...native }, null, 2));
  } finally {
    await page.setViewportSize(desktop);
  }
}
