import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gitFixture } from './git-fixture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { makeBlock } from './factory-ui/flow-store.mjs';
import { ProjectInvestigations } from './factory-ui/project-investigations.mjs';
import { ProjectHome } from './factory-ui/project-home.mjs';
import { projectHomeStats } from './factory-ui/project-home-stats.mjs';
import { digest } from './factory-ui/common.mjs';
import { conversationMessages } from './factory-ui/conversation-store.mjs';
import { moveIssueStorage } from './factory-ui/issue-storage-actions.mjs';
import { createIssueFolderSettings } from './factory-ui/issue-folder-settings.mjs';

function legacyFixture(t, options = {}) {
  const { root, git } = gitFixture(t, 'project-home-');
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, '.fixture-codex');
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, 'source.txt'), 'project source');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  git('branch', 'dev');
  git('branch', 'investigation-target');
  const originalBranch = git('branch', '--show-current');
  git('checkout', '-q', 'investigation-target');
  writeFileSync(join(root, 'source.txt'), 'selected branch source');
  git('add', 'source.txt');
  git('commit', '-qm', 'selected investigation source');
  git('checkout', '-q', originalBranch);
  const calls = [];
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    store: { runs: [], connected: new Set() },
    issueChats: { active: new Map(), tasks: new Map(), release() {} },
    issueCleanupTasks: new Map(),
    ownServer() {},
  };
  const flows = createIssueFlows(service, {
    observer: { observe: async () => ({}) },
    executor: {
      async run(ctx) {
        calls.push(ctx);
        if (options.execute) return options.execute(ctx);
        const body =
          'Observed source.txt:1. Concrete finding: missing validation. Improve validation and verify with a rejected invalid input.';
        const path = join(root, '.issues/factory-ui/flow-evidence', ctx.attempt.id, 'output.txt');
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, body);
        const evidence = { path, sha256: digest(body), label: 'Block response' };
        return {
          output: body,
          summary: 'Found a concrete improvement.',
          evidence: [evidence],
          artifacts: { values: {}, files: { response: evidence } },
        };
      },
      close() {},
    },
  });
  const proposal = {
    title: 'Validate project inputs',
    type: 'bug',
    description: 'Reject invalid project inputs.',
    reason: 'Observed source.txt:1 accepts invalid inputs.',
    verification: 'An invalid input produces a useful rejection.',
  };
  const capture = flows.capture.bind(flows);
  flows.capture = async (input) => {
    const result = await capture(input);
    if (input.type === 'investigation' && result.issue) {
      const flow = flows.read(flows.selected(result.issue.id));
      if (!flow.blocks.slice(1).some(({ attempts }) => attempts.length)) {
        const inquiry = makeBlock('understand', [flow.blocks[0].id], false, flows.catalog.read().entries);
        inquiry.id = inquiry.flowKey = 'work';
        flow.blocks = [flow.blocks[0], inquiry];
        flow.definition = { ...flow.definition, id: 'legacy-investigation-fixture' };
        delete flow.investigationLayout;
        flows.store.save(flow, flow.revision);
      }
    }
    return result;
  };
  service.flows = flows;
  let investigations = new ProjectInvestigations(service, flows, {
    propose: options.propose || (async () => [proposal]),
  });
  t.after(() => {
    investigations.close();
    flows.close();
  });
  return {
    root,
    git,
    flows,
    calls,
    service,
    async start(input) {
      const created = await investigations.action({ ...input, action: 'investigation-create', reusable: true });
      return investigations.action({ ...input, issueId: created.issueId });
    },
    get investigations() {
      return investigations;
    },
    restart() {
      investigations.close();
      investigations = new ProjectInvestigations(service, flows, {
        propose: options.propose || (async () => [proposal]),
      });
    },
  };
}
async function settled(f, id) {
  await f.investigations.active.get(id)?.task;
  return f.investigations.selected(id);
}
const start = (action = 'investigation-run') => ({
  action,
  requestId: randomUUID(),
  branch: 'refs/heads/investigation-target',
  focus: 'Code quality',
});

