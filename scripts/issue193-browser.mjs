import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactoryUI } from './factory-ui/service.mjs';
import { createFactoryServer } from './factory-ui/http.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { mergedDelivery } from './factory-ui/merged-issue.mjs';
import { collectEvidence } from './factory-ui/stores/evidence.mjs';
import { ensureProjectStores, hydrateProjectEvidence, closeProjectStores } from './factory-ui/stores/runtime.mjs';

const candidateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(process.env.TIMEY_ISSUE193_SOURCE || join(candidateRoot, '../../..'));
const output = resolve(
  process.env.TIMEY_ISSUE193_BROWSER_OUTPUT || join(candidateRoot, '.issues/evidence/issue-stores/issue193-browser')
);
const issueId = '20261121T175626340-4f536bc22ad8b97d';
const hash = (body) => createHash('sha256').update(body).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

function originalIssue() {
  const reports = ['.issues', '.issues/closed', '.issues/archive']
    .map((location) => join(sourceRoot, location, issueId + '.md'))
    .filter(existsSync);
  assert.equal(reports.length, 1, 'Issue 193 must have one original report.');
  const reportPath = reports[0];
  const flowPath = join(sourceRoot, '.issues/flows', issueId, 'flow.json');
  const report = readFileSync(reportPath);
  const flowBytes = readFileSync(flowPath);
  const flow = JSON.parse(flowBytes);
  assert.equal(flow.revision, 3989);
  assert.ok(mergedDelivery(flow));
  assert.equal(JSON.parse(readFileSync(join(sourceRoot, '.issues/issue-numbers.json'))).issues[issueId], 193);
  return {
    reportPath,
    flowPath,
    report,
    flowBytes,
    flow,
    location: reportPath.includes('/closed/') ? 'closed' : reportPath.includes('/archive/') ? 'archive' : 'open',
  };
}

function checkoutFingerprint(root) {
  const index = git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  return { head: git(root, 'rev-parse', 'HEAD'), index: existsSync(index) ? hash(readFileSync(index)) : null };
}

function sourceFingerprint(original) {
  return {
    ...checkoutFingerprint(sourceRoot),
    report: hash(readFileSync(original.reportPath)),
    flow: hash(readFileSync(original.flowPath)),
    workspace:
      original.flow.workspace?.checkout && existsSync(original.flow.workspace.checkout)
        ? checkoutFingerprint(original.flow.workspace.checkout)
        : null,
  };
}

