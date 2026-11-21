import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { createFlowExecutor } from './factory-ui/flow-executor.mjs';
import { InvestigationReports } from './factory-ui/investigation-reports.mjs';

function fixture(t, behavior) {
  const { root, git } = gitFixture(t, 'investigation-output-executor-');
  writeFileSync(join(root, '.gitignore'), '.issues/\n');
  writeFileSync(join(root, 'source.txt'), 'Committed inquiry source.\n');
  git('add', '.');
  git('commit', '-qm', 'Committed fixture');
  const revision = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'source.txt'), 'Unsaved project edits.\n');
  const calls = [];
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    issueCleanupTasks: new Map(),
    store: { runs: [], connected: new Set(), event() {} },
    ownServer() {},
    issueChats: { active: new Map(), tasks: new Map(), scheduler: { view: () => ({ entries: [] }) }, release() {} },
  };
  service.flows = { service, active: new Map(), issues: () => [] };
  const issue = {
    id: 'investigation-fixture',
    title: 'Inspect event storage',
    request_type: 'investigation',
    content: 'Inspect the source.',
  };
  const flow = {
    issueId: issue.id,
    routeType: 'investigation',
    startingPoint: { commit: revision, name: 'main', ref: 'refs/heads/main' },
    target: { branch: 'main', remote: 'origin' },
    blocks: [],
    executionSettings: { values: { model: 'fixture-model', effort: 'high' } },
  };
  const source = {
    issueId: issue.id,
    blockId: 'inquiry',
    attemptId: 'inquiry-attempt',
    startedAt: '2026-11-21T10:00:00.000Z',
    revision,
    findings: 'The storage parser drops the final event.',
    evidence: [],
  };
  const definition = {
    usable: true,
    prompt: 'Save the requested output.',
    artifacts: [
      { key: 'response', kind: 'file', label: 'Response' },
      { key: 'report', kind: 'file', label: 'Report' },
      { key: 'reportTitle', kind: 'value', label: 'Title' },
    ],
  };
  const connection = {
    async ready() {},
    async call(method) {
      if (method === 'skills/list') return { data: [] };
      if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
      throw Error('Unexpected fixture method ' + method);
    },
    async start(cwd, sandbox, retain, _issueId, _settingsRoot, instructions, dynamicTools) {
      calls.push({ cwd, sandbox, instructions, dynamicTools });
      retain({ status: 'ready', threadId: 'output-thread' });
      return 'output-thread';
    },
    async turn(threadId, cwd, prompt, _schema, _skills, _settings, receipt) {
      receipt.accepted({ threadId, turnId: 'output-turn' });
      return behavior({ cwd, prompt, connection, revision });
    },
    close() {},
  };
  const executor = createFlowExecutor(service, { createConnection: () => connection });
  t.after(() => executor.close());
  const reports = new InvestigationReports(root);
  const run = (id, publicationId = id) => {
    const attempt = { id, details: [], publicationId, investigationSource: source };
    const block = {
      id: 'report-block',
      kind: 'generate-report',
      skill: null,
      skillExplicit: true,
      prompt: '',
      iterations: 1,
      edits: [],
      comments: [],
      attempts: [attempt],
    };
    return executor.run({
      issue,
      flow,
      block,
      attempt,
      definition,
      signal: new AbortController().signal,
      input: {},
      onProgress() {},
    });
  };
  return { root, git, revision, source, reports, calls, run };
}

const manifest = (value) => 'Saved investigation output.\n\n```flow-result\n' + JSON.stringify(value) + '\n```';

function saveReport(cwd) {
  mkdirSync(join(cwd, 'outputs'), { recursive: true });
  writeFileSync(join(cwd, 'outputs/report.md'), '# Executive summary\n\nThe final event is lost.\n');
  writeFileSync(join(cwd, 'outputs/evidence.txt'), 'Observed two events when three were expected.');
}

