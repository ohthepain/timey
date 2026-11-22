import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { compileFunction } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { newFlow } from './factory-ui/flow-store.mjs';
import { flowTarget } from './factory-ui/flow-observer.mjs';
import { reconcileInvestigationFindings } from './factory-ui/investigation-execution.mjs';
import { requireThat } from './factory-ui/common.mjs';
import { mergedDelivery } from './factory-ui/merged-issue.mjs';
import { resolveFolderSettings } from './factory-ui/issue-folder-settings.mjs';
import { deliveryTarget } from './factory-ui/flow-block-data.mjs';

const baselineRevision = '51bb2411c72551147a8e4160d005a13b6f1e7c58';
const issueCount = 27;
const chunk = 'saved worker output\n';
const chunkCount = 12;

function baselineMethods() {
  const source = execFileSync('git', ['show', baselineRevision + ':scripts/factory-ui/flow-service.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  const dependencies = {
    flowTarget,
    reconcileInvestigationFindings,
    requireThat,
    mergedDelivery,
    resolveFolderSettings,
    deliveryTarget,
  };
  const methods = {};
  for (const [name, next] of [
    ['changeAttempt', 'async execute'],
    ['groupEligible', 'folderSettingsView'],
  ]) {
    const start = source.indexOf('\n  ' + name + '(');
    const end = source.indexOf('\n  ' + next + '(', start);
    assert.ok(start >= 0 && end > start, 'Recorded baseline method delimiters must exist.');
    const factory = compileFunction('return ({' + source.slice(start, end) + '});', Object.keys(dependencies));
    methods[name] = factory(...Object.values(dependencies))[name];
  }
  return methods;
}

function populate(flows, root) {
  const records = [];
  for (let index = 0; index < issueCount; index++) {
    const issue = { id: '20261122-issue-' + index, title: 'Fixture issue ' + index, content: '' };
    writeFileSync(
      join(root, '.issues', issue.id + '.md'),
      `---\nid: ${issue.id}\ntitle: ${issue.title}\nstate: backlog\ncreated: 2026-11-22T00:00:00Z\n---\n`
    );
    const flow = newFlow(issue, flowTarget(root));
    const block = flow.blocks.find(({ kind }) => kind === 'work');
    if (index < 2) {
      block.attempts.push({ id: issue.id + '-attempt', status: 'running', output: '' });
      records.push({ issue, blockId: block.id, attemptId: block.attempts[0].id });
    }
    flows.store.save(flow, flow.revision);
  }
  return records;
}

function flowServer(flows, errors) {
  return createServer(async (_request, response) => {
    try {
      const view = await flows.view();
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(view));
    } catch (error) {
      errors.push(error.message);
      response.writeHead(500).end('failed');
    }
  });
}

async function requestIndex(url) {
  const start = performance.now();
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).issues.length, issueCount);
  return performance.now() - start;
}

async function streamProgress(flows, records) {
  let callbackMs = 0;
  for (let index = 0; index < chunkCount; index++) {
    await new Promise((resolve) => setImmediate(resolve));
    for (const { issue, blockId, attemptId } of records) {
      const started = performance.now();
      flows.changeAttempt(issue, blockId, attemptId, (attempt) => {
        attempt.output += chunk;
      });
      callbackMs += performance.now() - started;
    }
  }
  return callbackMs;
}

function persistedBytes(flows, records) {
  return records.reduce((bytes, { issue, blockId }) => {
    const flow = JSON.parse(readFileSync(flows.store.path(issue.id), 'utf8'));
    const output = flow.blocks.find(({ id }) => id === blockId).attempts[0].output;
    assert.equal(output, chunk.repeat(chunkCount));
    return bytes + Buffer.byteLength(output);
  }, 0);
}

async function measure(flows, records, url, side, methods, round) {
  Object.assign(flows, methods);
  for (const { issue, blockId, attemptId } of records)
    flows.changeAttempt(issue, blockId, attemptId, (attempt) => {
      attempt.output = '';
    });
  const start = performance.now();
  const request = requestIndex(url);
  const callbackMs = await streamProgress(flows, records);
  const httpMs = await request;
  return {
    side,
    round,
    callbackMs,
    httpMs,
    totalMs: performance.now() - start,
    callbacks: records.length * chunkCount,
    outputBytes: persistedBytes(flows, records),
  };
}

function summarize(runs) {
  const summary = {};
  for (const side of ['baseline', 'fixed']) {
    summary[side] = {};
    for (const metric of ['callbackMs', 'httpMs']) {
      const values = runs
        .filter((run) => run.side === side)
        .map((run) => run[metric])
        .sort((a, b) => a - b);
      summary[side][metric] = { median: values[2], min: values[0], max: values.at(-1) };
    }
  }
  return summary;
}

const root = mkdtempSync(join(tmpdir(), 'flow-progress-benchmark-'));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
let flows;
let server;
const errors = [];
try {
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('config', 'core.hooksPath', '/dev/null');
  git('commit', '--allow-empty', '-qm', 'fixture');
  git('branch', 'dev');
  mkdirSync(join(root, '.issues'));
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    store: { runs: [], connected: new Set() },
    issueChats: { active: new Map() },
  };
  flows = createIssueFlows(service);
  const current = { changeAttempt: flows.changeAttempt, groupEligible: flows.groupEligible };
  const records = populate(flows, root);
  server = flowServer(flows, errors);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const runs = [];
  const baseline = baselineMethods();
  for (let round = 0; round < 5; round++) {
    for (const [side, methods] of [
      ['baseline', baseline],
      ['fixed', current],
    ])
      runs.push(await measure(flows, records, url, side, methods, round));
  }
  const summary = summarize(runs);
  const artifact = {
    claim: 'Two streaming issues spend less time synchronously saving progress while the Flow index remains available.',
    cores: availableParallelism(),
    load: loadavg(),
    issues: issueCount,
    baselineRevision,
    summary,
    runs,
    errors,
  };
  assert.equal(errors.length, 0);
  const output = process.argv[2] || '/tmp/timey-flow-progress-benchmark.json';
  writeFileSync(output, JSON.stringify(artifact, null, 2) + '\n');
  console.log(JSON.stringify({ artifact: output, summary, errors: errors.length }, null, 2));
} finally {
  flows?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  rmSync(root, { recursive: true, force: true });
}