function disposableProject() {
  const project = mkdtempSync(join(tmpdir(), 'timey-issue193-browser-'));
  git(project, 'init', '-q', '-b', 'dev');
  git(project, 'config', 'user.name', 'Issue 193 isolated browser verification');
  git(project, 'config', 'user.email', 'fixture@example.invalid');
  git(project, 'config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(project, 'source.txt'), 'Disposable browser source.\n');
  writeFileSync(join(project, '.gitignore'), '/.issues/\n');
  git(project, 'add', '.');
  git(project, 'commit', '-qm', 'Isolated browser source');
  mkdirSync(join(project, '.issues'), { recursive: true });
  copyFileSync(join(candidateRoot, '.issues/triage-labels.md'), join(project, '.issues/triage-labels.md'));
  writeFileSync(
    join(project, '.issues/stores.json'),
    JSON.stringify({
      version: 1,
      projectId: 'issue193-browser-' + randomUUID(),
      issueDefault: 'files',
      coordination: 'files',
      artifacts: 'files',
      stores: [
        { id: 'files', label: 'Disposable local files', kind: 'files', roles: ['issue', 'coordination', 'artifact'] },
      ],
    })
  );
  return project;
}

async function importExactIssue(service, original) {
  const stores = await ensureProjectStores(service, { fresh: true });
  const manifest = await collectEvidence({
    root: sourceRoot,
    flow: original.flow,
    artifacts: stores.artifacts,
    originId: 'issue193-browser',
    allowedRoots: [join(sourceRoot, '.issues')],
  });
  assert.equal(manifest.files.length, 651);
  assert.equal(manifest.gaps.length, 557);
  await stores.importIssue({
    id: issueId,
    number: 193,
    report: original.report,
    flow: original.flow,
    storeId: 'files',
    location: original.location,
    operationId: 'import-original-193',
  });
  const folder = { open: '.issues', closed: '.issues/closed', archive: '.issues/archive' }[original.location];
  mkdirSync(join(service.root, folder), { recursive: true });
  writeFileSync(join(service.root, folder, issueId + '.md'), original.report);
  const flowDirectory = join(service.root, '.issues/flows', issueId);
  mkdirSync(flowDirectory, { recursive: true });
  writeFileSync(join(flowDirectory, 'flow.json'), original.flowBytes);
  await stores.coordination.commit(
    'import-original-193-evidence',
    [{ key: 'evidence/' + issueId, revision: null }],
    [{ key: 'evidence/' + issueId, value: manifest }]
  );
  await stores.refresh();
  const [hydrated] = await hydrateProjectEvidence(service, issueId);
  assert.equal(hydrated.files.length, 651);
  assert.deepEqual(hydrated.gaps, manifest.gaps);
  assert.equal(hash(readFileSync(join(flowDirectory, 'flow.json'))), hash(original.flowBytes));
  return { stores, manifest };
}

function observer(original, calls) {
  const merge = mergedDelivery(original.flow);
  return {
    async observe() {
      calls.observations++;
      return {
        worktreeExists: true,
        branch: original.flow.workspace.branch,
        head: merge.head,
        dirty: false,
        targetBranch: 'dev',
        pr: {
          number: merge.pr,
          url: merge.url,
          head: merge.head,
          revision: merge.revision,
          mergedAt: merge.mergedAt || '2026-11-21T00:00:00.000Z',
        },
      };
    },
  };
}

async function inspectThroughBrowser(page, original, manifest, screenshot) {
  await page.goto('/?issue=' + issueId);
  await page.getByText('Merged. This issue is read-only. Close it when ready.', { exact: true }).waitFor();
  assert.equal(await page.locator('#issue-number').textContent(), '#193');
  assert.equal(await page.locator('#rename-issue').isDisabled(), true);
  assert.equal(await page.locator('#rebuild-flow').isDisabled(), true);
  if (await page.locator('#issue-playback').isVisible())
    assert.equal((await page.locator('#issue-playback').textContent()).trim(), 'Close');
  const viewResponse = await page.request.get('/api/flow?issue=' + issueId);
  assert.equal(viewResponse.ok(), true);
  const view = await viewResponse.json();
  assert.equal(view.flow.revision, 3989);
  assert.equal(view.issue.readOnly, true);
  const work = original.flow.blocks.find((block) => block.kind === 'work');
  const attempt = work.attempts[0];
  await page.locator('[data-block="' + work.id + '"]').click();
  await page.locator('[data-attempt-id="' + attempt.id + '"]').waitFor();
  assert.equal(await page.locator('#run-block').isVisible(), false);
  const workArtifacts = view.artifacts.filter((artifact) => artifact.attemptId === attempt.id);
  assert.equal(view.artifacts.length, 638);
  assert.equal(workArtifacts.length, new Set(attempt.evidence.map((entry) => entry.path)).size);
  assert.equal(await page.locator('.evidence-link').count(), workArtifacts.length);
  await page.locator('[data-attempt-id="' + attempt.id + '"] .progress-heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshot('work-history'), fullPage: false });
  await page.locator('#tab-artifacts').click();
  await page.screenshot({ path: screenshot('retained-evidence'), fullPage: false });
  const proof = manifest.files.find(
    (file) =>
      file.bytes > 0 &&
      file.bytes < 150000 &&
      file.path.endsWith('.json') &&
      workArtifacts.some((artifact) => artifact.originalPath === file.path)
  );
  assert.ok(proof, 'Work history must expose a retained text proof.');
  const artifact = workArtifacts.find((item) => item.originalPath === proof.path);
  const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/shown-file');
  await page.locator('[data-artifact-id="' + artifact.id + '"]').click();
  const response = await responsePromise;
  assert.equal(response.ok(), true);
  const document = await response.json();
  assert.equal(hash(Buffer.from(document.content)), proof.sha256);
  await page.waitForFunction(
    (content) => document.getElementById('file-content').textContent === content,
    document.content
  );
  assert.equal(await page.locator('#file-content').textContent(), readFileSync(proof.path, 'utf8'));
  await page.screenshot({ path: screenshot('verified-proof'), fullPage: false });
  return {
    revision: view.flow.revision,
    workAttemptId: attempt.id,
    workEvidence: workArtifacts.length,
    shownProof: { originalPath: proof.path, sha256: proof.sha256, bytes: proof.bytes },
    retainedFiles: view.evidenceStatus.retainedFiles,
    retainedGaps: view.evidenceStatus.gaps.length,
  };
}

async function main() {
  mkdirSync(output, { recursive: true });
  const original = originalIssue();
  const before = sourceFingerprint(original);
  const project = disposableProject();
  const calls = { model: [], observations: 0, requests: [], pageErrors: [] };
  const result = { issueId, number: 193, sourceBefore: before, passed: false };
  const service = new FactoryUI(project);
  let server, browser;
  try {
    service.codex.ready = async () => {
      calls.model.push('ready');
      throw Error('Issue 193 browser verification must never start a model.');
    };
    service.codex.call = async (method) => {
      calls.model.push(method);
      throw Error('Unexpected model request.');
    };
    const { stores, manifest } = await importExactIssue(service, original);
    service.flows = createIssueFlows(service, { observer: observer(original, calls) });
    const fixtureBefore = checkoutFingerprint(project);
    server = createFactoryServer(service);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const require = createRequire(import.meta.url);
    const { chromium } = createRequire(require.resolve('@playwright/cli/package.json'))('playwright');
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:' + server.address().port,
      viewport: { width: 1440, height: 960 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', (error) => calls.pageErrors.push(error.message));
    page.on('request', (request) =>
      calls.requests.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
        ...(request.method() === 'POST' && { action: request.postDataJSON()?.action }),
      })
    );
    const screenshots = [];
    const screenshot = (name) => {
      const path = join(output, name + '.png');
      screenshots.push(path);
      return path;
    };
    Object.assign(result, await inspectThroughBrowser(page, original, manifest, screenshot), { screenshots });
    assert.equal(calls.model.length, 0);
    assert.ok(
      calls.requests.every(
        (request) =>
          request.method === 'GET' ||
          (request.path === '/api/flow-action' && ['open-block', 'destination-branches'].includes(request.action))
      )
    );
    assert.deepEqual(calls.pageErrors, []);
    assert.equal(service.flows.active.size, 0);
    assert.deepEqual((await stores.readIssue(issueId)).flow, original.flow);
    assert.deepEqual(checkoutFingerprint(project), fixtureBefore);
    assert.deepEqual(sourceFingerprint(original), before);
    result.passed = true;
  } catch (error) {
    result.error = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    await browser?.close();
    if (server) await new Promise((resolveClose) => server.close(resolveClose));
    service.close();
    await closeProjectStores(service);
    result.sourceAfter = sourceFingerprint(original);
    result.calls = calls;
    writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    rmSync(project, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      passed: result.passed,
      number: 193,
      revision: result.revision,
      retainedFiles: result.retainedFiles,
      retainedGaps: result.retainedGaps,
      evidence: join(output, 'result.json'),
    })
  );
}

await main();
