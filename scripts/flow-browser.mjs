import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { FactoryUI } from './factory-ui/service.mjs';
import { createFactoryServer } from './factory-ui/http.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { git } from './factory-ui/common.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(
  process.env.TIMEY_FLOW_BROWSER_OUTPUT || join(root, '.issues/evidence/flow-browser-' + randomUUID())
);
const project = join(output, 'project');
mkdirSync(output, { recursive: true });
mkdirSync(project);
mkdirSync(join(project, '.issues'), { recursive: true });
git(project, 'init', '-q', '-b', 'dev');
git(project, 'config', 'user.name', 'Flow browser fixture');
git(project, 'config', 'user.email', 'flow-browser@example.invalid');
writeFileSync(join(project, 'source.txt'), 'Original fixture source.\n');
git(project, 'add', 'source.txt');
git(project, 'commit', '-qm', 'Browser fixture base');
const branchTree = git(project, 'rev-parse', 'HEAD^{tree}');
const datedBranch = (date) =>
  execFileSync('git', ['-C', project, 'commit-tree', branchTree, '-m', 'Branch selector fixture'], {
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    encoding: 'utf8',
  }).trim();
const recentBranchCommit = datedBranch('2030-01-02T12:00:00Z');
git(project, 'branch', 'recent', recentBranchCommit);
git(project, 'branch', 'same-tip', recentBranchCommit);
git(project, 'branch', 'older', datedBranch('2000-01-01T12:00:00Z'));
git(project, 'update-ref', 'refs/remotes/origin/recent', recentBranchCommit);
git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/recent');

const assets = ['flow.html', 'flow.css', 'flow-ui.js'];
const fingerprint = () =>
  Object.fromEntries(
    assets.map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(join(root, 'scripts/factory-ui', name)))
        .digest('hex'),
    ])
  );