test('real output execution attaches guarded tools and retains skill-saved report and evidence before snapshot deletion', async (t) => {
  let snapshot;
  const f = fixture(t, async ({ cwd, connection, revision }) => {
    snapshot = cwd;
    assert.equal(readFileSync(join(cwd, 'source.txt'), 'utf8'), 'Committed inquiry source.\n');
    saveReport(cwd);
    const saved = await connection.blockTools.invoke('report_publish', {
      title: 'Event storage report',
      report: 'outputs/report.md',
      evidence: ['outputs/evidence.txt'],
      additionalFindings: 'The newer revision still loses the final event.',
      inspectedRevisions: [revision],
    });
    assert.equal(saved.source.attemptId, 'inquiry-attempt');
    return manifest({ files: { report: 'outputs/report.md' }, values: { reportTitle: 'Event storage report' } });
  });
  const result = await f.run('report-attempt');
  assert.equal(f.calls[0].sandbox, 'workspace-write');
  assert.ok(f.calls[0].dynamicTools.some(({ name }) => name === 'report_publish'));
  assert.equal(
    f.calls[0].dynamicTools.some(({ name }) => name === 'investigation_issues_save'),
    false
  );
  assert.equal(existsSync(snapshot), false);
  assert.equal(f.reports.list().length, 1);
  const report = f.reports.read(result.artifacts.values.reportId);
  assert.equal(report.source.revision, f.revision);
  assert.equal(report.attemptId, 'report-attempt');
  assert.deepEqual(result.artifacts.values.reportEvidence, report.evidence);
  assert.equal(report.evidence[0].status, 'verified');
  assert.match(readFileSync(report.evidence[0].path, 'utf8'), /three were expected/);
  assert.match(report.content, /final event is lost/);
  assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'Unsaved project edits.\n');
  assert.equal(f.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
});

test('a blocked report attempt retains its response without automatically publishing its saved file', async (t) => {
  let snapshot;
  const f = fixture(t, ({ cwd }) => {
    snapshot = cwd;
    saveReport(cwd);
    return manifest({
      files: { report: 'outputs/report.md' },
      failure: 'Evidence needs human review.',
      blocker: 'human-input',
    });
  });
  const result = await f.run('blocked-attempt');
  assert.equal(result.status, 'blocked');
  assert.deepEqual(f.reports.list(), []);
  assert.equal(existsSync(snapshot), false);
  assert.match(readFileSync(result.artifacts.files.report.path, 'utf8'), /final event is lost/);
});

test('output Retry recovers a publication after its original disposable file has disappeared', async (t) => {
  let generation = 0;
  const f = fixture(t, ({ cwd }) => {
    generation++;
    if (generation === 1) {
      saveReport(cwd);
      return manifest({ files: { report: 'outputs/report.md' }, values: { reportTitle: 'A saved report' } });
    }
    return manifest({ values: { reportTitle: 'Retry after publication' } });
  });
  const initial = await f.run('first-attempt', 'original-publication');
  const retried = await f.run('retry-attempt', 'original-publication');
  assert.equal(initial.artifacts.values.reportId, retried.artifacts.values.reportId);
  assert.equal(f.reports.list().length, 1);
  assert.equal(f.reports.list()[0].attemptId, 'first-attempt');
});

test('snapshot output tools cannot publish or retain files from the original uncommitted project', async (t) => {
  const f = fixture(t, async ({ cwd, connection }) => {
    const original = join(f.root, 'source.txt');
    assert.throws(
      () =>
        connection.blockTools.invoke('report_publish', {
          title: 'Rejected original source',
          report: original,
        }),
      /belong to/
    );
    saveReport(cwd);
    const published = await connection.blockTools.invoke('report_publish', {
      title: 'Snapshot report',
      report: 'outputs/report.md',
      evidence: [original],
    });
    assert.equal(published.evidence[0].status, 'unavailable');
    assert.equal(published.evidence[0].path, undefined);
    assert.doesNotMatch(JSON.stringify(published), /Unsaved project edits/);
    return manifest({ values: { reportTitle: 'Snapshot report' } });
  });
  const result = await f.run('contained-output');
  const retained = f.reports.read(result.artifacts.values.reportId);
  assert.equal(retained.evidence[0].status, 'unavailable');
  assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'Unsaved project edits.\n');
});

test('an output inspects newer committed code while retaining the exact original inquiry provenance', async (t) => {
  let newer;
  const f = fixture(t, async ({ cwd, connection }) => {
    assert.equal(readFileSync(join(cwd, 'source.txt'), 'utf8'), 'Newer committed source.\n');
    saveReport(cwd);
    await connection.blockTools.invoke('report_publish', {
      title: 'New revision report',
      report: 'outputs/report.md',
      inspectedRevisions: [newer],
    });
    return manifest({ values: { reportTitle: 'New revision report' } });
  });
  writeFileSync(join(f.root, 'source.txt'), 'Newer committed source.\n');
  f.git('add', 'source.txt');
  f.git('commit', '-qm', 'Newer output inspection revision');
  newer = f.git('rev-parse', 'HEAD');
  writeFileSync(join(f.root, 'source.txt'), 'Uncommitted current edit.\n');
  const result = await f.run('newer-output-attempt');
  const report = f.reports.read(result.artifacts.values.reportId);
  assert.equal(report.source.revision, f.revision);
  assert.equal(report.source.attemptId, 'inquiry-attempt');
  assert.deepEqual(report.inspectedRevisions, [newer]);
  assert.equal(result.result.head, newer);
  assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'Uncommitted current edit.\n');
});