test('legacy compatibility, project investigations create one issue, honor selected branch, retain findings, and automatically file approval-needed follow-ups', async (t) => {
  const f = legacyFixture(t);
  assert.equal(f.investigations.view().length, 0);
  const input = start();
  const first = await f.start(input);
  assert.equal(first.session.status, 'running');
  const session = await settled(f, first.session.id);
  assert.equal(session.status, 'completed', session.error);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].flow.startingPoint.ref, input.branch);
  assert.equal(f.calls[0].flow.startingPoint.commit, f.git('rev-parse', input.branch));
  assert.match(f.calls[0].block.prompt, /Run the agreed whole-project investigation/);
  assert.equal(f.flows.read(f.flows.selected(session.issueId)).workspace, null);
  assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'project source');
  assert.ok(conversationMessages(f.root, session.issueId).some(({ kind }) => kind === 'project-investigation'));
  const [followup] = f.flows.issues().filter(({ id }) => id !== session.issueId);
  assert.equal(followup.state, 'needs-approval');
  assert.equal(followup.source_issue, session.issueId);
  assert.equal(followup.source_attempt, session.attemptId);
  assert.match(followup.content, /SHA-256/);
  const duplicate = await f.start(input);
  assert.equal(duplicate.session.id, session.id);
  assert.equal(f.calls.length, 1);
  f.restart();
  assert.equal(f.investigations.view()[0].status, 'completed');
  assert.equal(f.calls.length, 1);
});

test('legacy compatibility, discussion saves the investigation but creates no follow-up until explicit Run', async (t) => {
  const f = legacyFixture(t);
  const discussed = await f.start({
    ...start('investigation-discuss'),
    message: 'What should we investigate first?',
  });
  const draft = await settled(f, discussed.session.id);
  assert.equal(draft.status, 'draft', draft.error);
  assert.equal(f.flows.issues().length, 1);
  assert.match(f.calls[0].block.prompt, /preliminary investigation conversation/);
  const run = await f.investigations.action({
    action: 'investigation-run',
    id: draft.id,
    requestId: randomUUID(),
    branch: 'refs/heads/dev',
    prompt: 'Investigate validation and include our agreed goals.',
  });
  const result = await settled(f, run.session.id);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].flow.startingPoint.ref, 'refs/heads/dev');
  assert.match(f.calls[1].block.prompt, /What should we investigate first/);
  assert.equal(f.flows.issues().length, 2);
});