const candidate = { revision: git(root, 'rev-parse', 'HEAD'), assets: fingerprint() };
const results = [];
const logs = {
  console: [],
  pageErrors: [],
  requests: [],
  responses: [],
  failedRequests: [],
  cancelledReads: [],
  execution: [],
  modelCalls: [],
};
const service = new FactoryUI(project);
service.codex.ready = async () => {
  logs.modelCalls.push('ready');
  throw Error('This browser fixture must never start a model.');
};
service.codex.call = async (method) => {
  logs.modelCalls.push(method);
  throw Error('Unexpected model call ' + method);
};
const executor = {
  async run({ signal, onProgress, block, issue }) {
    const number = logs.execution.length + 1;
    logs.execution.push({ number, blockId: block.id, issueId: issue.id });
    onProgress('Fixture output for explicit attempt ' + number + '.\n');
    if (number === 1) {
      await new Promise((_, reject) => {
        if (signal.aborted) return reject(Error('Stopped by the user.'));
        signal.addEventListener('abort', () => reject(Error('Stopped by the user.')), { once: true });
      });
    }
    const evidence = join(project, 'flow-browser-result.txt');
    writeFileSync(evidence, 'Explicit browser retry completed.\n');
    return {
      summary: 'Explicit browser retry completed.',
      evidence: [{ path: evidence, label: 'Browser retry evidence' }],
    };
  },
  close() {},
};
service.flows = createIssueFlows(service, { executor });
const server = createFactoryServer(service);
const require = createRequire(import.meta.url);
const playwrightRequire = createRequire(require.resolve('@playwright/cli/package.json'));
const { chromium } = playwrightRequire('playwright');
let browser;
let page;
let issueId;
let addedId;
let passed = false;
let failure;
async function check(name, run) {
  try {
    await run();
    results.push({ name, passed: true });
    console.log('PASS ' + name);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
    throw error;
  }
}
async function view() {
  const response = await page.request.get('/api/flow?issue=' + issueId);
  assert.equal(response.status(), 200);
  const data = await response.json();
  assert.ok(data.flow, JSON.stringify(data));
  return data;
}
async function poll(read, predicate, message) {
  const deadline = Date.now() + 15000;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(message + '\n' + JSON.stringify(value));
}
async function clickAction(locator) {
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith('/api/flow-action') && response.request().method() === 'POST'
  );
  await locator.click();
  const response = await responsePromise;
  const value = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(value));
  assert.ok(!value.error, JSON.stringify(value));
  return value;
}
async function block(id) {
  await page.locator('[data-block="' + id + '"]').click();
  await page.locator('#tab-details').click();
}
async function screenshot(name) {
  await page.screenshot({ path: join(output, name + '.png'), fullPage: true });
}
async function selectedGeometry() {
  return page.evaluate(() => {
    const scroll = document.getElementById('graph-scroll');
    const card = document.querySelector('[data-block][aria-pressed="true"]');
    const bounds = scroll.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    const centered = scroll.scrollTop + rect.top + rect.height / 2 - bounds.top - scroll.clientHeight / 2;
    return {
      blockId: card.dataset.block,
      scrollTop: scroll.scrollTop,
      centerOffset: rect.top + rect.height / 2 - bounds.top - scroll.clientHeight / 2,
      expectedCenter: Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, centered)),
    };
  });
}
async function graphGeometry() {
  return page.evaluate(() => {
    const scroll = document.getElementById('graph-scroll');
    const viewport = scroll.getBoundingClientRect();
    const first = document.querySelector('[data-node="__base"]').getBoundingClientRect();
    const last = document.querySelector('[data-node="__destination"]').getBoundingClientRect();
    return {
      start: first.top - viewport.top,
      end: last.bottom - viewport.top - scroll.clientHeight,
      leadingRoom: first.top - viewport.top + scroll.scrollTop,
      trailingRoom: scroll.scrollHeight - (last.bottom - viewport.top + scroll.scrollTop),
      range: scroll.scrollHeight - scroll.clientHeight,
      viewportHeight: scroll.clientHeight,
      contentHeight: last.bottom - first.top,
    };
  });
}

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseURL = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 960 } });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('console', (message) =>
    logs.console.push({ type: message.type(), text: message.text(), location: message.location() })
  );
  page.on('pageerror', (error) => logs.pageErrors.push(error.stack));
  page.on('request', (request) =>
    logs.requests.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postData() })
  );
  page.on('requestfailed', (request) => {
    const failure = { url: request.url(), error: request.failure() };
    const cancelledRead =
      request.method() === 'GET' &&
      new URL(request.url()).pathname === '/api/flow' &&
      failure.error?.errorText === 'net::ERR_ABORTED';
    logs[cancelledRead ? 'cancelledReads' : 'failedRequests'].push(failure);
  });
  page.on('response', (response) =>
    logs.responses.push({ path: new URL(response.url()).pathname, status: response.status() })
  );
  await check('Opening the workspace starts no work and loads no skills', async () => {
    await page.goto('/');
    await page.locator('#connection-status').filter({ hasText: 'Live' }).waitFor();
    assert.equal(logs.execution.length, 0);
    assert.equal(logs.modelCalls.length, 0);
    assert.equal(logs.requests.filter((item) => item.path === '/api/flow-skills').length, 0);
    assert.equal(await page.locator('#new-issue').count(), 1);
    await screenshot('empty-desktop');
  });
  await check('Project settings explain missing configuration and initialize it only on request', async () => {
    const labels = join(project, '.issues/triage-labels.md');
    await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    await page.getByText('Lifecycle configuration is missing.', { exact: true }).waitFor();
    await screenshot('project-settings-missing');
    assert.equal(logs.execution.length, 0);
    assert.equal(logs.modelCalls.length, 0);
    await page.keyboard.press('Escape');
    assert.throws(() => readFileSync(labels), /ENOENT/);
    await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    await page.getByRole('button', { name: 'Initialize lifecycle configuration', exact: true }).click();
    await page.getByText('Lifecycle configuration is present.', { exact: true }).waitFor();
    const saved = readFileSync(labels, 'utf8');
    assert.match(saved, /ready-to-close/);
    assert.equal(logs.execution.length, 0);
    assert.equal(logs.modelCalls.length, 0);
    await page.keyboard.press('Escape');
    await page.reload();
    await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    await page.getByText('Lifecycle configuration is present.', { exact: true }).waitFor();
    assert.equal(readFileSync(labels, 'utf8'), saved);
    await screenshot('project-settings-configured');
    await page.keyboard.press('Escape');
  });
  const description =
    'Understand why the save button loses text\nDone: The text survives a reload.\nProof: Retained saved text.\nKnown facts: The problem occurs after refresh.\nConstraints: Reproduce before changing code.';
  await check('Capture retains typed wording and selected issue type', async () => {
    await page.locator('#new-issue').click();
    await page.locator('#capture-description').fill(description);
    await page.locator('#capture-type').selectOption('investigation');
    const data = await clickAction(page.locator('#capture-submit'));
    issueId = data.issue.id;
    await page.locator('#request-form').waitFor();
    assert.equal(await page.locator('[name="wording"]').inputValue(), description);
    assert.equal(await page.locator('#request-form [name="type"]').inputValue(), 'investigation');
    assert.equal(data.flow.request.doneCheck, 'The text survives a reload.');
    assert.equal(logs.execution.length, 0);
  });
  await check('New issues open with Starting point flush with the viewport top', async () => {
    await poll(graphGeometry, (value) => Math.abs(value.start) < 2, 'Starting point was not aligned with the top.');
    assert.equal((await selectedGeometry()).blockId, 'request');
    assert.equal(await page.locator('.graph-note').count(), 0);
    assert.equal(logs.execution.length, 0);
  });
  await check('Starting point lists every branch in date order, saves selection and survives polling', async () => {
    const selector = page.locator('#starting-branch');
    const data = await view();
    const options = await selector
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, text: node.textContent })));
    assert.deepEqual(
      options.map((item) => item.value),
      data.branches.map((item) => item.ref)
    );
    for (const ref of ['refs/heads/recent', 'refs/heads/same-tip', 'refs/remotes/origin/recent']) {
      assert.ok(options.some((item) => item.value === ref && item.text.includes(recentBranchCommit.slice(0, 7))));
      assert.ok(
        options.findIndex((item) => item.value === ref) < options.findIndex((item) => item.value === 'refs/heads/older')
      );
    }
    assert.ok(!options.some((item) => item.value === 'refs/remotes/origin/HEAD'));
    await selector.focus();
    await page.waitForResponse((response) => response.url().includes('/api/flow?issue='));
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      'starting-branch',
      'Polling interrupted the branch selector.'
    );
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/flow-action'));
    await selector.selectOption('refs/heads/recent');
    assert.equal((await saved).status(), 200);
    await page.locator('#issue-title').click();
    await poll(
      view,
      (value) => value.flow.startingPoint?.ref === 'refs/heads/recent',
      'The chosen branch was not saved.'
    );
    await page.reload();
    await selector.waitFor();
    assert.equal(await selector.inputValue(), 'refs/heads/recent');
    const selected = await view();
    assert.equal(selected.defaultStartingRef, 'refs/heads/recent');
    assert.equal(selected.flow.startingPoint.commit, recentBranchCommit);
    assert.deepEqual(selected.flow.target, data.flow.target);
    assert.equal(logs.execution.length, 0);
    await screenshot('starting-branch-selected');
  });
  await check('Graph bounds stay close to the first and last blocks at every viewport height', async () => {
    for (const height of [960, 1600]) {
      await page.setViewportSize({ width: 1440, height });
      await page.reload();
      await page.locator('#request-form').waitFor();
      await poll(graphGeometry, (value) => Math.abs(value.start) < 2, 'A new issue did not open at its top edge.');
      const bounds = await graphGeometry();
      assert.ok(bounds.leadingRoom >= 0 && bounds.leadingRoom <= 24, 'Excess space before Starting point.');
      assert.ok(
        bounds.trailingRoom >= 0 &&
          bounds.trailingRoom <= Math.max(0, bounds.viewportHeight - bounds.contentHeight) + 24,
        'Excess scroll space after Destination.'
      );
      assert.ok(
        bounds.range <= Math.max(0, bounds.contentHeight - bounds.viewportHeight) + 48,
        'The graph has blank scroll extents beyond its content.'
      );
    }
    await screenshot('bounded-new-tall');
    await page.setViewportSize({ width: 1440, height: 960 });
  });
  let closedId;
  await check('Closed issues open with Destination flush with the bottom, including short flows', async () => {
    const closed = await service.flows.capture({
      requestId: randomUUID(),
      description: 'Retained closed layout fixture',
      type: 'investigation',
    });
    closedId = closed.issue.id;
    assert.equal(
      closed.flow.startingPoint.ref,
      'refs/heads/recent',
      'The next issue did not inherit the saved default.'
    );
    const source = join(project, '.issues', closedId + '.md');
    writeFileSync(source, readFileSync(source, 'utf8').replace('state: backlog', 'state: closed'));
    mkdirSync(join(project, '.issues/closed'), { recursive: true });
    renameSync(source, join(project, '.issues/closed', closedId + '.md'));
    for (const short of [false, true]) {
      if (short) service.flows.store.save({ ...closed.flow, blocks: [closed.flow.blocks[0]] }, closed.flow.revision);
      await page.goto('/flow?issue=' + closedId);
      await page.locator('[data-node="__destination"]').waitFor();
      await poll(graphGeometry, (value) => Math.abs(value.end) < 2, 'The closed Destination was not bottom aligned.');
      const bounds = await graphGeometry();
      assert.ok(bounds.range <= Math.max(0, bounds.contentHeight - bounds.viewportHeight) + 48);
      await page.locator('#refresh').click();
      assert.ok(Math.abs((await graphGeometry()).end) < 2, 'Polling moved a closed issue away from Destination.');
    }
    await screenshot('bounded-closed');
    await page.setViewportSize({ width: 1440, height: 1600 });
    await page.reload();
    await page.locator('[data-node="__destination"]').waitFor();
    await poll(
      graphGeometry,
      (value) => Math.abs(value.end) < 2,
      'A short closed flow was not bottom aligned in a tall viewport.'
    );
    await screenshot('bounded-closed-tall');
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto('/flow?issue=' + issueId);
    await page.locator('#request-form').waitFor();
    assert.equal(logs.execution.length, 0);
  });
  await check('Numbered full issue names wrap and sidebar resizing survives reload', async () => {
    const data = await view();
    const name = page.locator('[data-issue="' + issueId + '"] .issue-name');
    assert.equal(await name.textContent(), '#' + data.issue.issueNumber + ' - ' + data.issue.title);
    const separator = page.locator('#sidebar-resizer');
    const before = await page.locator('.sidebar').boundingBox();
    const handle = await separator.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 85, handle.y + handle.height / 2, { steps: 8 });
    await page.mouse.up();
    const dragged = await page.locator('.sidebar').boundingBox();
    assert.ok(dragged.width > before.width + 60, 'Dragging did not widen the sidebar.');
    await separator.press('ArrowLeft');
    const resized = await page.locator('.sidebar').boundingBox();
    assert.ok(resized.width < dragged.width, 'Keyboard resize did not reduce the sidebar.');
    await page.reload();
    await page.locator('#request-form').waitFor();
    assert.ok(Math.abs((await page.locator('.sidebar').boundingBox()).width - resized.width) < 2);
    await separator.press('Home');
    const text = await name.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        height: element.clientHeight,
        lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2,
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        whiteSpace: style.whiteSpace,
      };
    });
    assert.notEqual(text.whiteSpace, 'nowrap');
    assert.ok(text.height > text.lineHeight, 'The long issue name does not wrap.');
    assert.ok(text.scrollWidth <= text.width, 'Issue text is clipped horizontally.');
  });
  const edited = {
    wording: description + '\nKeep this exact wording.',
    goal: 'Understand and preserve saved text.',
    doneCheck: 'Saved text is visible after two reloads.',
    proof: 'A retained screen and saved record.',
    knownFacts: 'The browser can reproduce this on refresh.',
    constraints: 'Keep the original request and every attempt.',
  };
  await check('Inspector resizing persists, supports the keyboard and respects both column bounds', async () => {
    const separator = page.locator('#inspector-resizer');
    const before = await page.locator('.inspector').boundingBox();
    const handle = await separator.boundingBox();
    const graphScroll = await page.locator('#graph-scroll').evaluate((node) => node.scrollTop);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 - 90, handle.y + handle.height / 2, { steps: 8 });
    await page.mouse.up();
    const dragged = await page.locator('.inspector').boundingBox();
    assert.ok(dragged.width > before.width + 70, 'Dragging left did not widen the inspector.');
    assert.ok(
      Math.abs((await page.locator('#graph-scroll').evaluate((node) => node.scrollTop)) - graphScroll) < 2,
      'Resizing the inspector scrolled the graph.'
    );
    await separator.press('ArrowRight');
    const resized = await page.locator('.inspector').boundingBox();
    assert.ok(resized.width < dragged.width, 'The right arrow did not move the inspector boundary right.');
    await page.reload();
    await page.locator('#request-form').waitFor();
    assert.ok(
      Math.abs((await page.locator('.inspector').boundingBox()).width - resized.width) < 2,
      'Inspector width was not retained after reload.'
    );
    await separator.press('End');
    await page.locator('#sidebar-resizer').press('End');
    for (const width of [1440, 1080, 940]) {
      await page.setViewportSize({ width, height: 960 });
      const layout = await poll(
        () =>
          page.evaluate(() => ({
            total: [...document.querySelectorAll('.sidebar, .flow-main, .inspector')].reduce(
              (sum, node) => sum + node.getBoundingClientRect().width,
              0
            ),
            graph: document.querySelector('.flow-main').getBoundingClientRect().width,
            minimum: innerWidth <= 1180 ? 310 : 380,
          })),
        (value) => value.total <= width + 1,
        'Combined saved pane widths did not settle within the viewport.'
      );
      assert.ok(layout.total <= width + 1, 'Combined saved pane widths overflow the viewport.');
      assert.ok(layout.graph >= layout.minimum - 1, 'Pane resizing squeezed the graph below its minimum.');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await separator.isVisible(),
      false,
      'A horizontal resize handle remains visible in the stacked layout.'
    );
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1440, height: 960 });
    assert.equal(await separator.isVisible(), true);
    await page.locator('#sidebar-resizer').press('Home');
    await separator.press('Home');
    const restored = await page.locator('.inspector').boundingBox();
    const edge = await separator.boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 - (390 - restored.width), edge.y + edge.height / 2);
    await page.mouse.up();
    await screenshot('resizable-inspector');
    assert.equal(logs.execution.length, 0);
  });
  await check('All request fields and type survive saving and reload', async () => {
    for (const [name, value] of Object.entries(edited))
      await page.locator('#request-form [name="' + name + '"]').fill(value);
    await page.locator('#request-form [name="type"]').selectOption('bug');
    await clickAction(page.locator('#request-form button[type="submit"]'));
    await page.reload();
    await page.locator('#request-form').waitFor();
    for (const [name, value] of Object.entries(edited))
      assert.equal(await page.locator('#request-form [name="' + name + '"]').inputValue(), value);
    const data = await view();
    assert.equal(data.flow.type, 'bug');
    assert.deepEqual(data.flow.request, edited);
  });
  await check('Folders can be created and assigned without running work', async () => {
    await page.locator('#new-folder').click();
    await page.locator('#folder-name').fill('Next release');
    await clickAction(page.locator('#folder-form button[type="submit"]'));
    await page.locator('#folder-dialog').waitFor({ state: 'hidden' });
    await block('request');
    await page.locator('#issue-folder').selectOption('Next release');
    await clickAction(page.locator('#issue-folder-form button[type="submit"]'));
    await poll(view, (data) => data.flow.folder === 'Next release', 'Folder assignment was not retained.');
    await page.locator('.issue-folder .issue-row').filter({ hasText: 'Understand why' }).waitFor();
    assert.equal(logs.execution.length, 0);
  });
  await check('Adding and saving a block retains skill, instructions and parallel lane', async () => {
    await page.getByRole('button', { name: 'Add a step', exact: true }).click();
    const data = await clickAction(page.locator('[data-add-kind="understand"]'));
    addedId = data.flow.blocks.find((item) => item.kind === 'understand' && item.id !== 'work').id;
    await page.locator('#palette-dialog').waitFor({ state: 'hidden' });
    await block(addedId);
    await page.locator('#block-form [name="label"]').fill('Read the save behavior');
    await page.locator('#block-form [name="skill"]').selectOption('how');
    await page.locator('#block-form [name="prompt"]').fill('Trace how saving works and retain exact evidence.');
    await page.locator('#block-form [name="lane"]').selectOption('1');
    await clickAction(page.locator('#block-form button[type="submit"]'));
    const saved = (await view()).flow.blocks.find((item) => item.id === addedId);
    assert.equal(saved.label, 'Read the save behavior');
    assert.equal(saved.skill, 'how');
    assert.equal(saved.prompt, 'Trace how saving works and retain exact evidence.');
    assert.equal(saved.lane, 1);
    assert.equal(saved.attempts.length, 0);
    assert.equal(logs.modelCalls.length, 0);
  });
  await check('Sequence controls reorder saved blocks', async () => {
    const before = (await view()).flow.blocks.map((item) => item.id);
    await clickAction(page.locator('[data-action="move"][data-direction="up"]'));
    const after = (await view()).flow.blocks.map((item) => item.id);
    assert.equal(after.indexOf(addedId), before.indexOf(addedId) + 1);
    assert.deepEqual(new Set(after), new Set(before));
    await screenshot('flow-desktop');
  });
  await check('The graph and every dependency run from top to bottom', async () => {
    const data = await view();
    const positions = await page
      .locator('[data-node]')
      .evaluateAll((nodes) =>
        Object.fromEntries(nodes.map((node) => [node.dataset.node, node.getBoundingClientRect().top]))
      );
    for (const item of data.flow.blocks) {
      assert.ok(positions.__base < positions[item.id]);
      assert.ok(positions[item.id] < positions.__destination);
      for (const parent of item.after) assert.ok(positions[parent] < positions[item.id]);
    }
    const add = await page.getByRole('button', { name: 'Add a step', exact: true }).boundingBox();
    assert.ok(Math.abs(add.width - add.height) < 1, 'The add-step control is not circular.');
    const paths = await page
      .locator('.graph-lines path')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('d')));
    for (const path of paths) {
      const numbers = path.match(/-?\d+(?:\.\d+)?/g).map(Number);
      assert.ok(numbers[1] < numbers.at(-1), 'A connection points upward.');
    }
  });
  await check('Block clicks preserve visible cards and minimally reveal clipped cards', async () => {
    await page.setViewportSize({ width: 1440, height: 600 });
    const target = page.locator('[data-block="work"]');
    await target.evaluate((node) => {
      const scroll = document.getElementById('graph-scroll');
      scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 80;
    });
    const before = await page.locator('#graph-scroll').evaluate((node) => node.scrollTop);
    let bounds = await target.boundingBox();
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await poll(selectedGeometry, (value) => value.blockId === 'work', 'The visible block was not selected.');
    assert.ok(Math.abs((await selectedGeometry()).scrollTop - before) < 2, 'Selecting a visible card jumped.');
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/flow?')),
      page.locator('#refresh').click(),
    ]);
    assert.ok(Math.abs((await selectedGeometry()).scrollTop - before) < 2, 'Refreshing shifted the graph.');
    await target.evaluate((node) => {
      const scroll = document.getElementById('graph-scroll');
      scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 30;
    });
    const clipped = await selectedGeometry();
    bounds = await target.boundingBox();
    const viewport = await page.locator('#graph-scroll').boundingBox();
    assert.ok(bounds.y < viewport.y - 20, 'The test card must be clipped before selection.');
    await page.mouse.click(bounds.x + bounds.width / 2, viewport.y + 20);
    await poll(
      selectedGeometry,
      (value) => value.scrollTop < clipped.scrollTop - 20,
      'The clipped card was not revealed.'
    );
    const revealed = await target.boundingBox();
    const after = await selectedGeometry();
    assert.ok(revealed.y >= viewport.y - 1);
    assert.ok(revealed.y + revealed.height <= viewport.y + viewport.height + 1);
    assert.ok(clipped.scrollTop - after.scrollTop <= 55, 'The card moved further than necessary.');
    await page.setViewportSize({ width: 1440, height: 960 });
  });
  await check('Block comments remain attached after reload', async () => {
    await block(addedId);
    await page.locator('#comment-form [name="comment"]').fill('Keep every partial attempt for review.');
    await clickAction(page.locator('#comment-form button[type="submit"]'));
    await page.reload();
    await page.locator('[data-block="' + addedId + '"]').waitFor();
    await block(addedId);
    await page.locator('.message-body').filter({ hasText: 'Keep every partial attempt for review.' }).waitFor();
    assert.equal((await view()).flow.blocks.find((item) => item.id === addedId).comments.length, 1);
    assert.equal(logs.execution.length, 0);
  });
  await check('Header Continue retains draft guards, exposes progress and disables during a run', async () => {
    await block('work');
    await page.locator('#block-form [name="label"]').fill('Work with saved settings');
    await page.locator('#continue-block').click();
    assert.equal(logs.execution.length, 0);
    await page.locator('#error-banner').waitFor();
    await clickAction(page.locator('#block-form button[type="submit"]'));
    await clickAction(page.locator('#continue-block'));
    await poll(
      view,
      (data) => data.flow.blocks.find((item) => item.id === 'work').attempts[0]?.output.includes('attempt 1'),
      'Progress output was not saved.'
    );
    await page.locator('.attempt-output').filter({ hasText: 'explicit attempt 1' }).waitFor();
    assert.equal(logs.execution.length, 1);
    assert.equal(await page.locator('#continue-block').isDisabled(), true);
    assert.equal(
      await page.locator('#starting-branch').isDisabled(),
      true,
      'A running issue allows its starting branch to change.'
    );
    await page.reload();
    await page.locator('[data-block="work"][aria-pressed="true"]').waitFor();
    await poll(
      selectedGeometry,
      (value) => Math.abs(value.scrollTop - value.expectedCenter) < 2,
      'The running block was not centered within its content bounds on reload.'
    );
    await screenshot('work-running-desktop');
    await clickAction(page.locator('[data-action="stop"]'));
    const stopped = await poll(
      view,
      (data) => data.flow.blocks.find((item) => item.id === 'work').attempts[0]?.status === 'stopped',
      'Stop was not retained.'
    );
    const attempt = stopped.flow.blocks.find((item) => item.id === 'work').attempts[0];
    assert.match(attempt.output, /explicit attempt 1/);
    assert.ok(stopped.flow.blocks.filter((item) => item.suggested).every((item) => item.attempts.length === 0));
  });
  await check('Retry retains both attempts and does not start the next block', async () => {
    await page.locator('[data-action="start"]').filter({ hasText: 'Retry block' }).waitFor();
    await clickAction(page.locator('[data-action="start"]'));
    const completed = await poll(
      view,
      (data) => data.flow.blocks.find((item) => item.id === 'work').attempts.at(-1)?.status === 'completed',
      'Retry did not complete.'
    );
    const attempts = completed.flow.blocks.find((item) => item.id === 'work').attempts;
    assert.deepEqual(
      attempts.map((item) => item.status),
      ['stopped', 'completed']
    );
    assert.match(attempts[0].output, /explicit attempt 1/);
    assert.match(attempts[1].output, /explicit attempt 2/);
    assert.ok(completed.flow.blocks.filter((item) => item.suggested).every((item) => item.attempts.length === 0));
    assert.equal(logs.execution.length, 2);
    await page.locator('.detail-copy').filter({ hasText: 'Explicit browser retry completed.' }).waitFor();
    await screenshot('work-completed-desktop');
  });
  await check('Artifacts can be inspected through the real file route', async () => {
    await page.locator('#tab-artifacts').click();
    const artifact = page.locator('.artifact').filter({ hasText: 'Browser retry evidence' });
    await artifact.locator('[data-open-file]').click();
    await page.locator('#file-dialog').waitFor();
    await poll(
      () => page.locator('#file-content').textContent(),
      (value) => value === 'Explicit browser retry completed.\n',
      'Artifact contents were not shown.'
    );
    await screenshot('artifact-desktop');
    await page.locator('[aria-label="Close artifact"]').click();
  });
  await check('Reload retains flow settings, comments, folder and attempt history', async () => {
    await page.reload();
    await page.locator('[data-block="work"][aria-pressed="true"]').waitFor();
    const data = await view();
    assert.equal(data.flow.folder, 'Next release');
    assert.deepEqual(data.flow.request, edited);
    const added = data.flow.blocks.find((item) => item.id === addedId);
    assert.equal(added.skill, 'how');
    assert.equal(added.lane, 1);
    assert.equal(added.comments[0].text, 'Keep every partial attempt for review.');
    assert.deepEqual(
      data.flow.blocks.find((item) => item.id === 'work').attempts.map((item) => item.status),
      ['stopped', 'completed']
    );
    assert.equal(logs.execution.length, 2);
    assert.equal(logs.modelCalls.length, 0);
    assert.equal(logs.requests.filter((item) => item.path === '/api/flow-skills').length, 0);
  });
  await check('The responsive workspace keeps controls usable', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await block('work');
    await page.locator('#block-form').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#block-form [name="label"]').isVisible(), true);
    assert.equal(await page.locator('#new-issue').isVisible(), true);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'The page overflows its viewport.'
    );
    await screenshot('flow-responsive');
    await page.locator('#new-issue').click();
    await page.locator('#capture-description').fill('Responsive issue draft');
    assert.equal(await page.locator('#capture-submit').isVisible(), true);
    await screenshot('capture-responsive');
    await page.locator('[aria-label="Close new issue"]').click();
  });
  await check('Column edge gestures stay local and do not refresh the page', async () => {
    const touchContext = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const touchPage = await touchContext.newPage();
      let navigations = 0;
      const errors = [];
      touchPage.on('framenavigated', (frame) => {
        if (frame === touchPage.mainFrame()) navigations += 1;
      });
      touchPage.on('pageerror', (error) => errors.push(error.message));
      await touchPage.goto('/flow?issue=' + closedId);
      await touchPage.locator('[data-node="__destination"]').waitFor();
      const initialNavigations = navigations;
      const client = await touchContext.newCDPSession(touchPage);
      for (const selector of ['.issue-list', '#graph-scroll', '#inspector-body']) {
        for (const edge of ['top', 'bottom']) {
          await touchPage.locator(selector).evaluate((node, side) => {
            node.scrollTop = side === 'top' ? 0 : node.scrollHeight;
          }, edge);
          const bounds = await touchPage.locator(selector).boundingBox();
          await client.send('Input.synthesizeScrollGesture', {
            x: bounds.x + 5,
            y: Math.min(bounds.y + bounds.height / 2, 800),
            yDistance: edge === 'top' ? 220 : -220,
            speed: 600,
            gestureSourceType: 'touch',
          });
          await touchPage.waitForTimeout(200);
          assert.equal(navigations, initialNavigations, selector + ' refreshed the page at its ' + edge + ' edge.');
          assert.equal(
            await touchPage.evaluate(() => document.scrollingElement.scrollTop),
            0,
            'The gesture scrolled the outer page.'
          );
        }
      }
      assert.deepEqual(errors, []);
      await touchPage.screenshot({ path: join(output, 'bounded-touch-columns.png'), fullPage: true });
    } finally {
      await touchContext.close();
    }
  });
  await check('Candidate assets are unchanged and browser execution is clean', async () => {
    assert.deepEqual(fingerprint(), candidate.assets);
    assert.deepEqual(logs.pageErrors, []);
    assert.deepEqual(logs.failedRequests, []);
    assert.deepEqual(
      logs.console.filter((item) => item.type === 'error'),
      []
    );
    assert.equal(logs.execution.length, 2);
    assert.equal(logs.modelCalls.length, 0);
  });
  await check('Open worktree appears beside the branch and opens the saved checkout', async () => {
    await page.goto('/flow?issue=' + issueId);
    await page.locator('[data-node="__base"]').waitFor();
    const button = page
      .locator('#environment .environment-chip')
      .and(page.getByRole('button', { name: 'Open worktree', exact: true }));
    assert.equal(await button.count(), 0);
    const checkout = join(output, 'issue-checkout');
    git(project, 'worktree', 'add', '-qb', 'fixture-issue-worktree', checkout);
    const flow = service.flows.read(service.flows.selected(issueId));
    service.flows.store.save({ ...flow, workspace: { checkout } }, flow.revision);
    const calls = join(output, 'opened-worktree.txt');
    writeFileSync(join(output, 'open'), '#!/bin/sh\nprintf "%s\\n" "$1" > "$TIMEY_TEST_OPEN_LOG"\n', {
      mode: 0o700,
    });
    const originalPath = process.env.PATH;
    process.env.PATH = output + ':' + originalPath;
    process.env.TIMEY_TEST_OPEN_LOG = calls;
    try {
      await page.reload();
      await button.click();
      await page.getByText('Opened the worktree in Finder.', { exact: true }).waitFor();
      assert.equal(readFileSync(calls, 'utf8').trim(), realpathSync(checkout));
    } finally {
      process.env.PATH = originalPath;
      delete process.env.TIMEY_TEST_OPEN_LOG;
    }
  });
  passed = true;
} catch (error) {
  failure = error.stack;
  console.error(error);
  if (page) await screenshot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise((done) => server.close(done));
  service.close();
  writeFileSync(join(output, 'browser.log.json'), JSON.stringify(logs, null, 2));
  writeFileSync(
    join(output, 'results.json'),
    JSON.stringify(
      {
        candidate,
        output,
        project,
        results,
        passed,
        failure,
        limitations: [
          'Execution is injected and deterministic. This proves real browser, HTTP, service and persistence behavior without running models or external publication.',
        ],
      },
      null,
      2
    )
  );
  console.log('Flow browser evidence ' + output);
}
