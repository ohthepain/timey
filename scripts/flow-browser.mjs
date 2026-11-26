import {
  masterDragBrowserChecks,
  masterIssueBrowserChecks,
  manualSubIssueRemovalBrowserChecks,
} from './flow-browser-master-issues.mjs';
import { investigativeGroupingBrowserChecks } from './flow-browser-investigative-grouping.mjs';
import { issueAnnotationBrowserChecks } from './flow-browser-issue-annotations.mjs';
import { blockModelsBrowserChecks } from './flow-browser-block-models.mjs';
import { providerSettingsBrowserChecks } from './flow-browser-provider-settings.mjs';
import { activityBrowserChecks } from './flow-browser-activity.mjs';
import { chatProgressBrowserChecks } from './flow-browser-chat-progress.mjs';
import { inboxDiscussBrowserChecks, inboxFlowBrowserChecks } from './flow-browser-inbox.mjs';
import { investigationReportsBrowserChecks } from './flow-browser-investigation-reports.mjs';
import { issueStatusFoldersBrowserChecks } from './flow-browser-issue-status-folders.mjs';
import { projectIssuesBrowserChecks } from './flow-browser-project-issues.mjs';
import { serverHeapBrowserChecks } from './flow-browser-server-heap.mjs';
import { errorRecoveryBrowserChecks } from './flow-browser-error-recovery.mjs';
import { mergeStateBrowserChecks } from './flow-browser-merge-state.mjs';
import {
  flowBrowserCiParts,
  flowBrowserOrderModifier,
  flowBrowserScenarioNames,
  flowBrowserScenarioSelected,
} from './browser-scenario-policy.mjs';
import { branchRepairBrowserChecks } from './flow-browser-branch-repair.mjs';
import { blockSkillsBrowserChecks } from './flow-browser-block-skills.mjs';
import { nativeAgentBrowserChecks } from './flow-browser-native-agents.mjs';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { FactoryUI } from './factory-ui/service.mjs';
import { createFactoryServer } from './factory-ui/http.mjs';
import { deliveryTarget, requestData, startingPoint } from './factory-ui/flow-block-data.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { createFlowExecutor } from './factory-ui/flow-executor.mjs';
import { requiredPRReview } from './factory-ui/flow-human-input.mjs';
import { readProjectSettings } from './factory-ui/project-settings.mjs';
import { saveLifecycle } from './factory-ui/lifecycle-store.mjs';
import { moveStoredIssue, updateStoredIssueMetadata } from './factory-ui/issue-report-storage.mjs';
import { git } from './factory-ui/common.mjs';
import { flowIssueFoldersBrowserChecks } from './flow-browser-issue-folders.mjs';
import { flowBlockDeletionBrowserChecks } from './flow-browser-block-deletion.mjs';
import { flowFolderSettingsBrowserChecks } from './flow-browser-folder-settings.mjs';
import { flowFollowupsBrowserChecks } from './flow-browser-followups.mjs';
import { investigationProposals } from './investigation-followups-fixture.mjs';
import { withQueueConfiguration } from './flow-browser-queue-configuration.mjs';
import { projectNavigationBrowserChecks, unavailableNavigationIssue } from './flow-browser-project-navigation.mjs';
import {
  projectHomeBrowserChecks,
  investigationFlowsBrowserChecks,
  investigationToolbarBrowserChecks,
  automateActivityBrowserChecks,
} from './flow-browser-project-home.mjs';
import { projectDiscussBrowserChecks } from './flow-browser-project-discuss.mjs';
import { assetStorageBrowserChecks } from './flow-browser-asset-storage.mjs';
import { projectSettingsBrowserChecks } from './flow-browser-project-settings.mjs';
import { aiTextBrowserChecks } from './flow-browser-ai-text.mjs';
import { interfaceStateBrowserChecks } from './flow-browser-interface-state.mjs';
import { inboxChatBrowserChecks } from './flow-browser-inbox-chat.mjs';
import { inboxDetailsBrowserChecks } from './flow-browser-inbox-details.mjs';
import { localNotesBrowserChecks } from './flow-browser-local-notes.mjs';
import { actionsMenuBrowserChecks } from './flow-browser-actions-menu.mjs';
import { mergedIssueBrowserChecks } from './flow-browser-merged-issue.mjs';
import { manualCloseBrowserChecks } from './flow-browser-manual-close.mjs';
import { noChangesBrowserChecks } from './flow-browser-no-changes.mjs';
import { importBrowserIssue, removeBrowserIssue, writeBrowserIssue } from './flow-browser-fixture.mjs';
import { issueStoresBrowserChecks } from './flow-browser-stores.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ciPart = process.argv.find((argument) => argument.startsWith('--ci-part='));
assert.ok(!ciPart || flowBrowserCiParts.has(ciPart), 'Choose Flow browser CI part 1, 1a, 1b or 2.');
const parts = {
  '--ci-part=1': ['--ci-part=1a', '--ci-part=1b'],
  '--ci-part=1a': ['--ci-part=1a'],
  '--ci-part=1b': ['--ci-part=1b'],
  '--ci-part=2': ['--ci-part=2'],
};
const selectedParts = parts[ciPart] ?? Object.keys(parts);
let part = '--ci-part=1a';
const outputPath = resolve(
  process.env.TIMEY_FLOW_BROWSER_OUTPUT ||
    (process.env.TIMEY_BROWSER_OUTPUT && join(process.env.TIMEY_BROWSER_OUTPUT, 'flow')) ||
    join(root, '.issues/evidence/flow-browser-' + randomUUID())
);
mkdirSync(outputPath, { recursive: true });
const output = realpathSync(outputPath);
const project = join(output, 'project');
mkdirSync(project);
mkdirSync(join(project, '.issues'), { recursive: true });
git(project, 'init', '-q', '-b', 'dev');
git(project, 'config', 'user.name', 'Flow browser fixture');
git(project, 'config', 'user.email', 'flow-browser@example.invalid');
writeFileSync(join(project, 'source.txt'), 'Original fixture source.\n');
writeFileSync(join(project, '.gitignore'), '/.issues/\n');
git(project, 'add', 'source.txt', '.gitignore');
git(project, 'commit', '-qm', 'Browser fixture base');
if (ciPart === '--ci-part=2') {
  const { lifecycle } = readProjectSettings(project);
  writeFileSync(join(project, lifecycle.path), lifecycle.content);
}
const branchTree = git(project, 'rev-parse', 'HEAD^{tree}');
const publicationTarget = git(project, 'rev-parse', 'HEAD');
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

const assets = [
  'ai-text-ui.js',
  'ai-text.css',
  'ai-text-bro.mjs',
  'view-state.js',
  'activity-indicator-ui.js',
  'flow.html',
  'index.html',
  'issue-group.css',
  'issue-group-ui.js',
  'flow.css',
  'flow-ui.js',
  'flow-order.mjs',
  'flow-interactions.css',
  'issue-store-ui.js',
  'issue-ownership-ui.js',
  'issue-folder-drag-ui.js',
  'sidebar-files-ui.js',
  'block-model-ui.js',
  'folder-settings-ui.js',
  'provider-settings-ui.js',
  'project-settings-ui.js',
  'project-asset-storage-ui.js',
  'project-settings.css',
  'project-asset-storage.css',
  'github-calls-ui.js',
  'github-calls.css',
  'diagnostics-ui.js',
  'diagnostics.css',
  'hotkeys-ui.js',
  'investigation-followups-ui.js',
  'project-home-ui.js',
  'project-discuss-ui.js',
  'project-reports-ui.js',
  'project-reports.css',
  'project-discuss.css',
  'chat-progress.css',
  'local-notes-ui.js',
  'local-notes.css',
  'issue-chat-ui.js',
  'investigation-issue-ui.js',
  'investigation-flow-controls-ui.js',
  'project-home.css',
  'issue-closure-ui.js',
  'server-control-ui.js',
  'view-inspection.js',
  '../../factory/system/flow/block-inspector.md',
  '../../factory/system/folder.md',
  '../../factory/system/flow/blocks/work.md',
];
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
const inboxDiscussCheck = 'Project chat stays at the bottom and accepts prompts while work is paused';
Object.assign(flowBrowserScenarioNames, {
  '--inbox-discuss': inboxDiscussCheck,
});
const {
  '--master-issues': masterIssuesCheck,
  '--manual-sub-issue-removal': manualSubIssueRemovalCheck,
  '--investigative-grouping': investigativeGroupingCheck,
  '--issue-annotations': issueAnnotationsCheck,
  '--inbox-flow': inboxFlowCheck,
  '--folder-settings': folderSettingsCheck,
  '--block-deletion': blockDeletionCheck,
  '--investigation-followups': followupsCheck,
  '--project-navigation': navigationCheck,
  '--server-heap': serverHeapCheck,
  '--project-home': homeCheck,
  '--investigation-reports': reportsCheck,
  '--investigation-flows': investigationFlowsCheck,
  '--project-discuss': discussCheck,
  '--project-settings': settingsCheck,
  '--asset-storage': assetStorageCheck,
  '--stores': storesCheck,
  '--ai-text': aiTextCheck,
  '--interface-state': interfaceStateCheck,
  '--issue-results': issueResultsCheck,
  '--human-input': humanInputCheck,
  '--merge-settings': mergeSettingsCheck,
  '--request-save': requestSaveCheck,
  '--block-inspection': blockInspectionCheck,
  '--storage-status': storageStatusCheck,
  '--polling': pollingCheck,
  '--capture-folder-issue': captureFolderIssueCheck,
  '--starting-point': startingPointCheck,
  '--closed-destination': closedDestinationCheck,
  '--folder-workspace-grouping': folderWorkspaceGroupingCheck,
  '--tab-source': tabSourceCheck,
  '--sidebar-issue-names': sidebarIssueNamesCheck,
  '--save-request-route': saveRequestRouteCheck,
  '--flow-menu': flowMenuCheck,
  '--add-parallel-block': addParallelBlockCheck,
  '--reorder-saved-blocks': reorderSavedBlocksCheck,
  '--block-reveal': blockRevealCheck,
  '--assign-folder': assignFolderCheck,
  '--save-block-comment': saveBlockCommentCheck,
  '--work-markdown': workMarkdownCheck,
  '--stop-work': stopWorkCheck,
  '--retry-work': retryWorkCheck,
  '--reload-flow-history': reloadFlowHistoryCheck,
  '--run-extra-work': runExtraWorkCheck,
  '--update-worktree': updateWorktreeCheck,
  '--publish-preview': publishPreviewCheck,
  '--timers': timersCheck,
  '--proposals': proposalsCheck,
} = flowBrowserScenarioNames;
let requestClarification;
const pendingResponses = [];
const logs = {
  console: [],
  pageErrors: [],
  requests: [],
  responses: [],
  failedRequests: [],
  cancelledReads: [],
  execution: [],
  modelCalls: [],
  searchCalls: [],
};
const playbackIssueId = '20261116-playback-fixture';
const playbackWork = Promise.withResolvers();
const holdFirstWork = (number, block) => number === 1 && block.kind !== 'cleanup';
let firstWorkProgress;
const service = new FactoryUI(project);
service.projectDiscussOptions = { skills: async () => [] };
const deliveryConfig = { provider: 'github', repository: 'test/fixture', remote: 'origin', target: 'dev' };
writeFileSync(join(project, '.issues/issue-delivery-config.json'), JSON.stringify(deliveryConfig));
service.codex.ready = async () => {
  logs.modelCalls.push('ready');
  throw Error('This browser fixture must never start a model.');
};
service.codex.call = async (method) => {
  logs.modelCalls.push(method);
  throw Error('Unexpected model call ' + method);
};
const executor = {
  async run({ signal, onProgress, onStep, block, issue, attempt }) {
    const number = logs.execution.length + 1;
    logs.execution.push({ number, blockId: block.id, issueId: issue.id });
    onStep('pnpm test');
    onProgress('Fixture output for explicit attempt ' + number + '.\n');
    if (issue.id === playbackIssueId && block.kind === 'work') await playbackWork.promise;
    if (holdFirstWork(number, block)) {
      firstWorkProgress = { onProgress, onStep };
      await new Promise((_, reject) => {
        if (signal.aborted) return reject(Error('Stopped by the user.'));
        signal.addEventListener('abort', () => reject(Error('Stopped by the user.')), { once: true });
      });
    }
    const evidence = join(project, '.issues', 'flow-browser-result-' + attempt.id + '.txt');
    writeFileSync(evidence, 'Explicit browser retry completed.\n');
    return {
      summary: 'Explicit browser retry completed.',
      evidence: [{ path: evidence, label: 'Browser retry evidence' }],
    };
  },
  close() {},
};
service.flows = createIssueFlows(service, {
  executor,
  proposeInvestigationFollowups: async () => investigationProposals,
  trashDirectory(path) {
    assert.ok(path.startsWith(realpathSync(project) + '/user/'));
    const trash = join(output, 'Trash');
    mkdirSync(trash, { recursive: true });
    renameSync(path, join(trash, 'folder-' + randomUUID()));
  },
  searchFolderIssues(query, issues) {
    logs.searchCalls.push({ query, issues });
    return issues.map(({ id }) => ({ id, reason: 'Relevant issue from the full folder view.' }));
  },
  recommendFolderIssues(_strategy, issues) {
    return issues.map(({ id }) => ({ id, reason: 'The fixture requests share save behavior.' }));
  },
  deliveryOptions: {
    validateSummary() {},
    provider: {
      config: deliveryConfig,
      credentials: {
        async session() {
          return { slug: 'factory' };
        },
      },
      async findIssueBranchPR() {
        return null;
      },
      async gh() {
        return `dev\t${publicationTarget}\nolder\t${publicationTarget}\nrecent\t${recentBranchCommit}`;
      },
    },
  },
  clarify: async (_root, _definition, attempt) => {
    const wording = attempt.details.find((item) => item.key === 'wording').value;
    if (requestClarification) await requestClarification.promise;
    const fields = Object.fromEntries(
      wording
        .split('\n')
        .slice(1)
        .filter((line) => /^(type|goal|requestedProof|knownFacts|constraints): /.test(line))
        .map((line) => {
          const [key, ...value] = line.split(': ');
          return [key, value.join(': ')];
        })
    );
    return { artifacts: { values: fields }, summary: fields.goal };
  },
});
const server = createFactoryServer(service);
const require = createRequire(import.meta.url);
const playwrightRequire = createRequire(require.resolve('@playwright/cli/package.json'));
const { chromium } = playwrightRequire('playwright');
let browser;
let page;
let issueId;
let worktreeIssueId;
let addedId;
let workId;
let passed = false;
let failure;
function expectedReportConsoleError({ text, location }) {
  return (
    location?.url === 'about:srcdoc' &&
    (text.startsWith("Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed") ||
      text.startsWith("Loading the image 'https://example.invalid/report-tracker.png' violates"))
  );
}

const expectedBadRequestSuffixes = [
  '/api/ui-sources',
  '/api/site-review-sources',
  '/api/flow?issue=' + unavailableNavigationIssue,
  '/api/issue-stores?issueId=' + unavailableNavigationIssue,
];

function unexpectedConsoleErrors(entries) {
  const errors = entries.filter((item) => item.type === 'error' && !expectedReportConsoleError(item));
  return errors.filter((item) => {
    const url = item.location?.url || '';
    if (!/Failed to load resource/.test(item.text) || !item.text.includes('400')) return true;
    return !url.includes('/api/folder-settings') && !expectedBadRequestSuffixes.some((suffix) => url.endsWith(suffix));
  });
}
function consoleErrorsAfterExpectedResponses(expected) {
  const errors = unexpectedConsoleErrors(logs.console);
  const responses = logs.responses.filter(({ path, status, body }) =>
    expected.some(
      ([expectedPath, expectedStatus, error]) =>
        path === expectedPath && status === expectedStatus && body === JSON.stringify({ error })
    )
  );
  for (const { path, status } of responses) {
    const index = errors.findIndex(
      ({ location, text }) =>
        location?.url?.endsWith(path) &&
        text.startsWith('Failed to load resource') &&
        text.includes('status of ' + status)
    );
    if (index >= 0) errors.splice(index, 1);
  }
  return errors;
}