test('legacy compatibility, partial follow-up creation retries only uncreated proposals, without rerunning the investigation', async (t) => {
  const f = legacyFixture(t);
  const capture = f.flows.capture.bind(f.flows);
  let fail = true;
  f.flows.capture = async (input) => {
    if (input.needsApproval && fail) throw Error('Synthetic publication failure');
    return capture(input);
  };
  const started = await f.start(start());
  const failed = await settled(f, started.session.id);
  assert.equal(failed.status, 'failed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.flows.issues().length, 1);
  fail = false;
  const retry = await f.investigations.action({ action: 'investigation-retry', id: failed.id });
  const finished = await settled(f, retry.session.id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(f.calls.length, 1);
  assert.equal(f.flows.issues().length, 2);
});

test('legacy compatibility, Stop preserves the issue and partial attempt and creates no follow-ups', async (t) => {
  const f = legacyFixture(t, {
    execute: (ctx) =>
      new Promise((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(Error('Stopped fixture')), { once: true });
      }),
  });
  const started = await f.start(start());
  for (let count = 0; count < 100 && !f.calls.length; count++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.calls.length, 1);
  await f.investigations.action({ action: 'investigation-stop', id: started.session.id });
  const stopped = await settled(f, started.session.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(f.flows.issues().length, 1);
  const flow = f.flows.read(f.flows.selected(stopped.issueId));
  assert.equal(flow.blocks.find(({ kind }) => kind === 'understand').attempts.at(-1).status, 'stopped');
});

test('legacy compatibility, whole-project defaults use project settings and archived existing issues are supplied to proposals', async (t) => {
  let existing;
  const f = legacyFixture(t, {
    propose: async (context) => {
      existing = context.existingIssues;
      return [];
    },
  });
  writeFileSync(
    join(f.root, 'folder.md'),
    '---\nbranch: investigation-target\nmodel: gpt-6.1-sol\neffort: high\n---\n'
  );
  mkdirSync(join(f.root, '.issues/archive'), { recursive: true });
  writeFileSync(
    join(f.root, '.issues/archive/20261118-existing.md'),
    '---\ntitle: Existing archived work\nstate: closed\ncreated: 2026-11-18T00:00:00Z\n---\n'
  );
  const input = start();
  delete input.branch;
  const started = await f.start(input);
  const result = await settled(f, started.session.id);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.branch, 'refs/heads/investigation-target');
  assert.equal(f.calls[0].flow.executionSettings.values.model, 'gpt-6.1-sol');
  assert.equal(f.calls[0].flow.executionSettings.values.effort, 'high');
  assert.ok(existing.some(({ title }) => title === 'Existing archived work'));
  assert.equal(result.followups.length, 0);
});

test('legacy compatibility, statistics include archived creations and unique historical closures even after reopen', (t) => {
  const { root } = gitFixture(t, 'project-home-stats-');
  mkdirSync(join(root, '.issues/archive'), { recursive: true });
  writeFileSync(
    join(root, '.issues/20261117-reopened.md'),
    '---\ntitle: Reopened\ncreated: 2026-11-17T00:00:00Z\nstate: backlog\nclosure_history:\n  - at: 2026-11-16T00:00:00Z\n  - at: 2026-11-17T00:00:00Z\n---\n'
  );
  writeFileSync(
    join(root, '.issues/archive/20261115-archived.md'),
    '---\ntitle: Archived\ncreated: 2026-11-15T00:00:00Z\nstate: closed\nclosure:\n  at: 2026-11-15T00:00:00Z\n---\n'
  );
  writeFileSync(
    join(root, '.issues/20261001-old.md'),
    '---\ntitle: Old\ncreated: 2026-10-01T00:00:00Z\nstate: backlog\n---\n'
  );
  const stats = projectHomeStats(root, '2026-11-18T12:00:00Z', '2026-11-01T00:00:00Z');
  assert.equal(stats.created, 2);
  assert.equal(stats.closed, 2);
  assert.equal(stats.total, 3);
  assert.equal(stats.incompleteHistory, false);
  assert.equal(projectHomeStats(root, '2026-11-18T12:00:00Z').incompleteHistory, true);
});

test('legacy compatibility, concurrent replay of one explicit run cannot launch duplicate blocks', async (t) => {
  const f = legacyFixture(t);
  const input = start();
  const results = await Promise.all([f.start(input), f.start(input)]);
  assert.equal(results[0].session.id, results[1].session.id);
  const done = await settled(f, results[0].session.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(f.calls.length, 1);
  assert.equal(f.flows.issues().length, 2);
});

test('legacy compatibility, changing investigation branches preserves a legacy workspace and its human edits', async (t) => {
  const f = legacyFixture(t);
  const created = await f.investigations.action({ ...start(), action: 'investigation-create' });
  const flow = f.flows.read(f.flows.selected(created.issueId));
  const checkout = join(f.root, '.issues/legacy-investigation');
  mkdirSync(checkout);
  writeFileSync(join(checkout, 'source.txt'), 'unsaved human edit');
  flow.workspace = { checkout, branch: 'legacy', base: f.git('rev-parse', 'HEAD') };
  f.flows.store.save(flow, flow.revision);
  const run = await f.investigations.action({ ...start(), issueId: created.issueId, branch: 'refs/heads/dev' });
  const done = await settled(f, run.session.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(readFileSync(join(checkout, 'source.txt'), 'utf8'), 'unsaved human edit');
  assert.equal(f.flows.read(f.flows.selected(created.issueId)).workspace, null);
});

test('legacy compatibility, invalid branches and empty discussions create no issue and no model work', async (t) => {
  const f = legacyFixture(t);
  await assert.rejects(
    f.start({ ...start(), branch: 'refs/heads/missing' }),
    /selected starting branch is unavailable/
  );
  await assert.rejects(
    f.investigations.action({ ...start('investigation-discuss'), message: '' }),
    /Create the investigation first/
  );
  assert.equal(f.flows.issues().length, 0);
  assert.equal(f.calls.length, 0);
});

test('legacy compatibility, Stop during follow-up capture finishes that capture but starts no later issue', async (t) => {
  const proposal = (title) => ({
    title,
    type: 'bug',
    description: title,
    reason: 'Observed source.txt:1.',
    verification: 'A focused behavioral check.',
  });
  const f = legacyFixture(t, { propose: async () => [proposal('First finding'), proposal('Second finding')] });
  const capture = f.flows.capture.bind(f.flows);
  let release;
  let captured = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.flows.capture = async (input) => {
    const result = await capture(input);
    if (input.needsApproval) {
      captured = true;
      await gate;
    }
    return result;
  };
  const started = await f.start(start());
  for (let count = 0; count < 200 && !captured; count++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(captured, true);
  await f.investigations.action({ action: 'investigation-stop', id: started.session.id });
  release();
  const stopped = await settled(f, started.session.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(f.flows.issues().filter(({ state }) => state === 'needs-approval').length, 1);
});

test('legacy compatibility, Retry reconciles an uncertain original Understand attempt instead of starting an unrelated operation', async (t) => {
  let round = 0;
  const f = legacyFixture(t, {
    execute: async (ctx) => {
      if (round++ === 0) throw Object.assign(Error('Synthetic provider disconnect'), { uncertain: true });
      assert.equal(ctx.continuing, true);
      await ctx.onReconciled();
      const body = 'No actionable changes found. Evidence: source.txt:1.';
      const path = join(f.root, '.issues/factory-ui/flow-evidence', ctx.attempt.id, 'output.txt');
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, body);
      const proof = { path, label: 'Block response', sha256: digest(body) };
      return { output: body, evidence: [proof], artifacts: { values: {}, files: { response: proof } } };
    },
    propose: async () => [],
  });
  const started = await f.start(start());
  const failed = await settled(f, started.session.id);
  assert.equal(failed.status, 'failed');
  f.restart();
  assert.equal(round, 1);
  const retry = await f.investigations.action({ action: 'investigation-retry', id: failed.id });
  const finished = await settled(f, retry.session.id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(round, 2);
  const attempts = f.flows
    .read(f.flows.selected(finished.issueId))
    .blocks.find(({ id }) => id === finished.blockId).attempts;
  assert.ok(attempts[0].reconciledAt);
});

test('legacy compatibility, failed automatic capture cannot silently switch to a newer Understand result on Retry', async (t) => {
  const f = legacyFixture(t);
  const capture = f.flows.capture.bind(f.flows);
  let fail = true;
  f.flows.capture = async (input) => {
    if (input.needsApproval && fail) throw Error('Synthetic capture failure');
    return capture(input);
  };
  const started = await f.start(start());
  const failed = await settled(f, started.session.id);
  assert.equal(failed.status, 'failed');
  const originalAttemptId = failed.attemptId;
  const originalResult = failed.result;
  let flow = f.flows.read(f.flows.selected(failed.issueId));
  const block = flow.blocks.find(({ id }) => id === failed.blockId);
  block.attempts.push({ ...block.attempts.at(-1), id: randomUUID(), output: 'A changed investigation result' });
  f.flows.store.save(flow, flow.revision);
  fail = false;
  const retry = await f.investigations.action({ action: 'investigation-retry', id: failed.id });
  const stale = await settled(f, retry.session.id);
  assert.equal(stale.status, 'failed');
  assert.match(stale.error, /findings changed.*Run the investigation again/);
  assert.equal(stale.attemptId, originalAttemptId);
  assert.equal(stale.result, originalResult);
  assert.equal(f.flows.issues().length, 1);
  assert.equal(f.calls.length, 1);
});

test('legacy compatibility, preview reads saved running investigations without creating files, reconciling, or claiming the live server', async (t) => {
  const { root, git } = gitFixture(t, 'project-home-preview-');
  writeFileSync(join(root, 'source.txt'), 'fixture');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  git('branch', 'dev');
  const service = {
    root,
    ownServer() {
      throw Error('The live server owns this project.');
    },
  };
  const emptyPreview = new ProjectHome(service, null, { readOnly: true });
  t.after(() => emptyPreview.close());
  assert.equal((await emptyPreview.view()).investigations.length, 0);
  assert.equal(existsSync(join(root, '.issues')), false);
  await assert.rejects(emptyPreview.action(start()), /preview is read-only/);
  const id = randomUUID();
  const directory = join(root, '.issues/factory-ui/project-home/investigations');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, id + '.json');
  const content = JSON.stringify({ id, status: 'running', messages: [], createdAt: '2026-11-18T00:00:00Z' });
  writeFileSync(path, content);
  const preview = new ProjectHome(service, null, { readOnly: true });
  t.after(() => preview.close());
  const view = await preview.view();
  assert.equal(view.investigations[0].status, 'running');
  assert.equal(readFileSync(path, 'utf8'), content);
  assert.equal(existsSync(join(root, '.issues/factory-ui/project-home/history.json')), false);
});

test('legacy compatibility, project branch selection is independent of the issue filing folder branch override', async (t) => {
  const f = legacyFixture(t, { propose: async () => [] });
  const inbox = join(f.root, 'user/Inbox/folder.md');
  const content = readFileSync(inbox, 'utf8');
  writeFileSync(inbox, content.replace(/branch: .*/, 'branch: unavailable-folder-branch'));
  const started = await f.start(start());
  const finished = await settled(f, started.session.id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(f.calls[0].flow.startingPoint.ref, 'refs/heads/investigation-target');
  await assert.rejects(
    f.flows.capture({
      requestId: randomUUID(),
      type: 'investigation',
      description: 'Ordinary issue still uses its folder branch.',
    }),
    /starting target branch is unavailable/
  );
});

test('legacy compatibility, creation is idle, non-reusable completion cannot rerun, and Reusable enables another saved run', async (t) => {
  const f = legacyFixture(t);
  const created = await f.investigations.action({ ...start(), action: 'investigation-create' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.investigations.issueView(created.issueId).runs.length, 0);
  assert.ok(!f.flows.read(f.flows.selected(created.issueId)).blocks.some(({ kind }) => kind === 'close'));
  const submission = { ...start(), issueId: created.issueId };
  const first = await f.investigations.action(submission);
  const done = await settled(f, first.session.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal((await f.investigations.action(submission)).session.id, first.session.id);
  await assert.rejects(f.investigations.action({ ...start(), issueId: created.issueId }), /Enable Reusable/);
  const before = f.investigations.issueView(created.issueId);
  await f.investigations.action({
    ...start(),
    action: 'investigation-save',
    issueId: created.issueId,
    revision: before.revision,
    reusable: true,
  });
  const second = await f.investigations.action({ ...start(), issueId: created.issueId });
  const repeat = await settled(f, second.session.id);
  assert.equal(repeat.status, 'completed', repeat.error);
  const history = f.investigations.issueView(created.issueId);
  assert.equal(history.runs.length, 2);
  assert.equal(history.runs[0].issues[0].relation, 'tracked');
  assert.equal(history.runs[1].issues[0].relation, 'created');
  assert.equal(f.flows.issues().length, 2);
  assert.ok(history.runs.every(({ settings, revision }) => settings && revision));
});

test('legacy compatibility, archive preserves open investigation state and history; restore preserves Reusable and child issues', async (t) => {
  const f = legacyFixture(t);
  const started = await f.start(start());
  const done = await settled(f, started.session.id);
  const before = f.flows.selected(done.issueId);
  assert.equal(
    (await moveIssueStorage(f.service, { action: 'archive', issueIds: [done.issueId] })).results[0].status,
    'archived'
  );
  const archived = f.flows.selected(done.issueId);
  assert.equal(archived.state, before.state);
  assert.equal(archived.closure, undefined);
  assert.equal(archived.location, 'archive');
  assert.equal(f.investigations.issueView(done.issueId).runs.length, 1);
  await assert.rejects(f.investigations.action({ ...start(), issueId: done.issueId }), /Restore or approve/);
  assert.equal(
    (await moveIssueStorage(f.service, { action: 'restore', issueIds: [done.issueId] })).results[0].status,
    'restored'
  );
  assert.equal(f.flows.selected(done.issueId).location, 'open');
  assert.equal(f.flows.selected(done.issueId).reusable, true);
  assert.equal(f.flows.issues().find(({ source_issue }) => source_issue === done.issueId).state, 'needs-approval');
});

test('legacy compatibility, follow-up destination is per run and independent of the investigation filing folder', async (t) => {
  let n = 0;
  const f = legacyFixture(t, {
    propose: async () => [
      {
        title: 'Finding ' + ++n,
        type: 'bug',
        description: 'Fix the observed behavior.',
        reason: 'Observed source.txt:1',
        verification: 'Verify behavior.',
      },
    ],
  });
  createIssueFolderSettings(f.root, 'Saved');
  createIssueFolderSettings(f.root, 'Findings');
  const created = await f.investigations.action({
    ...start(),
    action: 'investigation-create',
    issueFolder: 'Saved',
    reusable: true,
  });
  for (const folder of ['Findings', undefined]) {
    const started = await f.investigations.action({ ...start(), issueId: created.issueId, folder });
    const done = await settled(f, started.session.id);
    assert.equal(done.status, 'completed', done.error);
  }
  assert.equal(f.flows.read(f.flows.selected(created.issueId)).folder, 'Saved');
  const children = f.flows.issues().filter(({ source_issue }) => source_issue === created.issueId);
  assert.equal(f.flows.read(children.find(({ title }) => title === 'Finding 1')).folder, 'Findings');
  assert.equal(f.flows.read(children.find(({ title }) => title === 'Finding 2')).folder, 'Inbox');
});

test('legacy compatibility, each new run resolves current defaults and branch tip while preserving earlier run settings and explicit overrides', async (t) => {
  const f = legacyFixture(t, { propose: async () => [] });
  const created = await f.investigations.action({ ...start(), action: 'investigation-create', reusable: true });
  const first = await f.investigations.action({ ...start(), issueId: created.issueId });
  const original = await settled(f, first.session.id);
  const firstRevision = original.startingPoint.commit;
  const firstSettings = structuredClone(original.settings);
  writeFileSync(join(f.root, 'folder.md'), '---\nbranch: dev\nmodel: gpt-6.1-sol\neffort: high\n---\n');
  const branch = f.git('branch', '--show-current');
  f.git('checkout', '-q', 'investigation-target');
  writeFileSync(join(f.root, 'source.txt'), 'new committed source');
  f.git('add', 'source.txt');
  f.git('commit', '-qm', 'New investigation revision');
  f.git('checkout', '-q', branch);
  const second = await f.investigations.action({ ...start(), issueId: created.issueId });
  const latest = await settled(f, second.session.id);
  assert.equal(latest.status, 'completed', latest.error);
  assert.notEqual(latest.startingPoint.commit, firstRevision);
  assert.equal(latest.settings.effort, 'high');
  let view = await f.flows.view(created.issueId);
  assert.equal(view.issueSettings.frozen, false);
  await f.flows.action({
    action: 'issue-settings',
    issueId: created.issueId,
    revision: view.flow.revision,
    changes: { effort: 'low' },
  });
  const third = await f.investigations.action({ ...start(), issueId: created.issueId });
  const override = await settled(f, third.session.id);
  assert.equal(override.status, 'completed', override.error);
  assert.equal(override.settings.effort, 'low');
  const saved = f.investigations.issueView(created.issueId).runs.find(({ id }) => id === original.attemptId);
  assert.deepEqual(saved.settings, firstSettings);
  assert.equal(saved.revision, firstRevision);
});
