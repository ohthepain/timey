import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  for (const [endpoint, next] of endpoints) {
    await page.route('**/api/' + endpoint, (route) => {
      state = next();
      return route.fulfill({ json: state });
    });
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
    for (const endpoint of endpoints.keys()) await page.unroute('**/api/' + endpoint);
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

export async function projectNavigationBrowserChecks({ page, poll, screenshot, output, candidate }) {
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
  } finally {
    await page.setViewportSize(desktop);
  }
}