async function assertCleanSidebarConsole() {
  await Promise.all(pendingResponses);
  assert.deepEqual(
    consoleErrorsAfterExpectedResponses([
      ['/api/issue-decision', 400, 'The test rejected the pending close.'],
      ['/api/server-heap', 503, 'The test made the heap reading unavailable.'],
    ]),
    []
  );
}

async function connectionRecoveryIssue() {
  const id = '20261120-connection-recovery-fixture';
  if (!existsSync(join(project, '.issues/triage-labels.md')))
    copyFileSync(join(root, '.issues/triage-labels.md'), join(project, '.issues/triage-labels.md'));
  await writeBrowserIssue(project, {
    id,
    title: 'Reconnect the selected issue',
    body: 'Keep the selected issue after reconnecting.',
  });
  return id;
}
function checkSelected(name) {
  return selectedParts.includes(part) && flowBrowserScenarioSelected(name);
}

async function check(name, run) {
  if (!checkSelected(name)) return;
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
async function observeAction(interact) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/flow-action') &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON().action !== 'open-block',
      { timeout: 60000 }
    ),
    interact(),
  ]);
  const value = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(value));
  assert.ok(!value.error, JSON.stringify(value));
  return value;
}
function clickAction(locator) {
  return observeAction(() => locator.click());
}
async function selectBlock(id) {
  const locator = page.locator('.block-card[data-block="' + id + '"]');
  if ((await locator.getAttribute('aria-pressed')) === 'true') return;
  await page.evaluate((blockId) => {
    const scroll = document.getElementById('graph-scroll');
    const card = document.querySelector('.block-card[data-block="' + blockId + '"]');
    if (scroll && card) {
      const bounds = scroll.getBoundingClientRect();
      const rect = card.getBoundingClientRect();
      scroll.scrollTop += rect.top - bounds.top - Math.min(64, bounds.height * 0.2);
    }
  }, id);
  try {
    await locator.click({ timeout: 2500 });
  } catch {
    await page.evaluate((blockId) => document.querySelector('.block-card[data-block="' + blockId + '"]')?.click(), id);
  }
  await page.locator('.block-card[data-block="' + id + '"][aria-pressed="true"]').waitFor();
}
async function block(id) {
  await selectBlock(id);
  await page.locator('#tab-details').click();
}
async function screenshot(name) {
  await page.screenshot({ path: join(output, name + '.png'), fullPage: true });
  if (name === 'project-discuss') {
    const entries = await page.locator('.discuss-message').evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        return {
          id: node.dataset.discussMessage,
          classes: node.className,
          borderTopStyle: style.borderTopStyle,
          borderTopWidth: style.borderTopWidth,
          borderBottomStyle: style.borderBottomStyle,
          borderBottomWidth: style.borderBottomWidth,
        };
      })
    );
    writeFileSync(
      join(output, name + '-styles.json'),
      JSON.stringify(
        {
          sourceCommit: git(root, 'rev-parse', 'HEAD'),
          sourceStatus: git(root, 'status', '--porcelain'),
          observedAt: new Date().toISOString(),
          selector: '.discuss-message',
          entries,
        },
        null,
        2
      ) + '\n'
    );
  }
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
      top: rect.top - bounds.top,
      bottom: rect.bottom - bounds.top,
      viewportHeight: scroll.clientHeight,
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

async function seedSidebarOverflow() {
  const ids = Array.from({ length: 24 }, (_, index) => '20261120-sidebar-overflow-' + index);
  for (const [index, id] of ids.entries()) {
    await writeBrowserIssue(project, {
      id,
      title: 'Overflowing issue ' + index,
      body: 'Sidebar scrolling fixture.',
    });
  }
  return ids;
}

async function removeSidebarOverflow(ids) {
  for (const id of ids) await removeBrowserIssue(project, id);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  await page.locator('#sidebar-file-tree details').first().waitFor();
  assert.equal(await page.locator('#open-issues [data-issue^="20261120-sidebar-overflow-"]').count(), 0);
}

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseURL = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, channel: 'chrome', ignoreDefaultArgs: ['--hide-scrollbars'] });
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 960 } });
  page = await context.newPage();
  if (process.env.NODE_V8_COVERAGE) await page.coverage.startJSCoverage({ resetOnNavigation: false });
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
      ['/api/flow', '/api/flow-changes'].includes(new URL(request.url()).pathname) &&
      failure.error?.errorText === 'net::ERR_ABORTED';
    logs[cancelledRead ? 'cancelledReads' : 'failedRequests'].push(failure);
  });
  page.on('response', (response) => {
    const entry = { path: new URL(response.url()).pathname, status: response.status() };
    logs.responses.push(entry);
    if (response.status() >= 400)
      pendingResponses.push(
        response
          .text()
          .then((body) => {
            entry.body = body.slice(0, 4000);
            entry.request = response.request().postData();
          })
          .catch((error) => {
            entry.body = error.message;
          })
      );
  });
  await check('Manual Close remains discoverable after Merge and automatic closing needs no prompt', () =>
    manualCloseBrowserChecks({ page, project, service, output, root, poll, screenshot })
  );
  await check('Successful refresh clears rejected branch update errors', () =>
    errorRecoveryBrowserChecks({ page, service, project, output })
  );
  const noChangesCheck = () =>
    check('Publication with no changes offers Cannot Reproduce closure', () =>
      noChangesBrowserChecks({ page, service, project, output, root, poll })
    );
  if (!process.argv.includes(flowBrowserOrderModifier)) await noChangesCheck();
  await check('The whole sidebar scrolls over every section', async () => {
    const ids = await seedSidebarOverflow();
    await page.goto('/');
    await page.locator('#sidebar-file-tree details').first().waitFor();
    await page.getByRole('button', { name: 'Expand Local notes' }).click();
    await page.evaluate(() => {
      const notes = document.getElementById('local-note-list');
      const files = document.getElementById('sidebar-file-tree');
      for (let index = 0; index < 24; index++) {
        const note = document.createElement('li');
        note.className = 'local-note';
        note.textContent = 'Overflowing local note ' + index;
        notes.append(note);
        const file = document.createElement('button');
        file.className = 'sidebar-file-link';
        file.textContent = 'Overflowing file ' + index + '.md';
        files.append(file);
      }
    });
    await page.locator('#open-issues [data-issue="20261120-sidebar-overflow-0"]').waitFor();
    const observations = [];
    for (const viewport of [
      { width: 1440, height: 720 },
      { width: 760, height: 600 },
    ]) {
      await page.setViewportSize(viewport);
      for (const section of ['#local-note-list', '#sidebar-file-tree', '#issue-list']) {
        const target = page.locator(section);
        await target.scrollIntoViewIfNeeded();
        const bounds = await target.boundingBox();
        const sidebar = await page.locator('.sidebar').boundingBox();
        const y = Math.max(sidebar.y + 5, Math.min(bounds.y + 12, sidebar.y + sidebar.height - 20));
        const x = bounds.x + Math.min(bounds.width / 2, 70);
        assert.ok(
          await target.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), { x, y }),
          'Wheel pointer must be over ' + section
        );
        await page.mouse.move(x, y);
        await screenshot('sidebar-scroll-' + viewport.width + '-' + section.replace(/[^a-z]/g, ''));
        const before = await page.locator('.sidebar-footer').evaluate((node) => node.getBoundingClientRect().top);
        await page.mouse.wheel(0, 160);
        await poll(
          () => page.locator('.sidebar-footer').evaluate((node) => node.getBoundingClientRect().top),
          (top) => top < before - 20,
          'Wheel over ' + section + ' must move content outside that section'
        );
        observations.push({
          viewport,
          section,
          before,
          after: await page.locator('.sidebar-footer').evaluate((node) => node.getBoundingClientRect().top),
        });
      }
      const footer = page.locator('.sidebar-footer');
      await footer.scrollIntoViewIfNeeded();
      assert.ok(await footer.isVisible());
      const resizer = await page.locator('#sidebar-resizer').boundingBox();
      const sidebar = await page.locator('.sidebar').boundingBox();
      assert.ok(
        Math.abs(resizer.y - sidebar.y) <= 1 && Math.abs(resizer.height - sidebar.height) <= 1,
        'Sidebar resize handle must span the column below the header'
      );
      await page.locator('#sidebar-resizer').focus();
      const widthBefore = (await page.locator('.sidebar').boundingBox()).width;
      await page.keyboard.press('ArrowRight');
      assert.ok(
        (await page.locator('.sidebar').boundingBox()).width > widthBefore,
        'Sidebar remains resizable after scrolling'
      );
      await screenshot('sidebar-scroll-' + viewport.width);
    }
    writeFileSync(join(output, 'sidebar-scroll.json'), JSON.stringify({ candidate, observations }, null, 2));
    await removeSidebarOverflow(ids);
  });
  await check('Status pseudo-folders track project issues without moving them', () =>
    issueStatusFoldersBrowserChecks({ page, project, service, poll, screenshot, output, root })
  );
  await check('Closed issue selections archive together and issue links open the normal view', () =>
    projectIssuesBrowserChecks({ page, project, root, output, service })
  );
  await check(serverHeapCheck, () =>
    withQueueConfiguration({ page, project, root }, () => serverHeapBrowserChecks({ page, output, poll, screenshot }))
  );
  await check(flowBrowserScenarioNames['--inbox-group-drag'], () =>
    masterDragBrowserChecks({ page, project, root, output, service, poll })
  );
  await check(masterIssuesCheck, () => masterIssueBrowserChecks({ page, project, root, output }));
  await check(manualSubIssueRemovalCheck, () => manualSubIssueRemovalBrowserChecks({ page, project, root, output }));
  await check(investigativeGroupingCheck, () =>
    investigativeGroupingBrowserChecks({ page, project, output, candidate, clickAction, poll })
  );
  await check(issueAnnotationsCheck, () => issueAnnotationBrowserChecks({ page, project, root, output, poll }));
  await check(navigationCheck, () =>
    withQueueConfiguration({ page, project, root }, () =>
      projectNavigationBrowserChecks({ page, poll, screenshot, output, candidate, project, service, root })
    )
  );
  await check(inboxFlowCheck, () => inboxFlowBrowserChecks({ page, service, project, poll, screenshot, output }));
  await check(reportsCheck, () =>
    investigationReportsBrowserChecks({ page, project, service, poll, screenshot, output })
  );
  await check('Investigation controls remain above the graph', () =>
    investigationToolbarBrowserChecks({ page, service, screenshot })
  );
  await check(investigationFlowsCheck, () =>
    withQueueConfiguration({ page, project, root }, () =>
      investigationFlowsBrowserChecks({ page, service, poll, screenshot })
    )
  );
  await check(discussCheck, () => projectDiscussBrowserChecks({ page, project, service, poll, screenshot }));
  await check(inboxDiscussCheck, () => inboxDiscussBrowserChecks({ page, service, screenshot, output }));
  part = '--ci-part=1b';
  await check('Factory provider settings save enablement and quota warnings', () =>
    providerSettingsBrowserChecks({ page, project, screenshot })
  );
  await check(settingsCheck, () =>
    withQueueConfiguration({ page, project, root }, () =>
      projectSettingsBrowserChecks({ page, project, service, logs, poll, screenshot, output, candidate })
    )
  );
  await check(assetStorageCheck, () => assetStorageBrowserChecks({ page, output, screenshot }));
  await check(storesCheck, () => issueStoresBrowserChecks({ page, project, service, logs, poll, screenshot }));
  await check(aiTextCheck, () => aiTextBrowserChecks({ page, project, service, poll, screenshot }));
  await check(interfaceStateCheck, () => interfaceStateBrowserChecks({ page, project, service, poll, screenshot }));
  await check('Issues and Local notes use matching text styles', () =>
    withQueueConfiguration({ page, project, root }, async () => {
      await page.goto('/');
      const issues = page.locator('.sidebar-issues-link');
      const notes = page.locator('#local-notes > header > h2');
      await issues.waitFor();
      await notes.waitFor();
      const textStyle = (node) => {
        const style = getComputedStyle(node);
        return Object.fromEntries(
          [
            'fontFamily',
            'fontSize',
            'fontWeight',
            'fontStyle',
            'lineHeight',
            'letterSpacing',
            'textTransform',
            'color',
          ].map((property) => [property, style[property]])
        );
      };
      const styles = { issues: await issues.evaluate(textStyle), notes: await notes.evaluate(textStyle) };
      await screenshot('sidebar-labels');
      writeFileSync(
        join(output, 'sidebar-labels-styles.json'),
        JSON.stringify({ candidate, styles, screenshot: join(output, 'sidebar-labels.png') }, null, 2) + '\n'
      );
      assert.deepEqual(styles.issues, styles.notes, 'Issues text styling matches Local notes');
      await issues.click();
      await page.locator('#project-issues').waitFor();
      const frame = page.frameLocator('#project-issues iframe');
      await frame.getByRole('button', { name: 'Open', exact: true }).waitFor();
      await assertCleanSidebarConsole();
    })
  );
  await check('Local notes capture and handoff preserve flow', async () => {
    await localNotesBrowserChecks({ page, project, service, poll, screenshot, output, candidate });
    await assertCleanSidebarConsole();
  });
  await check('Automate me dots follow each active response', () =>
    automateActivityBrowserChecks({ page, service, screenshot, poll, output })
  );
  await check('Activity dots stay anchored and reflect actual work', () =>
    activityBrowserChecks({ page, project, service, poll, screenshot, output })
  );
  await check('Issue and project chats retain semantic progress', () =>
    chatProgressBrowserChecks({ page, project, service, poll, screenshot, output })
  );
  await check('Issue flow scrollbar appears only while scrolling', async () => {
    const id = '20261122-issue-scrollbar-fixture';
    await writeBrowserIssue(project, {
      id,
      title: 'Scroll the issue flow',
      body: 'Show the scrollbar only during scrolling.',
    });
    try {
      await page.setViewportSize({ width: 1440, height: 640 });
      await page.goto('/?issue=' + id);
      await page.locator('[data-node="__destination"]').waitFor();
      const scroll = page.locator('#graph-scroll');
      const observe = () =>
        scroll.evaluate((node) => ({
          scrollbarColor: getComputedStyle(node).scrollbarColor,
          scrollTop: node.scrollTop,
          clientWidth: node.clientWidth,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
        }));
      const transparent = 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)';
      await page.waitForTimeout(900);
      const idle = await observe();
      writeFileSync(join(output, 'issue-scrollbar.json'), JSON.stringify({ candidate, idle }, null, 2) + '\n');
      assert.ok(idle.scrollHeight > idle.clientHeight, 'The issue flow must overflow vertically.');
      assert.equal(idle.scrollbarColor, transparent, 'The issue scrollbar must be hidden while idle.');
      await screenshot('issue-scrollbar-idle');
      await scroll.hover();
      await page.mouse.wheel(0, idle.scrollTop > 0 ? -180 : 180);
      const scrolling = await poll(
        observe,
        (value) => value.scrollTop !== idle.scrollTop && value.scrollbarColor !== transparent,
        'The issue scrollbar appears during wheel scrolling.'
      );
      await screenshot('issue-scrollbar-active');
      const stopped = await poll(
        observe,
        (value) => value.scrollbarColor === transparent,
        'The issue scrollbar hides after scrolling stops.'
      );
      assert.equal(scrolling.clientWidth, idle.clientWidth, 'Showing the scrollbar must not shift the flow.');
      assert.equal(stopped.clientWidth, idle.clientWidth, 'Hiding the scrollbar must not shift the flow.');
      assert.equal(stopped.scrollTop, scrolling.scrollTop, 'Hiding the scrollbar must preserve the scroll position.');
      await screenshot('issue-scrollbar-stopped');
      writeFileSync(
        join(output, 'issue-scrollbar.json'),
        JSON.stringify({ candidate, idle, scrolling, stopped }, null, 2) + '\n'
      );
    } finally {
      await page.goto('about:blank');
      await removeBrowserIssue(project, id);
      await page.setViewportSize({ width: 1440, height: 960 });
    }
  });
  await check(folderSettingsCheck, () =>
    flowFolderSettingsBrowserChecks({ page, project, service, logs, screenshot, poll })
  );
  if (process.argv.includes(flowBrowserOrderModifier)) await noChangesCheck();
  await check(followupsCheck, () => flowFollowupsBrowserChecks({ page, service, logs, screenshot }));
  await check(flowBrowserScenarioNames['--inbox-chat-reading'], () =>
    inboxChatBrowserChecks({ page, service, project, root, poll, screenshot, output })
  );
  await check(flowBrowserScenarioNames['--inbox-details'], () =>
    inboxDetailsBrowserChecks({ page, service, project, poll, screenshot, output })
  );
  await check(mergeSettingsCheck, async () => {
    const id = '20261119-merge-settings-fixture';
    await importBrowserIssue(
      project,
      id,
      `---\nid: ${id}\ntitle: Merge verification settings\nstate: backlog\n---\n\nUse GitHub checks before merging.\n`
    );
    const request = service.flows.read(service.flows.selected(id)).blocks.find(({ kind }) => kind === 'request');
    await page.goto('/?issue=' + id);
    await block(request.id);
    assert.equal(await page.getByRole('checkbox', { name: 'Run full regression suite' }).count(), 0);
    await page.getByRole('button', { name: 'Add a step' }).click();
    const palette = page.locator('#palette-dialog');
    await palette
      .getByRole('button', { name: /^Work\b/ })
      .first()
      .waitFor();
    assert.equal(await palette.locator('[data-add-kind="verify"]').count(), 0);
    await palette.getByRole('button', { name: 'Close block palette' }).click();
  });
  await check('Opening the workspace starts no work and loads no skills', async () => {
    await page.goto('/');
    await page.locator('#connection-status').filter({ hasText: 'Live' }).waitFor();
    assert.equal(logs.execution.length, 0);
    assert.equal(logs.modelCalls.length, 0);
    assert.equal(logs.requests.filter((item) => item.path === '/api/flow-skills').length, 0);
    assert.equal(await page.locator('#new-issue').count(), 1);
    await screenshot('empty-desktop');
  });
  await check('Creating an issue uses the default folder and permits an explicit destination', async () => {
    await page.locator('#new-issue').click();
    const folder = page.locator('#capture-folder');
    assert.equal(await folder.inputValue(), 'Inbox');
    assert.notEqual(await folder.getAttribute('required'), null);
    assert.equal(await folder.evaluate((select) => select.validity.valid), true);
    await folder.selectOption('Inbox');
    await page.getByRole('button', { name: 'Close new issue', exact: true }).click();
    assert.equal(await page.locator('#issue-list').getByText('Unfiled', { exact: true }).count(), 0);
  });
  await check('The sidebar browses system Markdown and saves project Markdown on disk', async () => {
    const tree = page.locator('#sidebar-file-tree');
    const sidebar = page.locator('.sidebar');
    for (const label of ['Files', 'System', 'Open'])
      assert.equal(await sidebar.getByText(label, { exact: true }).count(), 0);
    assert.equal(await sidebar.getByRole('button', { name: 'Add Folder…', exact: true }).count(), 0);
    assert.equal(await sidebar.getByRole('button', { name: 'New File', exact: true }).count(), 0);
    await tree.getByRole('button', { name: 'flow', exact: true }).first().click();
    await page.getByRole('heading', { name: 'flow', exact: true }).waitFor();
    assert.equal(await page.locator('#issue-folder-content').isVisible(), false);
    assert.equal(await page.locator('#graph-scroll').isVisible(), false);
    assert.equal(await page.locator('#folder-workspace').getByRole('button').count(), 2);
    page.once('dialog', (dialog) => void dialog.dismiss());
    await page.getByRole('button', { name: 'Delete folder', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('delete-sidebar-folder').disabled);
    assert.ok(existsSync(join(root, 'factory/system/flow')));
    await tree.getByRole('button', { name: 'Expand flow', exact: true }).first().click();
    await tree.getByRole('button', { name: 'defaults.md', exact: true }).click();
    await page.getByRole('dialog', { name: 'defaults.md' }).waitFor();
    assert.ok((await page.locator('#sidebar-file-text').getAttribute('readonly')) !== null);
    await page.locator('#sidebar-file-close').click();
    await tree.getByRole('button', { name: 'New folder in user', exact: true }).click();
    await page.locator('#sidebar-file-path').fill('Notes');
    await page.locator('#sidebar-file-submit').click();
    await page.locator('#sidebar-file-dialog').waitFor({ state: 'hidden' });
    writeFileSync(join(project, 'user/Notes/checklist.md'), '# Checklist');
    await tree.getByRole('button', { name: 'Expand Notes', exact: true }).click();
    await tree.getByRole('button', { name: 'checklist.md' }).click();
    await page.getByRole('dialog', { name: 'checklist.md', exact: true }).waitFor();
    assert.equal(await page.locator('#sidebar-file-text').inputValue(), '# Checklist');
    await page.locator('#sidebar-file-text').fill('# Updated checklist');
    await page.locator('#sidebar-file-submit').click();
    await page.locator('#sidebar-file-dialog').waitFor({ state: 'hidden' });
    assert.equal(readFileSync(join(project, 'user/Notes/checklist.md'), 'utf8'), '# Updated checklist');
    await tree.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.getByRole('heading', { name: 'Notes', exact: true }).waitFor();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Delete folder', exact: true }).click();
    await page.getByText('Moved folder to Trash.', { exact: true }).waitFor();
    assert.equal(existsSync(join(project, 'user/Notes')), false);
    const trashed = readdirSync(join(output, 'Trash'));
    assert.equal(readFileSync(join(output, 'Trash', trashed[0], 'checklist.md'), 'utf8'), '# Updated checklist');
    const external = mkdtempSync(join(tmpdir(), 'timey-sidebar-outside-'));
    writeFileSync(join(external, 'folder.md'), '# Outside folder');
    await sidebar.evaluate((element, url) => {
      const transfer = new DataTransfer();
      transfer.setData('text/uri-list', url);
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, pathToFileURL(external).href);
    await tree.getByRole('button', { name: 'folder.md', exact: true }).waitFor();
    await tree.getByRole('button', { name: 'folder.md', exact: true }).click();
    await page.getByRole('dialog', { name: 'folder.md', exact: true }).waitFor();
    assert.equal(await page.locator('#sidebar-file-text').inputValue(), '# Outside folder');
    assert.notEqual(await page.locator('#sidebar-file-text').getAttribute('readonly'), null);
    assert.equal(await page.getByRole('button', { name: 'Install project skill' }).isVisible(), false);
    await page.locator('#sidebar-file-close').click();
    rmSync(external, { recursive: true, force: true });
    await screenshot('sidebar-folders');
    await page.reload();
    await page.locator('#connection-status').filter({ hasText: 'Live' }).waitFor();
  });
  await check('Project settings explain missing configuration and initialize it only on request', async () => {
    const labels = join(project, '.issues/triage-labels.md');
    rmSync(labels, { force: true });
    await page.getByRole('button', { name: 'Factory settings', exact: true }).click();
    const settings = page.locator('#project-settings-dialog');
    await settings.locator('[data-settings-page="lifecycle"]').click();
    const initialize = settings.getByRole('button', { name: 'Initialize lifecycle configuration', exact: true });
    const openFile = settings.getByRole('button', { name: 'Open file', exact: true });
    await initialize.waitFor();
    assert.equal(await openFile.isDisabled(), true);
    await screenshot('project-settings-missing');
    assert.equal(logs.execution.length, 0);
    assert.equal(logs.modelCalls.length, 0);
    await page.keyboard.press('Escape');
    assert.throws(() => readFileSync(labels), /ENOENT/);
    await page.getByRole('button', { name: 'Factory settings', exact: true }).click();
    await settings.locator('[data-settings-page="lifecycle"]').click();
    await initialize.click();
    await poll(() => openFile.isEnabled(), Boolean, 'Initialized lifecycle file did not become available.');
    assert.equal(await initialize.count(), 0);
    const saved = readFileSync(labels, 'utf8');
    assert.match(saved, /ready-to-close/);
    assert.equal(logs.execution.length, 0);
    assert.equal(logs.modelCalls.length, 0);
    await page.keyboard.press('Escape');
    await page.reload();
    await page.getByRole('button', { name: 'Factory settings', exact: true }).click();
    await settings.locator('[data-settings-page="lifecycle"]').click();
    await poll(() => openFile.isEnabled(), Boolean, 'Saved lifecycle file did not remain available.');
    assert.equal(await initialize.count(), 0);
    assert.equal(readFileSync(labels, 'utf8'), saved);
    await screenshot('project-settings-configured');
    await page.keyboard.press('Escape');
  });
  await check('The Flow action count opens and closes the shared Action list', async () => {
    const count = page.getByRole('button', { name: '0 actions running' });
    await count.click();
    const dialog = page.getByRole('dialog', { name: 'Action list' });
    await dialog.getByText('No issue-linked actions are running.').waitFor();
    assert.equal(await count.getAttribute('aria-expanded'), 'true');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await count.and(page.locator('[aria-expanded="false"]')).waitFor();
  });
  await check(storageStatusCheck, async () => {
    const id = '20261123-storage-status-fixture';
    await writeBrowserIssue(project, { id, title: 'Confirm storage recovery', body: 'Keep the local draft.' });
    let storage = {
      phase: 'refreshing',
      available: false,
      unavailable: true,
      warning: 'Refreshing shared storage. The last saved snapshot is read-only until storage is confirmed.',
    };
    const projectStorage = async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      if (data.issue?.id === id) {
        data.storeStatus = storage;
        data.sharedQueueWarning = storage.warning || null;
      }
      await route.fulfill({ response, json: data });
    };
    await page.route('**/api/flow?**', projectStorage);
    try {
      await page.goto('/?issue=' + id);
      const warning = page.locator('#shared-queue-message');
      await warning.getByText(storage.warning, { exact: true }).waitFor();
      assert.equal(
        await page.locator('#error-banner').isVisible(),
        false,
        'Initial storage confirmation was presented as a storage failure.'
      );
      assert.equal(await page.locator('#run-block').isDisabled(), true);
      const wording = page.locator('#request-form [name="wording"]');
      await wording.fill('Draft retained through storage recovery.');
      storage = { phase: 'ready', available: true, unavailable: false };
      await page.locator('#refresh').click();
      await poll(
        () => warning.textContent(),
        (value) => value === '',
        'Recovery retained the startup warning.'
      );
      assert.equal(await page.locator('#run-block').isEnabled(), true);
      storage = {
        phase: 'unavailable',
        available: false,
        unavailable: true,
        warning: 'Shared storage is unavailable. Cached data is read-only; local drafts are retained.',
      };
      await page.locator('#refresh').click();
      await page.locator('#error-banner').waitFor({ state: 'visible' });
      assert.match(await page.locator('#error-message').textContent(), /Shared storage is unavailable/);
      assert.equal(await page.locator('#run-block').isDisabled(), true);
      assert.equal(await wording.inputValue(), 'Draft retained through storage recovery.');
      storage = { phase: 'ready', available: true, unavailable: false };
      await page.locator('#refresh').click();
      await poll(
        () => warning.textContent(),
        (value) => value === '',
        'Recovery retained the failure warning.'
      );
      await page.locator('#error-banner').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#run-block').isEnabled(), true);
      await screenshot('storage-status-recovered');
    } finally {
      await page.unroute('**/api/flow?**', projectStorage);
      await page.goto('about:blank');
    }
  });
  await check('Block models preserve history and surface persistent blockers', () =>
    blockModelsBrowserChecks({ page, project, service, poll, screenshot, block })
  );
  await check(blockInspectionCheck, async () => {
    const id = '20261123-block-inspection-fixture';
    await writeBrowserIssue(project, { id, title: 'Read saved state on demand', body: 'Keep navigation local.' });
    const inspections = [];
    const refreshes = [];
    const observeRequest = (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/flow-action' && request.postDataJSON()?.action === 'open-block')
        inspections.push(request.postDataJSON());
      if (url.pathname === '/api/flow' && url.searchParams.get('refresh') === 'true') refreshes.push(url.href);
    };
    page.on('request', observeRequest);
    try {
      await page.goto('/?issue=' + id);
      const wording = page.locator('#request-form [name="wording"]');
      await wording.fill('Unsaved wording survives on-demand refresh.');
      for (const blockId of ['work', 'publish', 'request']) await selectBlock(blockId);
      await page.waitForTimeout(2400);
      assert.equal(inspections.length, 0, 'Navigation started automatic block mutation checks.');
      assert.equal(refreshes.length, 0, 'Idle polling requested remote refresh.');
      const refreshed = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/flow' && url.searchParams.get('refresh') === 'true';
      });
      await page.locator('#refresh').click();
      await refreshed;
      await poll(
        () => wording.inputValue(),
        (value) => value === 'Unsaved wording survives on-demand refresh.',
        'Refresh discarded the unsaved wording.'
      );
      assert.equal(refreshes.length, 1);
      assert.equal(await page.locator('#run-block').isEnabled(), true);
      assert.match(await page.locator('#connection-status').textContent(), /Watching for changes/);
      const pulse = page.locator('#diagnostics-trigger');
      const panel = page.locator('#diagnostics-panel');
      await pulse.scrollIntoViewIfNeeded();
      const collapsed = await page.locator('#new-issue').boundingBox();
      assert.equal(await panel.isVisible(), false);
      const quotaResponse = async (route) => route.fulfill({ json: { status: 'unavailable' } });
      await page.route('**/api/codex-quota*', quotaResponse);
      let codexHistory = {
        codexTotal: 3,
        retained: 120,
        rows: [
          {
            category: 'codex',
            project: 'Popup fixture',
            status: 'completed',
            startedAt: Date.now(),
            durationMs: 10,
          },
        ],
      };
      const activityResponse = (route) => route.fulfill({ json: codexHistory });
      const resetResponse = (route) => {
        assert.equal(route.request().method(), 'POST');
        codexHistory = { codexTotal: 0, retained: 120, rows: [] };
        return route.fulfill({ json: codexHistory });
      };
      await page.route('**/api/diagnostic-activity', activityResponse);
      await page.route('**/api/codex-activity-reset', resetResponse);
      let expanded;
      try {
        await pulse.click();
        await panel.waitFor({ state: 'visible' });
        await poll(() => page.locator('#diagnostics-content').textContent(), Boolean, 'Diagnostics did not render.');
        assert.equal(await panel.evaluate((node) => node.matches(':popover-open')), true);
        expanded = await page.locator('#new-issue').boundingBox();
        const bounds = await panel.boundingBox();
        const triggerBounds = await pulse.boundingBox();
        assert.ok(bounds.y >= triggerBounds.y + triggerBounds.height, 'Codex popup covered its trigger.');
        assert.equal(expanded.y, collapsed.y, 'Codex popup moved sidebar content.');
        await screenshot('codex-requests-popup');
        await poll(
          () => page.locator('#codex-call-total').textContent(),
          (value) => value === '3',
          'Codex count missing.'
        );
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#diagnostics-reset').click();
        await poll(
          () => page.locator('#codex-call-total').textContent(),
          (value) => value === '0',
          'Codex reset kept its count.'
        );
        assert.match(await page.locator('#diagnostics-content').textContent(), /No Codex turns recorded yet/);
        assert.equal(await page.locator('#diagnostics-reset').isDisabled(), true);
        await pulse.click();
        assert.equal(await panel.isVisible(), false);
        assert.equal(await panel.evaluate((node) => node.matches(':popover-open')), false);
        const hidden = await page.locator('#new-issue').boundingBox();
        assert.equal(hidden.y, collapsed.y, 'Hiding Pulse left space in the column.');
      } finally {
        await page.unroute('**/api/codex-quota*', quotaResponse);
        await page.unroute('**/api/diagnostic-activity', activityResponse);
        await page.unroute('**/api/codex-activity-reset', resetResponse);
      }
      writeFileSync(join(output, 'pulse-sidebar.json'), JSON.stringify({ collapsed, expanded }, null, 2));
      await screenshot('github-refresh-on-demand');
      writeFileSync(join(output, 'github-refresh-on-demand.json'), JSON.stringify({ inspections, refreshes }, null, 2));
    } finally {
      page.off('request', observeRequest);
      await page.goto('about:blank');
    }
  });
  await check(requestSaveCheck, async () => {
    const id = '20261123-request-save-fixture';
    await writeBrowserIssue(project, {
      id,
      title: 'Save an existing request',
      body: 'Original request',
    });
    requestClarification = Promise.withResolvers();
    try {
      await page.goto('/?issue=' + id);
      const wording = page.locator('#request-form [name="wording"]');
      await wording.fill('Edited request\ntype: bug\ngoal: Keep controls usable');
      const rejectSave = async (route) => {
        if (route.request().postDataJSON().action !== 'request') return route.continue();
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Request admission rejected.' }),
        });
      };
      await page.route('**/api/flow-action', rejectSave);
      await page.locator('#request-form button[type="submit"]').click();
      await page.locator('#error-message').filter({ hasText: 'Request admission rejected.' }).waitFor();
      assert.equal(await wording.inputValue(), 'Edited request\ntype: bug\ngoal: Keep controls usable');
      assert.equal(await wording.isEnabled(), true);
      await page.unroute('**/api/flow-action', rejectSave);
      const saved = await clickAction(page.locator('#request-form button[type="submit"]'));
      assert.equal(saved.accepted, true);
      await page.locator('#run-block[data-action="stop"]').waitFor();
      await poll(() => page.locator('#rename-issue').isEnabled(), Boolean, 'Rename stayed disabled during Request.');
      assert.equal(await page.locator('#close-with-reason').isEnabled(), true);
      assert.equal(await page.locator('#run-block').isEnabled(), true);
      assert.equal(await wording.isEnabled(), true);
      await screenshot('request-save-running');
      requestClarification.resolve();
      await poll(
        async () => {
          const data = await (await page.request.get('/api/flow?issue=' + id)).json();
          return data.flow.blocks.find((item) => item.kind === 'request').attempts.at(-1)?.status;
        },
        (value) => value === 'completed',
        'Request did not finish.'
      );
      await page.reload();
      await poll(() => page.locator('#rename-issue').isEnabled(), Boolean, 'Rename stayed disabled after Request.');
      assert.equal(await wording.inputValue(), 'Edited request\ntype: bug\ngoal: Keep controls usable');
      await screenshot('request-save-completed');
    } finally {
      requestClarification.resolve();
      requestClarification = null;
      await service.flows.active.get(id)?.task;
      await page.goto('about:blank');
    }
  });
  // The remaining scenarios share the issue created in this section.
  part = '--ci-part=2';
  const description =
    'Understand why the save button loses text\nDone: The text survives a reload.\nProof: Retained saved text.\nKnown facts: The problem occurs after refresh.\nConstraints: Reproduce before changing code.';
  await check(captureFolderIssueCheck, async () => {
    await page.goto('/');
    await page.locator('#new-folder').click();
    await page.locator('#folder-name').fill('Browser folder');
    await page.locator('#folder-form button[type="submit"]').click();
    await page.locator('#issue-list [data-create-folder-issue="Browser folder"]').waitFor();
    await page.locator('#issue-list [data-create-folder-issue="Browser folder"]').click();
    assert.equal(await page.locator('#capture-folder').inputValue(), 'Browser folder');
    await page.locator('#capture-description').fill(description);
    await page.locator('#capture-type').selectOption('feature');
    const data = await clickAction(page.locator('#capture-submit'));
    issueId = data.issue.id;
    worktreeIssueId = issueId;
    assert.equal(data.flow.folder, 'Browser folder');
    const createdIssue = page.locator('#open-issues [data-issue="' + issueId + '"]');
    await createdIssue.waitFor();
    assert.equal(await createdIssue.getAttribute('aria-current'), 'page');
    await screenshot('folder-plus-created-issue');
    await page.locator('.inspector').waitFor({ state: 'visible' });
    await page.locator('#request-form').waitFor({ state: 'visible' });
    const markdownMenu = page.locator('.block-markdown-menu');
    await markdownMenu.getByText('Markdown', { exact: true }).click();
    assert.ok(await markdownMenu.getByRole('button', { name: 'Reveal Markdown in Finder' }).isVisible());
    assert.ok(await markdownMenu.getByRole('button', { name: 'Create extension' }).isVisible());
    await markdownMenu.getByText('Markdown', { exact: true }).click();
    assert.equal(await page.locator('[name="wording"]').inputValue(), description);
    assert.equal(data.flow.routeType, 'feature');
    assert.equal(startingPoint(data.flow).ref, 'refs/heads/dev');
    assert.equal(deliveryTarget(data.flow).branch, 'dev');
    assert.equal(requestData(data.flow).fields, null);
    assert.equal(logs.execution.length, 0);
  });
  async function ensureBrowserFolderIssue() {
    if (!issueId) {
      await service.flows.action({ action: 'create-folder', name: 'Browser folder' });
      const captured = await service.flows.action({
        action: 'capture',
        requestId: randomUUID(),
        description,
        folder: 'Browser folder',
      });
      issueId = captured.issue.id;
      worktreeIssueId = issueId;
      await page.goto('/?issue=' + issueId);
      await page.locator('#request-form').waitFor();
    }
  }
  await check('Issue folders retain every issue and accept drags between folders', async () => {
    await ensureBrowserFolderIssue();
    await flowIssueFoldersBrowserChecks(page, issueId, 'Browser folder');
    await screenshot('issue-folder-drag');
    await page.goto('/?issue=' + issueId);
    await page.locator('#request-form').waitFor();
  });
  await check(folderWorkspaceGroupingCheck, async () => {
    await ensureBrowserFolderIssue();
    const openFolder = async () => {
      await page.locator('#issue-list button[data-folder="Browser folder"]').click();
      await page.getByRole('heading', { name: 'Browser folder', exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('folder'), 'Browser folder');
      assert.equal(await page.locator('#graph-scroll').isVisible(), false);
    };
    const scanSource = async () => {
      await openFolder();
      await page.getByLabel('Search', { exact: true }).selectOption('Scan source');
      return clickAction(page.getByRole('button', { name: 'Find issues', exact: true }));
    };
    const sidebarIssue = (id) => page.locator(`#open-issues [data-issue="${id}"]`);
    const disclosure = page.locator('#issue-list [data-toggle-folder="Browser folder"]');
    await disclosure.click();
    assert.equal(await sidebarIssue(issueId).isVisible(), false);
    assert.equal(new URL(page.url()).searchParams.get('issue'), issueId);
    await disclosure.click();
    await openFolder();

    await page.locator('#new-folder').click();
    await page.locator('#folder-name').fill('Scan source');
    await clickAction(page.locator('#folder-form button[type="submit"]'));
    await page.locator('#issue-list [data-create-folder-issue="Scan source"]').click();
    await page.locator('#capture-description').fill('Keep the save button visible after reload.');
    const second = await clickAction(page.locator('#capture-submit'));
    await clickAction(page.getByLabel('Prevent moves into folders'));

    await scanSource();
    await page.getByText('No matching issues to move.', { exact: true }).waitFor();
    await sidebarIssue(second.issue.id).click();
    await clickAction(page.getByLabel('Prevent moves into folders'));

    await scanSource();
    await page.getByRole('heading', { name: 'Review suggested moves', exact: true }).waitFor();
    await clickAction(page.getByRole('button', { name: 'Move selected issues', exact: true }));
    const members = page.getByRole('list', { name: 'Issues in this folder', exact: true });
    await members.getByRole('link', { name: /Keep the save button visible/ }).waitFor();
    await clickAction(page.getByRole('button', { name: 'Recommend issues', exact: true }));
    await page.getByText('2 selected', { exact: true }).waitFor();
    assert.equal(await members.getByRole('checkbox', { checked: true }).count(), 2);

    await clickAction(page.getByRole('button', { name: 'Work All Night', exact: true }));
    await page
      .getByRole('region', { name: 'Overnight plan' })
      .getByText('Verified, merge-ready pull requests')
      .waitFor();
    await page.locator('[data-folder-command="cancel-night"]').click();
    const groupButton = page.locator('[data-folder-command="group"]');
    assert.equal(await groupButton.innerText(), 'Create master issue');
    assert.equal(await page.locator('[data-folder-command="bulk"] + [data-folder-command="group"]').count(), 1);
    await clickAction(groupButton);
    const combined = page.getByLabel('Review and edit the master issue request');
    const wording = await combined.inputValue();
    assert.match(wording, /Keep the save button visible/);
    const edited = wording.replace(/^[^\n]*/, 'Keep both save behaviors after reload');
    await combined.fill(edited);
    const master = await clickAction(page.locator('#folder-group-form button[type="submit"]'));
    assert.equal(requestData(master.flow).wording, edited);
    await openFolder();
    const nested = members.getByRole('list', { name: 'Sub-issues', exact: true });
    assert.equal(await nested.getByRole('checkbox').count(), 2);
    const masterLink = members.locator(':scope > li > div > a').filter({ hasText: 'Keep both save behaviors' });
    const childLink = nested.getByRole('link').first();
    assert.ok((await childLink.boundingBox()).x > (await masterLink.boundingBox()).x);
    await page.locator('#folder-search-query').fill('Keep the save button visible');
    await page.locator('#folder-search-form button[type="submit"]').click();
    assert.equal(await members.getByRole('checkbox').count(), 1);
    assert.equal(await members.getByRole('list').count(), 0);
    await page.locator('#folder-search-query').fill('');
    await page.locator('#folder-search-form button[type="submit"]').click();
    await screenshot('folder-master-hierarchy');
    await masterLink.click();
    const subIssues = page.locator('#issue-heading').getByRole('list', { name: 'Sub-issues', exact: true });
    await subIssues.waitFor();
    assert.equal(await subIssues.getByRole('link').count(), 2);
    assert.equal(await subIssues.getByRole('button', { name: /^Remove / }).count(), 2);
    assert.ok((await subIssues.boundingBox()).y > (await page.locator('#issue-title').boundingBox()).y);
    assert.ok((await subIssues.boundingBox()).y < (await page.locator('#issue-settings').boundingBox()).y);
    const grouping = page.getByRole('region', { name: 'Grouped issues' });
    await grouping.getByRole('heading', { name: 'Sub-issue proof' }).waitFor();
    assert.equal(await grouping.getByText('The fixture requests share save behavior.').count(), 2);
    await subIssues.getByRole('link', { name: /Understand why/ }).click();
    const masterRow = page.getByRole('group', { name: 'Master issue', exact: true });
    await masterRow.getByRole('link', { name: /Keep both save behaviors/ }).waitFor();
    assert.ok((await masterRow.boundingBox()).y < (await page.locator('#issue-settings').boundingBox()).y);
    assert.equal(await page.locator('#issue-playback').isVisible(), false);
    await masterRow.getByRole('link', { name: /Keep both save behaviors/ }).click();
    assert.equal(await masterRow.isVisible(), false);
    await subIssues.getByRole('link', { name: /Keep the save button visible/ }).click();
    await masterRow.waitFor({ state: 'visible' });
    await screenshot('issue-master-row');
    await clickAction(masterRow.getByRole('button', { name: 'Remove', exact: true }));
    assert.equal(new URL(page.url()).searchParams.get('issue'), second.issue.id);
    assert.equal(await masterRow.isVisible(), false);
    await page.reload();
    await page.locator('#issue-settings').waitFor();
    assert.equal(await masterRow.isVisible(), false);
    await page.goto('/?issue=' + master.issue.id);
    await subIssues.waitFor();
    assert.equal(await subIssues.getByRole('link').count(), 1);
    await clickAction(subIssues.getByRole('button', { name: /Remove.*Understand why/ }));
    assert.equal(new URL(page.url()).searchParams.get('issue'), master.issue.id);
    await subIssues.waitFor({ state: 'hidden' });
    await page.goto('/?issue=' + issueId);
    await page.locator('#issue-settings').waitFor();
    assert.equal(await masterRow.isVisible(), false);

    await openFolder();
    await members.getByRole('checkbox', { name: /Select.*Keep the save button visible/ }).check();
    assert.equal(await page.getByRole('button', { name: 'Remove from folder', exact: true }).count(), 0);
    await members.getByRole('link', { name: /Keep the save button visible/ }).waitFor();
  });
  await check(tabSourceCheck, async () => {
    const holdSourceEvents = await page.addInitScript(() => {
      const dispatch = window.dispatchEvent;
      window.dispatchEvent = function (event) {
        if (event.type === 'factory-sources-changed') return true;
        return dispatch.call(this, event);
      };
      window.addEventListener('release-source-events', () => (window.dispatchEvent = dispatch), { once: true });
    });
    await page.goto('/?issue=' + issueId);
    await page.locator('#request-form').waitFor({ state: 'visible' });
    const path = join(project, 'user/flow/overrides/block-inspector.md');
    const tab = page.locator('#tab-details');
    const draft = page.locator('#request-form [name="wording"]');
    const flowPosts = () =>
      logs.requests.filter(({ path, method }) => path === '/api/flow-action' && method === 'POST').length;
    const before = flowPosts();
    await draft.fill('Unsaved UI editing fixture');
    await page.getByRole('button', { name: 'View index' }).click();
    await page.getByRole('button', { name: 'Block inspector · Details' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Inspect UI' }).click();
    await page.locator('#refresh').click();
    await page.locator('#toast').filter({ hasText: 'Current view refreshed.' }).waitFor();
    await tab.hover();
    await page.getByRole('tooltip').filter({ hasText: 'Inherited' }).waitFor();
    await tab.click({ button: 'right' });
    await page.locator('#view-source-edit').click();
    await page.getByLabel('Label', { exact: true }).fill('Block notes');
    await page.getByRole('button', { name: 'Save and reload' }).click();
    await page.getByRole('tab', { name: 'Block notes' }).waitFor();
    assert.match(readFileSync(path, 'utf8'), /## details-tab\n\nBlock notes/);
    assert.equal(await draft.inputValue(), 'Unsaved UI editing fixture');
    await tab.focus();
    await page.keyboard.press('Shift+F10');
    await page.getByRole('button', { name: 'Edit override' }).click();
    await page.getByLabel('Label', { exact: true }).fill('Stale draft');
    writeFileSync(path, '## details-tab\n\nExternal change\n');
    await page.getByRole('button', { name: 'Save and reload' }).click();
    await page.locator('#view-source-error').filter({ hasText: 'changed on disk' }).waitFor();
    const conflictLog = logs.console.findIndex(
      (entry) =>
        entry.type === 'error' &&
        entry.location.url.endsWith('/api/ui-sources') &&
        entry.text.includes('400 (Bad Request)')
    );
    assert.ok(conflictLog >= 0, 'The stale editor should receive a rejected request.');
    logs.console.splice(conflictLog, 1);
    assert.equal(await page.getByLabel('Label', { exact: true }).inputValue(), 'Stale draft');
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'External change' }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('release-source-events')));
    await holdSourceEvents.dispose();
    writeFileSync(path, '## missing-tab\n\nInvalid override\n');
    await page.locator('#view-source-status').filter({ hasText: 'unknown section' }).waitFor();
    assert.equal(await tab.innerText(), 'External change');
    rmSync(path);
    await page.getByRole('tab', { name: 'Details' }).waitFor();
    assert.equal(await draft.inputValue(), 'Unsaved UI editing fixture');
    assert.equal(flowPosts(), before);
    assert.equal(logs.execution.length, 0);
    await page.getByRole('button', { name: 'Inspect UI' }).click();
    await draft.fill(description);
  });
  await check('New issues open with Starting point flush with the viewport top', async () => {
    await poll(graphGeometry, (value) => Math.abs(value.start) < 2, 'Starting point was not aligned with the top.');
    assert.equal((await selectedGeometry()).blockId, 'request');
    assert.equal(await page.locator('.graph-note').count(), 0);
    assert.equal(logs.execution.length, 0);
  });
  await check(startingPointCheck, async () => {
    const selector = page.locator('#starting-branch');
    await selector.waitFor();
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
    const update = page.waitForResponse((response) => response.url().includes('/api/flow?issue='));
    service.flowChanges.notify();
    await update;
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
      (value) => startingPoint(value.flow)?.ref === 'refs/heads/recent',
      'The chosen branch was not saved.'
    );
    await page.reload();
    await selector.waitFor();
    assert.equal(await selector.inputValue(), 'refs/heads/recent');
    const selected = await view();
    assert.equal(startingPoint(selected.flow).commit, recentBranchCommit);
    assert.deepEqual(deliveryTarget(selected.flow), { ...deliveryTarget(data.flow), branch: 'recent' });
    assert.equal(logs.execution.length, 0);
    await screenshot('starting-branch-selected');
  });
  await check('Issue title and Destination edits update the saved flow through its controls', async () => {
    const original = (await view()).issue.title;
    const rename = async (title) => {
      await page.getByRole('button', { name: 'Rename issue' }).click();
      await page.getByRole('textbox', { name: 'Issue title' }).fill(title);
      await page.locator('#rename-issue-form').getByRole('button', { name: 'Save', exact: true }).click();
      await poll(view, (value) => value.issue.title === title, 'The issue title was not saved.');
    };
    await rename('Edited from the issue heading');
    await poll(
      () => page.locator('#issue-title').textContent(),
      (title) => title === 'Edited from the issue heading',
      'The heading did not show the saved issue title.'
    );
    await rename(original);
    const destination = page.getByRole('button', { name: 'Choose destination branch' });
    const select = page.locator('#destination-branch');
    await destination.click();
    await select.waitFor();
    assert.equal(await select.locator('option').first().textContent(), 'Follow starting branch');
    await select.selectOption('older');
    await page.getByRole('button', { name: 'Save destination' }).click();
    await poll(view, (value) => value.destination.branch === 'older', 'The destination was not pinned.');
    assert.equal((await view()).flow.startingPoint.ref, 'refs/heads/recent');
    await destination.click();
    await select.selectOption('');
    await page.getByRole('button', { name: 'Save destination' }).click();
    await poll(
      view,
      (value) => value.destination.follows && value.destination.branch === 'recent',
      'Destination did not resume following Starting point.'
    );
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
  await check(closedDestinationCheck, async () => {
    const closed = await service.flows.capture({
      folder: 'Inbox',
      requestId: randomUUID(),
      description: 'Retained closed layout fixture',
      storageProfile: 'default',
      type: 'feature',
    });
    closedId = closed.issue.id;
    assert.equal(
      startingPoint(closed.flow).ref,
      'refs/heads/dev',
      'The next issue did not start on its destination branch.'
    );
    await updateStoredIssueMetadata(project, service.flows.selected(closedId), { state: 'closed' });
    await moveStoredIssue(project, closedId, 'open', 'closed');
    for (const short of [false, true]) {
      if (short)
        await service.flows.store.save(
          { ...closed.flow, blocks: closed.flow.blocks.slice(0, 2) },
          closed.flow.revision
        );
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
  await check(sidebarIssueNamesCheck, async () => {
    await ensureBrowserFolderIssue();
    await page.goto('/?issue=' + issueId);
    await page.locator('#request-form').waitFor();
    const data = await view();
    const name = page.locator('#open-issues [data-issue="' + issueId + '"] .issue-name');
    assert.equal(
      await name.locator('.issue-title-text').textContent(),
      '#' + data.issue.issueNumber + ' - ' + data.issue.title
    );
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
    requestedProof: 'Reload twice and capture a screen showing the saved text.',
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
  const { wording: original, ...clarified } = edited;
  const savedWording =
    original +
    '\n\n### User details\n\nKeep this exact text.\n' +
    Object.entries({ ...clarified, type: 'bug' })
      .map(([key, value]) => key + ': ' + value)
      .join('\n');
  await check(saveRequestRouteCheck, async () => {
    await page.locator('#request-form [name="wording"]').fill(savedWording);
    await clickAction(page.locator('#request-form button[type="submit"]'));
    await poll(
      view,
      (value) => value.flow.routeType === 'bug' && requestData(value.flow).fields?.type === 'bug',
      'Request clarification did not save its fields and route.'
    );
    await page.reload();
    await page.locator('#request-form').waitFor();
    assert.equal(await page.locator('#request-form [name="wording"]').inputValue(), savedWording);
    const data = await view();
    assert.equal(data.flow.routeType, 'bug');
    assert.deepEqual(requestData(data.flow).fields, { ...clarified, type: 'bug' });
    assert.equal(await page.locator('#request-form [name="type"]').count(), 0);
    assert.equal(await page.locator('#issue-flow-name').textContent(), 'Standard delivery');
    workId = data.flow.blocks.find((item) => item.kind === 'work').id;
  });
  await check(flowMenuCheck, async () => {
    const menu = page.locator('#issue-flow-menu');
    const flows = page.getByRole('group', { name: 'Flows for this issue type' });
    const expected = (await view()).flow.blocks.find((block) => block.kind === 'request').attempts;
    await menu.click();
    assert.equal(await flows.getByRole('button', { name: 'Investigation', exact: true }).count(), 0);
    if (process.platform === 'darwin')
      assert.ok(await page.getByRole('button', { name: 'Reveal in Finder' }).isVisible());
    await page.getByRole('button', { name: 'Save as user flow', exact: true }).click();
    assert.equal(await page.getByLabel('File name').inputValue(), 'delivery-2');
    assert.equal(await page.locator('#export-flow-path').textContent(), 'user/flow/definitions/delivery-2.md');
    await page.getByLabel('Flow name').fill('Team delivery');
    await page.getByLabel('File name').fill('team-delivery');
    assert.equal(await page.locator('#export-flow-path').textContent(), 'user/flow/definitions/team-delivery.md');
    const result = await clickAction(page.getByRole('button', { name: 'Save and link' }));
    assert.equal(result.flow.definition.id, 'team-delivery');
    assert.equal(result.flow.blocks.find((item) => item.kind === 'work').id, workId);
    await page.locator('#export-flow-dialog').waitFor({ state: 'hidden' });
    await menu.click();
    const switched = await clickAction(flows.getByRole('button', { name: 'Standard delivery', exact: true }));
    assert.equal(switched.flow.definition.id, 'delivery');
    await menu.click();
    const linked = await clickAction(flows.getByRole('button', { name: 'Team delivery', exact: true }));
    assert.equal(linked.flow.definition.id, 'team-delivery');
    const path = join(project, 'user/flow/definitions/team-delivery.md');
    const source = readFileSync(path, 'utf8');
    writeFileSync(path, source.replace('name: Team delivery', 'name: Updated team delivery'));
    const changed = await view();
    assert.equal(changed.flowDefinitions.updated, true);
    const wand = page.getByRole('button', { name: 'Rebuild flow', exact: true });
    const updated = await clickAction(wand);
    assert.equal(updated.flowDefinitions.updated, false);
    assert.equal(updated.flow.definition.id, 'team-delivery');
    assert.equal(updated.flow.definition.name, 'Updated team delivery');
    assert.ok(updated.flow.revision > linked.flow.revision);
    const rebuilt = await clickAction(wand);
    assert.equal(rebuilt.flow.revision, updated.flow.revision);
    for (const data of [result, switched, linked, updated, rebuilt]) {
      assert.deepEqual(data.flow.blocks.find((block) => block.kind === 'request').attempts, expected);
    }
  });
  await check(pollingCheck, async () => {
    const id = '20261124-flow-polling-fixture';
    const body = 'Keep expanded sections open.\ntype: feature\ngoal: Keep the request details visible.';
    await writeBrowserIssue(project, { id, title: 'Read the request while the flow changes', body });
    const flow = service.flows.read(service.flows.selected(id));
    const prepared = await service.flows.action({
      action: 'request',
      issueId: id,
      revision: flow.revision,
      wording: body,
    });
    const reader = await context.newPage();
    reader.setDefaultTimeout(15000);
    try {
      await reader.goto('/?issue=' + id);
      const sections = [
        reader.locator('#inspector-body details').filter({ has: reader.getByText('System prompt', { exact: true }) }),
        reader.locator('#inspector-body details').filter({ has: reader.getByText('Details used', { exact: true }) }),
        reader.locator('#closed-issues'),
      ];
      for (const section of sections) {
        if ((await section.getAttribute('open')) === null) await section.locator('summary').click();
      }
      const retro = reader.locator('#retro-setting');
      assert.equal(await retro.isChecked(), false);
      const changed = await reader.request.post('/api/flow-action', {
        headers: { origin: baseURL, 'x-factory-action': 'manual' },
        data: { action: 'retro-setting', issueId: id, revision: prepared.flow.revision, enabled: true },
      });
      assert.equal(changed.status(), 200, await changed.text());
      await reader.locator('#retro-setting:checked').waitFor();
      for (const section of sections) assert.notEqual(await section.getAttribute('open'), null);
    } finally {
      await reader.close();
      await removeBrowserIssue(project, id);
    }
  });
  await check(assignFolderCheck, async () => {
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
  await check(addParallelBlockCheck, async () => {
    await page.getByRole('button', { name: 'Add a step', exact: true }).click();
    const data = await clickAction(page.locator('[data-add-kind="understand"]'));
    addedId = data.flow.blocks.find((item) => item.kind === 'understand' && item.id !== workId).id;
    await page.locator('#palette-dialog').waitFor({ state: 'hidden' });
    await block(addedId);
    await page.locator('#block-form [name="label"]').fill('Read the save behavior');
    await page.locator('#block-form .system-prompt summary').click();
    await page.locator('#block-form [name="prompt-mode"]').selectOption('skill');
    await page.locator('#block-form [name="skill"]').selectOption('how');
    await page.locator('#block-form [name="lane"]').selectOption('1');
    await clickAction(page.locator('#block-form button[type="submit"]'));
    assert.equal((await view()).flow.blocks.find((item) => item.id === addedId).skill, 'how');
    await page.locator('#block-form [name="prompt-mode"]').selectOption('text');
    await page.locator('#block-form [name="prompt"]').fill('Trace how saving works and retain exact evidence.');
    await clickAction(page.locator('#block-form button[type="submit"]'));
    const saved = (await view()).flow.blocks.find((item) => item.id === addedId);
    assert.equal(saved.label, 'Read the save behavior');
    assert.equal(saved.skill, null);
    assert.equal(saved.prompt, 'Trace how saving works and retain exact evidence.');
    assert.equal(saved.lane, 1);
    assert.equal(saved.attempts.length, 0);
    assert.equal(logs.modelCalls.length, 0);
  });
  await check(reorderSavedBlocksCheck, async () => {
    const { blocks } = (await view()).flow;
    const before = blocks.map((item) => item.id);
    const originalIndex = before.indexOf(addedId);
    const requestBlock = blocks.find((item) => item.kind === 'request');
    assert.equal(await page.locator(`[data-node="${requestBlock.id}"] .block-icon`).textContent(), '💬');
    const card = page.locator(`#graph [data-block="${addedId}"]`);
    const moved = await observeAction(() => card.press('Alt+ArrowDown'));
    const after = moved.flow.blocks.map((item) => item.id);
    assert.equal(after.indexOf(addedId), originalIndex + 1);
    assert.deepEqual(new Set(after), new Set(before));
    assert.equal(moved.flow.blocks[originalIndex + 1].lane, blocks[originalIndex + 1].lane);

    // Restore the lane fixture for the shared reload check.
    await service.flows.action({
      action: 'update',
      issueId,
      blockId: addedId,
      revision: moved.flow.revision,
      changes: { lane: blocks[originalIndex].lane },
    });
    await page.reload();
    await card.waitFor();
    await screenshot('flow-desktop');
  });
  await check('The graph and every dependency run from top to bottom', async () => {
    const data = await view();
    const positions = await page.locator('[data-node]').evaluateAll((nodes) => {
      const scroll = document.getElementById('graph-scroll');
      const viewport = scroll.getBoundingClientRect();
      return Object.fromEntries(
        nodes.map((node) => [node.dataset.node, node.getBoundingClientRect().top - viewport.top + scroll.scrollTop])
      );
    });
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
  await check(blockRevealCheck, async () => {
    await page.setViewportSize({ width: 1440, height: 600 });
    const target = page.locator('[data-block="' + workId + '"]');
    const visible = await target.evaluate((node) => {
      const scroll = document.getElementById('graph-scroll');
      const card = node.getBoundingClientRect();
      const viewport = scroll.getBoundingClientRect();
      scroll.scrollTop += card.top - viewport.top - (viewport.height - card.height) / 2;
      return { scrollTop: scroll.scrollTop, box: node.getBoundingClientRect().toJSON() };
    });
    const before = visible.scrollTop;
    await page.mouse.click(visible.box.x + visible.box.width / 2, visible.box.y + visible.box.height / 2);
    await poll(selectedGeometry, (value) => value.blockId === workId, 'The visible block was not selected.');
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
    const bounds = await target.evaluate((node) => node.getBoundingClientRect().toJSON());
    const viewport = await page.locator('#graph-scroll').boundingBox();
    const historyLength = await page.evaluate(() => history.length);
    assert.ok(bounds.y < viewport.y - 20, 'The test card must be clipped before selection.');
    await page.mouse.click(bounds.x + bounds.width / 2, viewport.y + 20);
    const after = await poll(
      selectedGeometry,
      (value) =>
        value.blockId === workId &&
        value.scrollTop < clipped.scrollTop - 20 &&
        value.top >= -1 &&
        value.bottom <= value.viewportHeight + 1,
      'The clipped card was not fully revealed.'
    );
    assert.ok(after.top >= -1);
    assert.ok(after.bottom <= after.viewportHeight + 1);
    assert.ok(clipped.scrollTop - after.scrollTop <= 55, 'The card moved further than necessary.');
    assert.equal(await page.evaluate(() => history.length), historyLength);
    await page.setViewportSize({ width: 1440, height: 960 });
  });
  await check(saveBlockCommentCheck, async () => {
    await page.reload();
    await block(addedId);
    const comment = page.locator('#comment-form [name="comment"]');
    await comment.fill('Keep every partial attempt for review.');
    assert.equal(await comment.inputValue(), 'Keep every partial attempt for review.');
    await clickAction(page.locator('#comment-form button[type="submit"]'));
    await page.reload();
    await page.locator('[data-block="' + addedId + '"]').waitFor();
    await block(addedId);
    await page.locator('.message-body').filter({ hasText: 'Keep every partial attempt for review.' }).waitFor();
    assert.equal((await view()).flow.blocks.find((item) => item.id === addedId).comments.length, 1);
    assert.equal(logs.execution.length, 0);
  });
  const workOverride = join(project, 'user/flow/overrides/blocks/work.md');
  async function addExtraWork() {
    await page.getByRole('button', { name: 'Add a step', exact: true }).click();
    const data = await clickAction(page.locator('[data-add-kind="work"]'));
    return data.flow.blocks.find((item) => item.kind === 'work' && item.id !== workId).id;
  }
  let extraWorkId;
  await check(workMarkdownCheck, async () => {
    const id = await addExtraWork();
    extraWorkId = id;
    await block(id);
    const prose = page.locator('#inspector-body .block-content');
    assert.equal(await prose.count(), 0);
    await page.locator('.block-markdown-menu summary').waitFor();
    await page.locator('#block-form .system-prompt summary').click();
    const promptMode = page.locator('#block-form [name="prompt-mode"]');
    const originalPromptMode = await promptMode.inputValue();
    await promptMode.selectOption('skill');
    const skillOptions = page.locator('#block-form [name="skill"] option');
    assert.ok((await skillOptions.allTextContents()).includes('poteto-mode'));
    const card = page.locator('[data-block="' + id + '"]');
    await page.locator('#view-inspect').click();
    await card.hover();
    await page
      .getByRole('tooltip')
      .filter({ hasText: 'Optional user extension user/flow/extensions/blocks/work.md' })
      .waitFor();
    await page.locator('#view-inspect').click();
    const layout = () => card.locator(':scope > span').evaluateAll((items) => items.map((item) => item.className));
    const originalLayout = await layout();
    const draft = page.locator('#block-form [name="label"]');
    const original = await draft.inputValue();
    const title = await card.locator('.block-label').innerText();
    const status = await card.locator('.block-status').innerText();
    await draft.fill('Unsaved Work draft');
    mkdirSync(dirname(workOverride), { recursive: true });
    const extension = join(project, 'user/flow/extensions/blocks/work.md');
    mkdirSync(dirname(extension), { recursive: true });
    writeFileSync(extension, '## Local evidence\n\nKeep the command output.\n');
    writeFileSync(
      workOverride,
      '# Project Work\n\nReady when you are.\n\n## Evidence to retain\n\n- Command output\n- Saved artifact\n\n# Skill list\n\n- arena\n- how\n'
    );
    assert.equal(await prose.count(), 0);
    await poll(
      () => skillOptions.allTextContents(),
      (labels) => labels.includes('how') && !labels.includes('poteto-mode'),
      'Skill suggestions did not reload.'
    );
    const description = card.locator('.block-description');
    await description.filter({ hasText: /^Ready when you are\.$/ }).waitFor();
    assert.equal(await description.innerText(), 'Ready when you are.');
    assert.deepEqual(await layout(), originalLayout);
    assert.equal(await card.locator('.block-label').innerText(), title);
    assert.equal(await card.locator('.block-status').innerText(), status);
    assert.equal(await draft.inputValue(), 'Unsaved Work draft');
    assert.equal(await page.locator('[data-action="start"]').count(), 1);
    assert.equal(logs.execution.length, 0);
    writeFileSync(workOverride, '# Empty override\n');
    await page.locator('#view-source-status').filter({ hasText: 'needs a paragraph' }).waitFor();
    assert.equal(await prose.count(), 0);
    rmSync(workOverride);
    rmSync(extension);
    assert.equal(await prose.count(), 0);
    await page.locator('.block-markdown-menu summary').waitFor();
    await draft.fill(original);
    await promptMode.selectOption(originalPromptMode);
    await clickAction(page.locator('#block-form button[type="submit"]'));
    await page.locator('#draft-note').filter({ hasText: 'Saved locally' }).waitFor();
  });
  await check(stopWorkCheck, async () => {
    await block(workId);
    await page.locator('#block-form [name="label"]').fill('Work with saved settings');
    await page.locator('#run-block').click();
    assert.equal(logs.execution.length, 0);
    await page.locator('#error-banner').waitFor();
    await clickAction(page.locator('#block-form button[type="submit"]'));
    await clickAction(page.locator('#run-block'));
    await poll(
      view,
      (data) => data.flow.blocks.find((item) => item.id === workId).attempts[0]?.output.includes('attempt 1'),
      'Progress output was not saved.'
    );
    await page.locator('.attempt-output').filter({ hasText: 'explicit attempt 1' }).waitFor();
    assert.equal(logs.execution.length, 1);
    assert.equal(await page.locator('#run-block').innerText(), '■ Stop');
    await page.getByRole('tab', { name: 'Conversation' }).click();
    assert.equal(await page.locator('#run-block').innerText(), '■ Stop');
    await page.getByRole('tab', { name: 'Details' }).click();
    assert.equal(
      await page.locator('#starting-branch').isDisabled(),
      true,
      'A running issue allows its starting branch to change.'
    );
    await page.reload();
    await page.locator('[data-block="' + workId + '"][aria-pressed="true"]').waitFor();
    const card = page.locator('[data-block="' + workId + '"]');
    const attemptTimer = card.locator('[data-timer-start]').first();
    const stepTimer = card.locator('[data-timer-start]').last();
    assert.equal(await card.locator('.block-description').innerText(), 'pnpm test');
    const originalStart = await stepTimer.getAttribute('data-timer-start');
    const originalTime = await stepTimer.innerText();
    firstWorkProgress.onStep('pnpm test');
    firstWorkProgress.onProgress('Test output arrived without a new command.\n');
    await poll(
      () => stepTimer.innerText(),
      (time) => time !== originalTime,
      'The command timer did not tick.'
    );
    assert.equal(await stepTimer.getAttribute('data-timer-start'), originalStart);
    const attemptStart = await attemptTimer.getAttribute('data-timer-start');
    firstWorkProgress.onStep('pnpm run build');
    await card
      .locator('.block-description')
      .filter({ hasText: /^pnpm run build$/ })
      .waitFor();
    assert.notEqual(await stepTimer.getAttribute('data-timer-start'), originalStart);
    assert.equal(await attemptTimer.getAttribute('data-timer-start'), attemptStart);
    await poll(
      selectedGeometry,
      (value) => Math.abs(value.scrollTop - value.expectedCenter) < 2,
      'The running block was not centered within its content bounds on reload.'
    );
    const header = page.locator('.factory-header');
    const { viewportHeight } = await selectedGeometry();
    await header.evaluate((element) => (element.style.paddingBottom = '20px'));
    await poll(
      selectedGeometry,
      (value) => value.viewportHeight < viewportHeight && Math.abs(value.scrollTop - value.expectedCenter) < 2,
      'The running block lost its centering when the header changed height.'
    );
    await header.evaluate((element) => element.style.removeProperty('padding-bottom'));
    assert.equal(await page.locator('#target-update-menu').isDisabled(), true);
    assert.equal(await page.locator('#worktree-menu option[value="update"]').isDisabled(), true);
    await screenshot('work-running-desktop');
    await clickAction(page.locator('[data-action="stop"]'));
    const stopped = await poll(
      view,
      (data) =>
        data.flow.blocks.find((item) => item.id === workId).attempts[0]?.status === 'stopped' &&
        !service.flows.active.has(issueId),
      'Stop was not retained.'
    );
    const attempt = stopped.flow.blocks.find((item) => item.id === workId).attempts[0];
    await card
      .locator('.block-status')
      .filter({ hasText: /^Stopped after \d+:\d+$/ })
      .waitFor();
    assert.equal(await card.locator('[data-timer-start]').count(), 0);
    assert.match(attempt.output, /explicit attempt 1/);
    assert.ok(stopped.flow.blocks.filter((item) => item.suggested).every((item) => item.attempts.length === 0));
  });
  await check(retryWorkCheck, async () => {
    await page.reload();
    await page.locator('#run-block').filter({ hasText: 'Retry' }).waitFor();
    await clickAction(page.locator('#run-block'));
    const completed = await poll(
      view,
      (data) =>
        data.flow.blocks.find((item) => item.id === workId).attempts.at(-1)?.status === 'completed' &&
        !service.flows.active.has(issueId),
      'Retry did not complete.'
    );
    const attempts = completed.flow.blocks.find((item) => item.id === workId).attempts;
    assert.deepEqual(
      attempts.map((item) => item.status),
      ['stopped', 'completed']
    );
    assert.match(attempts[0].output, /explicit attempt 1/);
    assert.match(attempts[1].output, /explicit attempt 2/);
    assert.ok(completed.flow.blocks.filter((item) => item.suggested).every((item) => item.attempts.length === 0));
    assert.equal(logs.execution.length, 2);
    const retry = attempts.at(-1);
    const seconds = Math.floor((Date.parse(retry.endedAt) - Date.parse(retry.startedAt)) / 1000);
    const expected = [Math.floor(seconds / 60), seconds % 60].map((part) => String(part).padStart(2, '0')).join(':');
    await page
      .locator('[data-block="' + workId + '"] .block-status')
      .filter({ hasText: 'Finished in ' + expected })
      .waitFor();
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
  await check(reloadFlowHistoryCheck, async () => {
    await page.reload();
    await page.locator('[data-block="' + workId + '"][aria-pressed="true"]').waitFor();
    const data = await view();
    assert.equal(data.flow.folder, 'Next release');
    assert.deepEqual(requestData(data.flow).fields, { ...clarified, type: 'bug' });
    const added = data.flow.blocks.find((item) => item.id === addedId);
    assert.equal(added.skill, null);
    assert.equal(added.prompt, 'Trace how saving works and retain exact evidence.');
    assert.equal(added.lane, 1);
    assert.equal(added.comments[0].text, 'Keep every partial attempt for review.');
    assert.deepEqual(
      data.flow.blocks.find((item) => item.id === workId).attempts.map((item) => item.status),
      ['stopped', 'completed']
    );
    assert.equal(logs.execution.length, 2);
    assert.equal(logs.modelCalls.length, 0);
    assert.equal(logs.requests.filter((item) => item.path === '/api/flow-skills').length, 0);
  });
  await check('The responsive workspace keeps controls usable', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await block(workId);
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
    } finally {
      await page.setViewportSize({ width: 1440, height: 960 });
    }
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
    assert.deepEqual(
      logs.failedRequests.filter(
        ({ url, error }) => url !== 'https://example.invalid/report-tracker.png' || error?.errorText !== 'csp'
      ),
      []
    );
    await Promise.all(pendingResponses);
    assert.deepEqual(
      consoleErrorsAfterExpectedResponses([
        ['/api/flow-action', 400, 'Model is disabled in Factory settings.'],
        ['/api/flow-action', 409, 'Request admission rejected.'],
      ]),
      []
    );
    assert.equal(logs.execution.length, 2);
    assert.equal(logs.modelCalls.length, 0);
  });
  await check(runExtraWorkCheck, async () => {
    if (!extraWorkId) {
      await block(workId);
      extraWorkId = await addExtraWork();
    }
    await block(extraWorkId);
    await clickAction(page.locator('#run-block'));
    await poll(
      view,
      (data) =>
        data.flow.blocks.find((item) => item.id === extraWorkId).attempts.at(-1)?.status === 'completed' &&
        !service.flows.active.has(issueId),
      'The Markdown Work block did not finish.'
    );
    assert.equal(logs.execution.length, 3);
    assert.equal(logs.execution.at(-1).blockId, extraWorkId);
  });
  await check(updateWorktreeCheck, async () => {
    await page.goto('/flow?issue=' + issueId);
    await page.locator('[data-node="__base"]').waitFor();
    const menu = page
      .locator('#environment .environment-chip')
      .and(page.getByRole('combobox', { name: 'Worktree', exact: true }));
    assert.equal(await menu.isDisabled(), true);
    assert.equal(await menu.getAttribute('title'), 'No worktree has been created for this issue.');
    const checkout = join(project, '.issues/issue-work', issueId);
    const branch = 'codex/issue-' + issueId;
    const base = git(project, 'rev-parse', 'HEAD');
    git(project, 'worktree', 'add', '-qb', branch, checkout);
    const remote = join(output, 'remote.git');
    git(project, 'init', '--bare', remote);
    git(project, 'remote', 'add', 'origin', remote);
    const target = git(project, 'commit-tree', branchTree, '-p', base, '-m', 'Target update');
    git(project, 'push', 'origin', target + ':refs/heads/older');
    git(project, 'branch', '--set-upstream-to=origin/older', 'recent');
    const flow = service.flows.read(service.flows.selected(issueId));
    await service.flows.store.save(
      {
        ...flow,
        destination: { branch: 'older' },
        workspace: { checkout: realpathSync(checkout), branch, base },
      },
      flow.revision
    );
    const calls = join(output, 'opened-worktree.txt');
    writeFileSync(join(output, 'open'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$TIMEY_TEST_OPEN_LOG"\n', {
      mode: 0o700,
    });
    const originalPath = process.env.PATH;
    process.env.PATH = output + ':' + originalPath;
    process.env.TIMEY_TEST_OPEN_LOG = calls;
    try {
      await page.reload();
      await menu.selectOption('open');
      await page.getByText('Opened the worktree in Finder.', { exact: true }).waitFor();
      assert.equal(readFileSync(calls, 'utf8').trim(), realpathSync(checkout));
      await menu.selectOption('terminal');
      await page.getByText('Opened Terminal in the worktree.', { exact: true }).waitFor();
      assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [
        '-b',
        'com.apple.Terminal',
        realpathSync(checkout),
      ]);
    } finally {
      process.env.PATH = originalPath;
      delete process.env.TIMEY_TEST_OPEN_LOG;
    }
    service.guard = () => [];
    service.flows.executor = createFlowExecutor(service, {
      async verifyCandidate() {
        assert.fail('Update Branch must not run Verify.');
      },
    });
    const targetMenu = page.getByRole('combobox', { name: /Starting branch ahead by/ });
    await targetMenu.selectOption('add');
    await page.getByText('Update Branch block added.', { exact: true }).waitFor();
    const blocks = (await view()).flow.blocks;
    const workIndex = blocks.findIndex((block) => block.kind === 'work');
    const added = blocks[workIndex - 1];
    assert.equal(added.kind, 'update-branch');
    assert.equal(added.label, 'Update Branch');
    assert.equal(added.attempts.length, 0);
    assert.ok(blocks[workIndex].after.includes(added.id));
    const draft = join(checkout, 'branch-draft.txt');
    writeFileSync(draft, 'Preserve this local change.\n');
    const release = Promise.withResolvers();
    await page.route('**/api/flow-action', async (route) => {
      if (route.request().postDataJSON().action === 'update-worktree') await release.promise;
      await route.continue();
    });
    await targetMenu.selectOption('update');
    await page.locator('#target-update-progress').waitFor();
    release.resolve();
    await page
      .locator('#toast')
      .getByText('Updated the issue branch from the starting branch.', { exact: true })
      .waitFor();
    await page.unroute('**/api/flow-action');
    await targetMenu.waitFor({ state: 'hidden' });
    const finished = (await view()).flow.blocks;
    assert.deepEqual(
      finished.map((block) => block.id),
      blocks.map((block) => block.id)
    );
    assert.equal(finished.find((block) => block.id === added.id).attempts.length, 0);
    assert.equal(git(checkout, 'merge-base', 'HEAD', target), target);
    assert.equal(git(checkout, 'show', 'HEAD:branch-draft.txt'), 'Preserve this local change.');
    assert.equal(git(project, 'rev-parse', 'HEAD'), base);
  });
  await check(publishPreviewCheck, async () => {
    const issue = service.flows.selected(issueId);
    const flow = service.flows.read(issue);
    git(project, 'remote', 'set-url', '--push', 'origin', 'git@github.com:test/fixture.git');
    const publish = flow.blocks.find((block) => block.kind === 'publish');
    await page.reload();
    await selectBlock(publish.id);
    assert.equal(await page.locator('#issue-pr-menu').isVisible(), false);
    await page.getByRole('button', { name: 'Open Request' }).waitFor();
    await clickAction(page.locator('#run-block'));
    const description = page.locator('#publish-description');
    await description.waitFor();
    assert.equal(
      await description.textContent(),
      `## Goal\n\n${clarified.goal}\n\n## Requested proof\n\n${clarified.requestedProof}\n\n## Original wording\n\n${savedWording}`
    );
    await screenshot('publish-preview');
    let saved = service.flows.read(issue);
    await service.flows.action({
      action: 'rename-issue',
      issueId,
      revision: saved.revision,
      previousTitle: issue.title,
      title: 'A renamed issue',
    });
    await page.locator('#publish-preview').getByText('A renamed issue', { exact: true }).waitFor();
    await page.locator('#close-publish').click();
    saved = service.flows.read(service.flows.selected(issueId));
    assert.equal(saved.blocks.find((block) => block.id === publish.id).attempts.length, publish.attempts.length);
    const destination = saved.destination;
    const url = 'https://github.com/test/fixture/pull/17';
    saved.destination = { branch: 'older', pr: 17, url, title: 'Update the folder controls' };
    saved = await service.flows.store.save(saved, saved.revision);
    await page.reload();
    await page.locator('#connection-status').filter({ hasText: 'Live' }).waitFor();
    const menu = page.locator('#issue-pr-menu');
    await menu.waitFor();
    await menu.locator('summary').click({ force: true });
    const link = menu.getByRole('link', { name: 'Open', exact: true });
    await link.waitFor();
    assert.equal(await link.getAttribute('href'), url);
    assert.equal(await link.getAttribute('target'), '_blank');
    const approve = menu.getByRole('link', { name: 'Approve', exact: true });
    assert.equal(await approve.getAttribute('href'), url + '/files');
    assert.equal(await approve.getAttribute('target'), '_blank');
    saved.destination = destination;
    await service.flows.store.save(saved, saved.revision);
  });
  await check('Issue Start and Resume respect No new actions and run Update Branch without confirmation', async () => {
    service.flows.executor.close();
    service.flows.executor = executor;
    const previousIssueId = issueId;
    await importBrowserIssue(
      project,
      playbackIssueId,
      `---\nid: ${playbackIssueId}\ntitle: Playback fixture\nstate: backlog\ncreated: 2026-11-16T12:00:00Z\n---\n\n## Original request\n\nTest autoplay.\n`
    );
    issueId = playbackIssueId;
    const issue = service.flows.selected(issueId);
    const flow = service.flows.read(issue);
    flow.blocks = flow.blocks.filter(({ kind }) => ['request', 'work'].includes(kind));
    flow.blocks[0].data.fields = { type: 'feature', goal: 'Test autoplay' };
    let saved = await service.flows.store.save(flow, flow.revision);
    await service.flows.action({
      action: 'add',
      issueId,
      revision: saved.revision,
      kind: 'verify',
      afterId: 'work',
    });
    saved = service.flows.read(issue);
    const verify = saved.blocks.find(({ kind }) => kind === 'verify');
    await service.flows.action({
      action: 'add',
      issueId,
      revision: saved.revision,
      kind: 'update-branch',
      afterId: verify.id,
    });
    saved = service.flows.read(issue);
    const sync = saved.blocks.find(({ kind }) => kind === 'update-branch');
    await page.goto(new URL('/?issue=' + issueId, page.url()).href);
    await page.getByRole('button', { name: 'Start issue' }).click();
    await poll(
      view,
      (data) => data.flow.blocks.find(({ id }) => id === 'work').attempts.at(-1)?.status === 'running',
      'Work did not start.'
    );
    await page.locator(`#open-issues [data-issue="${previousIssueId}"]`).click();
    await page.locator('#issue-title').filter({ hasText: 'A renamed issue' }).waitFor();
    assert.equal((await view()).autoplay.mode, 'playing');
    await page.locator(`#open-issues [data-issue="${issueId}"]`).click();
    await page.getByRole('button', { name: 'Pause issue' }).click();
    await poll(view, (data) => data.autoplay.mode === 'paused', 'Pause was not applied.');
    await page.getByRole('button', { name: 'Resume issue' }).click();
    await poll(view, (data) => data.autoplay.mode === 'playing', 'Resume did not continue during Work.');
    const noNewActions = page.locator('#flow-actions-switch [data-server-toggle]');
    await noNewActions.check();
    await poll(
      async () => (await page.request.get('/api/server-status')).json(),
      (data) => data.phase === 'paused',
      'No new actions did not pause the server.'
    );
    assert.equal(await page.getByRole('button', { name: 'Pause issue' }).isEnabled(), true);
    playbackWork.resolve();
    const paused = await poll(
      view,
      (data) =>
        data.flow.blocks.find(({ id }) => id === 'work').attempts.at(-1)?.status === 'completed' &&
        data.autoplay.mode === 'paused',
      'Work did not finish and pause the route.'
    );
    assert.equal(paused.flow.blocks.find(({ id }) => id === verify.id).attempts.length, 0);
    assert.equal(paused.autoplay.mode, 'paused');
    await page.waitForFunction(() => document.getElementById('issue-playback').disabled);
    await noNewActions.uncheck();
    assert.equal((await view()).autoplay.mode, 'paused');
    assert.equal((await view()).flow.blocks.find(({ id }) => id === verify.id).attempts.length, 0);
    await clickAction(page.getByRole('button', { name: 'Resume issue' }));
    await block('request');
    await page.locator('#issue-results-message').filter({ hasText: 'Flow complete' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Close issue' }).textContent(), 'Close');
    await page.getByRole('button', { name: 'Close issue' }).click();
    const closeDialog = page.getByRole('dialog', { name: 'Close this issue' });
    await closeDialog.waitFor();
    await closeDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.locator('#issue-results').isVisible(), true);
    assert.equal(await page.locator('#issue-heading ~ #issue-results').count(), 1);
    assert.equal(await page.locator('#playback-status').textContent(), '');
    assert.equal(await page.locator('[data-block="request"][aria-pressed="true"]').count(), 1);
    assert.equal(await page.locator('#waiting-block').isVisible(), false);
    await page.reload();
    assert.equal((await view()).flow.blocks.find(({ id }) => id === sync.id).attempts.at(-1).status, 'completed');
    assert.deepEqual(logs.pageErrors, []);
  });
  await check('The issue header closes with a reason and runs only Cleanup by default', async () => {
    const close = page.getByRole('button', { name: 'Close issue', exact: true });
    assert.equal(await page.locator('#worktree-hint + #close-with-reason').count(), 1);
    const dialog = page.getByRole('dialog', { name: 'Close this issue' });
    const executionCount = logs.execution.length;
    await close.click();
    await dialog.getByLabel('Reason', { exact: true }).locator('option[value="fixed"]').waitFor({ state: 'attached' });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(logs.requests.filter(({ path }) => path === '/api/issue-decision').length, 0);
    await close.click();
    await dialog.getByLabel('Reason', { exact: true }).selectOption('duplicate');
    await dialog.getByLabel('Details or related issue (optional)').fill('Already covered by issue #44');
    await dialog.getByRole('button', { name: 'Close issue', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await close.waitFor({ state: 'hidden' });
    await poll(() => !service.flows.closureBusy(issueId), Boolean, 'Close did not finish Cleanup.');
    assert.deepEqual(
      logs.execution.slice(executionCount).map(({ blockId }) => blockId),
      [service.flows.read(service.flows.selected(issueId)).blocks.find(({ kind }) => kind === 'cleanup').id]
    );
    const saved = service.flows.selected(issueId);
    assert.equal(saved.location, 'closed');
    assert.equal(saved.closure.reason, 'duplicate');
    assert.equal(saved.closure.details, 'Already covered by issue #44');
    assert.equal(saved.accepted_result, undefined);
  });
  await check('Manual Fixed accepts retained Flow investigation evidence before running Cleanup', async () => {
    issueId = '20261116-manual-fixed-fixture';
    await importBrowserIssue(
      project,
      issueId,
      `---\nid: ${issueId}\ntitle: Manual Fixed fixture\nstate: backlog\nrequest_type: investigation\ncreated: 2026-11-16T12:00:00Z\n---\n\nInvestigate the test project.\n`
    );
    const flow = service.flows.read(service.flows.selected(issueId));
    const checkout = join(project, '.issues/issue-work', issueId);
    const branch = 'codex/issue-' + issueId;
    const base = git(project, 'rev-parse', 'HEAD');
    git(project, 'worktree', 'add', '-qb', branch, checkout, base);
    const checkoutRoot = realpathSync(checkout);
    const head = git(checkoutRoot, 'rev-parse', 'HEAD');
    const tree = git(checkoutRoot, 'rev-parse', 'HEAD^{tree}');
    flow.workspace = { checkout: checkoutRoot, branch, base };
    flow.startingPoint = { ref: 'refs/heads/dev', name: 'dev', commit: base };
    flow.blocks[0].data.fields = { type: 'investigation' };
    const inquiry = flow.blocks.find(({ kind }) => kind === 'investigate');
    const path = join(project, '.issues', 'manual-fixed-evidence.txt');
    const output = 'The project serves the saved issue flow.';
    writeFileSync(path, output);
    inquiry.attempts.push({
      id: 'fixture-investigate',
      status: 'completed',
      startedAt: '2026-11-16T12:00:00Z',
      output,
      evidence: [{ path, sha256: createHash('sha256').update(output).digest('hex') }],
      result: { head, base, tree },
    });
    await service.flows.store.save(flow, flow.revision);
    const executionCount = logs.execution.length;
    await page.goto(new URL('/?issue=' + issueId, page.url()).href);
    await page.locator('#connection-status').filter({ hasText: 'Live' }).waitFor();
    await page.locator('#graph [data-block="' + inquiry.id + '"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#investigation-page').isVisible(), false);
    const flowView = await view();
    const closure = await page.request.get('/api/issue-closure?issue=' + encodeURIComponent(issueId));
    assert.equal(closure.status(), 200);
    const response = await page.request.post('/api/issue-decision', {
      timeout: 60_000,
      headers: {
        'Content-Type': 'application/json',
        'X-Factory-Action': 'manual',
        Origin: new URL(page.url()).origin,
      },
      data: {
        ...(await closure.json()),
        kind: 'close',
        flowRevision: flowView.flow.revision,
        resolution: 'fixed',
        reason: '',
      },
    });
    const body = await response.text();
    assert.equal(response.status(), 200, body);
    await poll(
      () => existsSync(join(project, '.issues/closed', issueId + '.md')),
      (present) => present,
      'Issue did not close.'
    );
    await poll(
      () => logs.execution.length,
      (count) => count > executionCount && !service.flows.closureBusy(issueId),
      'Cleanup did not finish.'
    );
    const saved = service.flows.selected(issueId);
    assert.equal(saved.closure.reason, 'fixed');
    assert.equal(saved.accepted_result.revision, base);
    assert.equal(readFileSync(saved.accepted_result.evidence[0].path, 'utf8'), output);
    assert.deepEqual(
      logs.execution.slice(executionCount).map(({ blockId }) => blockId),
      [service.flows.read(saved).blocks.find(({ kind }) => kind === 'cleanup').id]
    );
    assert.deepEqual(logs.pageErrors, []);
  });
  await check(proposalsCheck, async () => {
    const previous = issueId;
    await page.goto('/');
    const runs = logs.execution.length;
    const create = page.locator('#capture-dialog');
    await page.locator('#new-issue').click();
    assert.equal(await create.getByLabel('Run a retro').isChecked(), false);
    assert.equal(await create.getByLabel('Needs approval').isChecked(), false);
    await create.getByLabel('Your request').fill('Review an idle approval proposal');
    await create.getByLabel('Run a retro').check();
    await create.getByLabel('Needs approval').check();
    await create.getByRole('button', { name: 'Create issue', exact: true }).click();
    const approval = page.getByRole('button', { name: 'Approve', exact: true });
    const remove = page.getByRole('button', { name: 'Delete', exact: true });
    await approval.waitFor();
    await remove.waitFor();
    await page.locator('#close-with-reason').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#worktree-menu').isVisible(), false);
    await clickAction(approval);
    await page.locator('#close-with-reason').waitFor();
    assert.equal(await approval.isVisible(), false);
    assert.equal(await remove.isVisible(), false);

    const title = 'Discard an idle retro proposal';
    await service.flows.fileRetroItems([
      {
        requestId: randomUUID(),
        title,
        description: 'An example recommendation from Retro.',
        reason: 'Exercise proposal deletion.',
        verification: 'Check the report file is gone.',
      },
    ]);
    const proposal = service.flows.issues().find((issue) => issue.title === title);
    assert.ok(proposal);
    assert.equal(service.flows.read(service.flows.selected(proposal.id)).folder, 'Retro items');
    const reportPath = join(project, '.issues', proposal.id + '.md');
    assert.equal(existsSync(reportPath), true);
    const row = page.locator(`#open-issues [data-issue="${proposal.id}"]`);
    await page.goto(new URL('/?issue=' + proposal.id, page.url()).href);
    await row.waitFor();
    const canceled = page.waitForEvent('dialog');
    const cancelClick = remove.click();
    const confirmation = await canceled;
    assert.match(confirmation.message(), /Permanently delete .*Discard an idle retro proposal/);
    await confirmation.dismiss();
    await cancelClick;
    assert.equal(existsSync(reportPath), true);
    let delayedDelete = Promise.resolve();
    const delayDelete = (route) => {
      if (route.request().postDataJSON()?.action !== 'delete-pending-issue') return route.continue();
      delayedDelete = new Promise((done) => setTimeout(done, 16000)).then(() => route.continue());
      return delayedDelete;
    };
    if (process.argv.includes('--delayed-delete')) await page.route('**/api/flow-action', delayDelete);
    page.once('dialog', (dialog) => void dialog.accept());
    try {
      await clickAction(remove);
    } finally {
      await delayedDelete;
      if (process.argv.includes('--delayed-delete')) await page.unroute('**/api/flow-action', delayDelete);
    }
    await row.waitFor({ state: 'detached' });
    assert.equal(new URL(page.url()).searchParams.has('issue'), false);
    assert.equal(existsSync(reportPath), false);
    assert.equal(logs.execution.length, runs);
    await page.goto(previous ? '/?issue=' + previous : '/');
  });
  await check('Worktree Delete requires confirmation and shows why the menu is disabled afterward', async () => {
    const closedIssueId = issueId;
    issueId = worktreeIssueId;
    assert.ok(issueId);
    await page.goto(new URL('/flow?issue=' + issueId, page.url()).href);
    await page.locator('[data-node="__base"]').waitFor();
    const flow = service.flows.read(service.flows.selected(issueId));
    assert.ok(flow.workspace?.checkout);
    const { checkout, branch } = flow.workspace;
    const previewBranchRevision = git(project, 'rev-parse', branch);
    if (!service.lifecycleRuns[issueId]?.work) {
      saveLifecycle(
        service,
        { issueId, events: [] },
        {
          work: { checkout: realpathSync(checkout), branch, config: deliveryConfig },
        }
      );
    }
    const menu = page.getByRole('combobox', { name: 'Worktree', exact: true });
    await menu.waitFor();
    const previewPromise = page.waitForEvent('dialog');
    await menu.selectOption('delete');
    const preview = await previewPromise;
    assert.match(preview.message(), /Delete this worktree and discard its uncommitted changes/);
    assert.ok(preview.message().includes(realpathSync(checkout)));
    await preview.dismiss();
    assert.ok(readFileSync(join(checkout, 'source.txt'), 'utf8'));

    const uncommitted = join(checkout, 'draft.txt');
    writeFileSync(uncommitted, 'Uncommitted work.');
    page.once('dialog', (dialog) => void dialog.accept());
    await menu.selectOption('delete');
    await page.getByText('Worktree deleted.', { exact: true }).waitFor();
    assert.equal(await menu.isDisabled(), true);
    assert.equal(await menu.getAttribute('title'), 'This issue’s worktree has been deleted.');
    assert.throws(() => readFileSync(join(checkout, 'source.txt')), /ENOENT/);
    assert.equal(existsSync(uncommitted), false);
    assert.equal(git(project, 'rev-parse', branch), previewBranchRevision);
    assert.equal(service.flows.selected(closedIssueId).closure.reason, 'fixed');
    issueId = closedId;
    await page.goto(new URL('/flow?issue=' + issueId, page.url()).href);
    await page.getByRole('img', { name: 'Issue closed' }).waitFor();
  });
  await check('Closed issues can be reopened or archived from Flow', async () => {
    const archive = page.getByRole('combobox', { name: 'Archive', exact: true });
    const close = page.getByRole('button', { name: 'Close', exact: true });
    await archive.waitFor();
    const closedIndicator = page.getByRole('img', { name: 'Issue closed' });
    await closedIndicator.waitFor();
    assert.equal(await page.locator('#issue-playback').isVisible(), false);
    assert.equal(await close.isVisible(), false);
    assert.equal(await archive.locator('option[value="reveal"]').textContent(), 'Reveal in Finder');
    page.once('dialog', (dialog) => void dialog.accept());
    await archive.selectOption('reopen');
    await close.waitFor();
    await page.getByRole('button', { name: 'Start issue' }).waitFor();
    assert.equal(await closedIndicator.isVisible(), false);
    assert.equal(service.flows.selected(issueId).location, 'open');
    assert.equal(await archive.isVisible(), false);

    issueId = playbackIssueId;
    await page.goto('/?issue=' + issueId);
    await archive.waitFor();
    page.once('dialog', (dialog) => void dialog.accept());
    await archive.selectOption('archive');
    await page.getByText('Issue archived.', { exact: true }).waitFor();
    await archive.waitFor({ state: 'hidden' });
    assert.equal(new URL(page.url()).searchParams.has('issue'), false);
    assert.match(readFileSync(join(project, '.issues/archive', issueId + '.md'), 'utf8'), /duplicate/);
    await page.goto('/?issue=' + issueId);
    await archive.waitFor();
    assert.equal((await view()).issue.location, 'archive');
    assert.equal(await archive.locator('option[value="archive"]').getAttribute('hidden'), '');
    assert.equal(await archive.locator('option[value="cleanup"]').textContent(), 'Run Cleanup');
  });
  await check('The inspector delete button confirms before removing a block', async () => {
    issueId = worktreeIssueId;
    const issue = service.flows.selected(issueId);
    const flow = service.flows.read(issue);
    await service.flows.action({ action: 'add', issueId, revision: flow.revision, kind: 'advice' });
    const added = service.flows.read(issue).blocks.find((item) => item.kind === 'advice');
    await page.goto('/flow?issue=' + issueId);
    await block('request');
    const remove = page.getByRole('button', { name: 'Delete block', exact: true });
    assert.equal(await remove.isDisabled(), true);
    await block(added.id);
    await page.getByRole('tab', { name: 'Conversation' }).click();
    page.once('dialog', (dialog) => void dialog.dismiss());
    await remove.click();
    assert.ok((await view()).flow.blocks.some((item) => item.id === added.id));
    page.once('dialog', (dialog) => void dialog.accept());
    await clickAction(remove);
    await page.locator(`[data-block="${added.id}"]`).waitFor({ state: 'detached' });
    assert.ok(!(await view()).flow.blocks.some((item) => item.id === added.id));
  });
  await check(issueResultsCheck, async () => {
    const resultsIssueId = '20261118-results-fixture';
    await importBrowserIssue(
      project,
      resultsIssueId,
      `---\nid: ${resultsIssueId}\ntitle: Keep results and status visible\nstate: backlog\n---\n\nShow results below the banner.\n`
    );
    await page.goto('/?issue=' + resultsIssueId);
    await page.locator('#issue-title').filter({ hasText: 'Keep results and status visible' }).waitFor();
    assert.equal(await page.locator('#issue-results').isVisible(), false);
    const message =
      'Commit the verified working-tree snapshot before publishing. If its content is unchanged, its verification remains valid.';
    service.flows.pause(resultsIssueId, message);
    await page.reload();
    await page.locator('#issue-results-message').filter({ hasText: message }).waitFor();
    assert.equal(await page.locator('#issue-heading ~ #issue-results').count(), 1);
    assert.equal(await page.locator('#playback-status').textContent(), '');
    const banner = await page.locator('#issue-heading').boundingBox();
    const results = await page.locator('#issue-results').boundingBox();
    assert.ok(results.y >= banner.y + banner.height);
    await screenshot('issue-results');
    service.flows.pause(resultsIssueId);
    await page.reload();
    await page.locator('#issue-title').filter({ hasText: 'Keep results and status visible' }).waitFor();
    assert.equal(await page.locator('#issue-results').isVisible(), false);
    assert.equal(await page.locator('#playback-status').textContent(), '');
    if (issueId) await page.goto('/?issue=' + issueId);
  });
  await check(humanInputCheck, async () => {
    const id = '20261118-human-input-fixture';
    await importBrowserIssue(
      project,
      id,
      `---\nid: ${id}\ntitle: Review before merging\nstate: backlog\n---\n\nMake the required review visible.\n`
    );
    const issue = service.flows.selected(id);
    let flow = service.flows.read(issue);
    const merge = flow.blocks.find((block) => block.kind === 'merge');
    for (const block of flow.blocks.slice(0, flow.blocks.indexOf(merge)))
      block.attempts = [{ id: 'done-' + block.id, status: 'completed', startedAt: '2026-11-18T12:00:00Z' }];
    merge.attempts = [
      {
        id: 'legacy-review',
        status: 'blocked',
        startedAt: '2026-11-18T12:00:01Z',
        summary: 'GitHub is waiting for a required review on this PR.',
      },
    ];
    flow.autoClose = false;
    flow.destination = { ...flow.destination, branch: 'dev', pr: 17, url: 'https://github.com/test/fixture/pull/17' };
    await service.flows.store.save(flow, flow.revision);
    const savedMerge = () => service.flows.read(issue).blocks.find((block) => block.id === merge.id);
    let approved = false;
    let calls = 0;
    const run = executor.run;
    const provider = service.flows.deliveryOptions.provider;
    const inspect = provider.inspect;
    provider.inspect = async (number) => {
      assert.equal(number, 17);
      const repo = { full_name: deliveryConfig.repository };
      return {
        number,
        html_url: flow.destination.url,
        state: 'open',
        merged_at: null,
        head: { ref: 'fixture-review', sha: 'fixture-head', repo },
        base: { ref: 'dev', repo },
      };
    };
    executor.run = async (ctx) => {
      if (ctx.issue.id !== id) return run(ctx);
      calls++;
      assert.equal(ctx.continuing, true);
      if (!approved)
        throw Object.assign(requiredPRReview(), {
          humanInput: { ...requiredPRReview().humanInput, url: flow.destination.url },
        });
      return { summary: 'GitHub confirms the protected merge.' };
    };
    const assertRequest = async () => {
      await page.locator('#issue-results-title').filter({ hasText: 'Needs your input' }).waitFor();
      assert.match(await page.locator('#issue-results-message').textContent(), /eligible reviewer.*Continue/);
      assert.equal(await page.locator('#issue-input-link').getAttribute('href'), flow.destination.url);
      await page.locator(`#open-issues [data-issue="${id}"] .issue-input-label`).waitFor();
      await page
        .locator(`#graph [data-block="${merge.id}"] .block-status`)
        .filter({ hasText: 'Needs your input' })
        .waitFor();
      await selectBlock(merge.id);
      assert.equal(await page.locator('#run-block').textContent(), 'Continue');
    };
    try {
      await page.goto('/?issue=' + id);
      await assertRequest();
      assert.equal(calls, 0);
      const noNewActions = page.locator('#flow-actions-switch [data-server-toggle]');
      await noNewActions.check();
      await page.waitForFunction(() => document.getElementById('issue-input-continue').disabled);
      await noNewActions.uncheck();
      await page.waitForFunction(() => !document.getElementById('issue-input-continue').disabled);
      assert.equal(calls, 0);
      await page.locator('#issue-input-continue').click();
      await poll(
        savedMerge,
        (block) => block.attempts.length === 2 && !service.flows.active.has(id),
        'Explicit Continue did not record the review request.'
      );
      const attempt = savedMerge().attempts.at(-1);
      assert.equal(attempt.result.humanInput.kind, 'pr-review');
      await page.reload();
      await assertRequest();
      await screenshot('needs-your-input');
      approved = true;
      await page.reload();
      await assertRequest();
      assert.equal(calls, 1, 'Approval and reload must not resume Merge');
      await page.locator('#issue-input-continue').click();
      await poll(
        savedMerge,
        (block) => block.attempts.at(-1)?.status === 'completed' && !service.flows.active.has(id),
        'Continue did not complete Merge.'
      );
      await page.reload();
      await page.locator('#issue-title').filter({ hasText: 'Review before merging' }).waitFor();
      assert.equal(await page.locator('#issue-input-actions').isVisible(), false);
      assert.equal(await page.locator(`#open-issues [data-issue="${id}"] .issue-input-label`).count(), 0);
      assert.equal(calls, 2);
      flow = service.flows.read(issue);
      flow.blocks
        .find((b) => b.id === merge.id)
        .attempts.push({
          id: 'technical-failure',
          status: 'blocked',
          startedAt: '2026-11-18T12:10:00Z',
          endedAt: '2026-11-18T12:10:01Z',
          summary: 'Verification failed.',
        });
      await service.flows.store.save(flow, flow.revision);
      await page.reload();
      await selectBlock(merge.id);
      assert.equal(await page.locator('#run-block').textContent(), 'Retry');
      assert.equal(await page.locator('#issue-input-actions').isVisible(), false);
    } finally {
      executor.run = run;
      if (inspect) provider.inspect = inspect;
      else delete provider.inspect;
    }
    if (issueId) await page.goto('/?issue=' + issueId);
  });
  await check('Branch repair progress survives reload and requires candidate approval', async () => {
    await branchRepairBrowserChecks({ page, service, project, poll, screenshot });
  });
  await check('Block skill choices preserve defaults and offer missing-skill setup', async () => {
    await blockSkillsBrowserChecks({ page, service, project, poll });
  });
  await check('Native Flow approvals and questions retain their exact attempt', () =>
    nativeAgentBrowserChecks({ page, service, project, poll, screenshot })
  );
  await check(blockDeletionCheck, async () => {
    const deletionIssueId = '20261117-block-deletion-fixture';
    await importBrowserIssue(
      project,
      deletionIssueId,
      `---\nid: ${deletionIssueId}\ntitle: Delete selected flow blocks\nstate: backlog\n---\n\nRemove a block after an explicit click.\n`
    );
    await flowBlockDeletionBrowserChecks(page, service, deletionIssueId);
    if (issueId) await page.goto('/?issue=' + issueId);
  });
  await check(timersCheck, async () => {
    const timerIssueId = '20261124-flow-timers-fixture';
    await importBrowserIssue(
      project,
      timerIssueId,
      `---\nid: ${timerIssueId}\ntitle: Attempt timers\nstate: backlog\n---\n\nVerify each saved attempt duration.\n`
    );
    await page.goto('/?issue=' + timerIssueId);
    await page.locator('#connection-status').filter({ hasText: 'Live' }).waitFor();
    const issue = service.flows.selected(timerIssueId);
    let flow = service.flows.read(issue);
    const request = () => flow.blocks.find((item) => item.kind === 'request');
    const badge = page.locator('[data-block="' + request().id + '"] .block-status');
    request().attempts = [
      {
        id: 'waiting-attempt',
        status: 'uncertain',
        startedAt: '2026-11-16T12:00:00Z',
        inputRequestedAt: '2026-11-16T12:00:05Z',
        endedAt: '2026-11-16T12:08:00Z',
      },
    ];
    flow = await service.flows.store.save(flow, flow.revision);
    await badge.filter({ hasText: /^Needs input$/ }).waitFor();
    request().attempts.push({
      id: 'failed-attempt',
      status: 'blocked',
      startedAt: '2026-11-16T12:10:00Z',
      endedAt: '2026-11-16T12:10:07Z',
    });
    flow = await service.flows.store.save(flow, flow.revision);
    await badge.filter({ hasText: /^Failed after 00:07$/ }).waitFor();
    request().attempts.push({
      id: 'disconnected-attempt',
      status: 'running',
      startedAt: '2026-11-16T12:20:00Z',
      lastActiveAt: '2026-11-16T12:20:09Z',
    });
    await service.flows.store.save(flow, flow.revision);
    await badge.filter({ hasText: /^Disconnected after 00:09$/ }).waitFor();
    await page.reload();
    await badge.filter({ hasText: /^Disconnected after 00:09$/ }).waitFor();
  });
  await check(
    'Flow and Classic reload the selected issue after a lost connection without replaying the click',
    async () => {
      issueId = await connectionRecoveryIssue();
      const helperDir = '.agents/skills/issues/scripts';
      mkdirSync(join(project, helperDir), { recursive: true });
      for (const file of ['human-input.mjs', 'human-input-version.json']) {
        copyFileSync(join(root, helperDir, file), join(project, helperDir, file));
      }
      writeFileSync(join(project, '.issues/preferences.json'), '{"commit":true}');
      const screens = [
        { path: '/?issue=' + issueId, error: '#error-message', toggle: '#flow-actions-switch input' },
        { path: '/classic#/issue/' + issueId, error: '#error', toggle: '#server-controls [data-server-toggle]' },
      ];
      for (const screen of screens) {
        await page.goto(screen.path);
        const toggle = page.locator(screen.toggle);
        const waiting = page.getByText('Waiting for server…', { exact: true });
        await toggle.waitFor();
        const url = page.url();

        await context.clearCookies();
        if (!screen.path.startsWith('/classic')) await page.locator('#refresh').click();
        const expired = page.locator(screen.error).filter({ hasText: /session expired.*Reload this page/ });
        await expired.waitFor();
        await page.waitForResponse((response) => response.url().endsWith('/api/health') && response.status() === 204);
        assert.equal(await expired.isVisible(), true);
        assert.equal(await waiting.isVisible(), false);
        assert.equal(page.url(), url);
        await page.reload();
        await page.locator('#server-actions-dialog').waitFor({ state: 'attached' });
        if (await toggle.isChecked()) await toggle.uncheck();
        await page.locator(screen.toggle + ':not(:checked):not(:disabled)').waitFor();

        const release = Promise.withResolvers();
        const pauseReceived = Promise.withResolvers();
        await page.route('**/api/health', async (route) => {
          await pauseReceived.promise;
          if (screen.path.startsWith('/classic')) await release.promise;
          await route.abort().catch(() => {});
        });
        let clicks = 0;
        await page.route('**/api/server-pause', async (route) => {
          clicks++;
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          await route.abort();
          pauseReceived.resolve();
        });
        const pauseRequest = page.waitForRequest('**/api/server-pause');
        await toggle.click();
        await pauseRequest;
        await waiting.waitFor();
        assert.equal(page.url(), url);
        assert.equal(clicks, 1);

        const reloaded = page.waitForEvent('load');
        await page.unroute('**/api/health');
        release.resolve();
        await reloaded;
        assert.equal(page.url(), url);
        await page.locator(screen.toggle + ':checked').waitFor();
        assert.equal(await waiting.isVisible(), false);
        assert.equal(clicks, 1);
        await page.unroute('**/api/server-pause');
        await toggle.uncheck();
        await page.locator(screen.toggle + ':not(:checked):not(:disabled)').waitFor();
      }
    }
  );
  await check('Starting branch confirmation moves saved work through the real UI', async () => {
    issueId = '20261117-starting-branch-fixture';
    await importBrowserIssue(
      project,
      issueId,
      `---\nid: ${issueId}\ntitle: Correct the starting branch\nstate: backlog\n---\n\nMove the saved edits.\n`
    );
    const issue = service.flows.selected(issueId);
    const flow = service.flows.read(issue);
    const base = git(project, 'rev-parse', 'refs/heads/dev');
    const checkout = join(realpathSync(project), '.issues/issue-work', issueId);
    const branch = 'codex/browser-branch-move';
    git(project, 'worktree', 'add', '-b', branch, checkout, base);
    writeFileSync(join(checkout, 'saved-edit.txt'), 'Keep this local edit.\n');
    flow.workspace = { branch, base, checkout };
    flow.startingPoint = { ref: 'refs/heads/dev', name: 'dev', commit: base };
    await service.flows.store.save(flow, flow.revision);
    await page.goto('/?issue=' + issueId);
    const selector = page.getByRole('combobox', { name: 'Starting branch', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Change starting branch' });
    await selector.selectOption('refs/remotes/origin/recent');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await selector.inputValue(), 'refs/heads/dev');
    await selector.selectOption('refs/remotes/origin/recent');
    await dialog.getByRole('button', { name: 'Move issue work', exact: true }).click();
    await page.getByText('Moved the issue to the selected starting branch.', { exact: true }).waitFor();
    assert.equal((await view()).flow.workspace.base, recentBranchCommit);
    assert.equal(git(checkout, 'show', 'HEAD:saved-edit.txt'), 'Keep this local edit.');
    await screenshot('starting-branch-moved');
  });
  await check(homeCheck, () => projectHomeBrowserChecks({ page, service, poll, screenshot }));
  await check('Pending local merges are visible and can be aborted', () =>
    mergeStateBrowserChecks({ page, project, service, screenshot })
  );
  await check('Actions menu lists two running Flow blocks', () =>
    actionsMenuBrowserChecks({ page, project, service, poll, screenshot, output })
  );
  await check('Merged issues preserve history and expose only closure controls', () =>
    mergedIssueBrowserChecks({ page, project, service, screenshot, output, poll })
  );
  assert.ok(!ciPart || results.length, 'The Flow browser CI part did not execute any scenarios.');
  passed = true;
} catch (error) {
  failure = error.stack;
  console.error(error);
  if (page) await screenshot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  if (page && process.env.NODE_V8_COVERAGE) {
    const scripts = await page.coverage.stopJSCoverage().catch(() => []);
    const result = scripts.flatMap((script) => {
      const filename = new URL(script.url).pathname;
      if (!/^\/[\w-]+\.js$/.test(filename)) return [];
      const path = join(dirname(fileURLToPath(import.meta.url)), 'factory-ui', filename.slice(1));
      if (!existsSync(path) || readFileSync(path, 'utf8') !== script.source) return [];
      return [{ ...script, url: pathToFileURL(path).href }];
    });
    mkdirSync(process.env.NODE_V8_COVERAGE, { recursive: true });
    writeFileSync(join(process.env.NODE_V8_COVERAGE, 'browser-' + randomUUID() + '.json'), JSON.stringify({ result }));
  }
  await browser?.close();
  await Promise.all(pendingResponses);
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
