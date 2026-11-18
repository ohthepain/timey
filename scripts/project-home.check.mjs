import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gitFixture } from './git-fixture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { ProjectInvestigations } from './factory-ui/project-investigations.mjs';
import { ProjectHome } from './factory-ui/project-home.mjs';
import { projectHomeStats } from './factory-ui/project-home-stats.mjs';
import { digest } from './factory-ui/common.mjs';
import { conversationMessages } from './factory-ui/conversation-store.mjs';

function fixture(t, options = {}) {
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
    issueChats: { active: new Map(), release() {} },
    ownServer() {},
  };
  const flows = createIssueFlows(service, {
    observer: { observe: async () => ({}) },
    executor: {
      async run(ctx) {
        calls.push(ctx);
        const checkout = join(root, '.issues/issue-work', ctx.issue.id);
        const workspace = {
          checkout,
          branch: 'codex/investigation-' + ctx.issue.id,
          base: ctx.flow.startingPoint.commit,
        };
        if (!existsSync(checkout)) {
          mkdirSync(join(checkout, '..'), { recursive: true });
          git('worktree', 'add', '-b', workspace.branch, checkout, workspace.base);
        }
        ctx.onWorkspace(workspace);
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

test('project investigations create one issue, honor selected branch, retain findings, and automatically file approval-needed follow-ups', async (t) => {
  const f = fixture(t);
  assert.equal(f.investigations.view().length, 0);
  const input = start();
  const first = await f.investigations.action(input);
  assert.equal(first.session.status, 'running');
  const session = await settled(f, first.session.id);
  assert.equal(session.status, 'completed', session.error);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].flow.startingPoint.ref, input.branch);
  assert.equal(f.calls[0].flow.startingPoint.commit, f.git('rev-parse', input.branch));
  assert.match(f.calls[0].block.prompt, /Run the agreed whole-project investigation/);
  assert.equal(
    readFileSync(
      join(
        f.calls[0].flow.workspace?.checkout || f.flows.read(f.flows.selected(session.issueId)).workspace.checkout,
        'source.txt'
      ),
      'utf8'
    ),
    'selected branch source'
  );
  assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'project source');
  assert.ok(conversationMessages(f.root, session.issueId).some(({ kind }) => kind === 'project-investigation'));
  const [followup] = f.flows.issues().filter(({ id }) => id !== session.issueId);
  assert.equal(followup.state, 'needs-approval');
  assert.equal(followup.source_issue, session.issueId);
  assert.equal(followup.source_attempt, session.attemptId);
  assert.match(followup.content, /SHA-256/);
  const duplicate = await f.investigations.action(input);
  assert.equal(duplicate.session.id, session.id);
  assert.equal(f.calls.length, 1);
  f.restart();
  assert.equal(f.investigations.view()[0].status, 'completed');
  assert.equal(f.calls.length, 1);
});

test('discussion saves the investigation but creates no follow-up until explicit Run', async (t) => {
  const f = fixture(t);
  const discussed = await f.investigations.action({
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

test('partial follow-up creation retries only uncreated proposals, without rerunning the investigation', async (t) => {
  const f = fixture(t);
  const capture = f.flows.capture.bind(f.flows);
  let fail = true;
  f.flows.capture = async (input) => {
    if (input.needsApproval && fail) throw Error('Synthetic publication failure');
    return capture(input);
  };
  const started = await f.investigations.action(start());
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

test('Stop preserves the issue and partial attempt and creates no follow-ups', async (t) => {
  const f = fixture(t, {
    execute: (ctx) =>
      new Promise((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(Error('Stopped fixture')), { once: true });
      }),
  });
  const started = await f.investigations.action(start());
  for (let count = 0; count < 100 && !f.calls.length; count++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.calls.length, 1);
  await f.investigations.action({ action: 'investigation-stop', id: started.session.id });
  const stopped = await settled(f, started.session.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(f.flows.issues().length, 1);
  const flow = f.flows.read(f.flows.selected(stopped.issueId));
  assert.equal(flow.blocks.find(({ kind }) => kind === 'understand').attempts.at(-1).status, 'stopped');
});

test('whole-project defaults use project settings and archived existing issues are supplied to proposals', async (t) => {
  let existing;
  const f = fixture(t, {
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
  const started = await f.investigations.action(input);
  const result = await settled(f, started.session.id);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.branch, 'refs/heads/investigation-target');
  assert.equal(f.calls[0].flow.executionSettings.values.model, 'gpt-6.1-sol');
  assert.equal(f.calls[0].flow.executionSettings.values.effort, 'high');
  assert.ok(existing.some(({ title }) => title === 'Existing archived work'));
  assert.equal(result.followups.length, 0);
});

test('statistics include archived creations and unique historical closures even after reopen', (t) => {
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

test('concurrent replay of one explicit run cannot launch duplicate blocks', async (t) => {
  const f = fixture(t);
  const input = start();
  const results = await Promise.all([f.investigations.action(input), f.investigations.action(input)]);
  assert.equal(results[0].session.id, results[1].session.id);
  const done = await settled(f, results[0].session.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(f.calls.length, 1);
  assert.equal(f.flows.issues().length, 2);
});

test('changing branches preserves source edits and stops instead of resetting a modified investigation checkout', async (t) => {
  const f = fixture(t);
  const discussed = await f.investigations.action({
    ...start('investigation-discuss'),
    message: 'Explain this branch first.',
  });
  const draft = await settled(f, discussed.session.id);
  const flow = f.flows.read(f.flows.selected(draft.issueId));
  const source = join(flow.workspace.checkout, 'source.txt');
  writeFileSync(source, 'unsaved human edit');
  const run = await f.investigations.action({
    action: 'investigation-run',
    id: draft.id,
    requestId: randomUUID(),
    branch: 'refs/heads/dev',
  });
  const failed = await settled(f, run.session.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /source edits or commits/);
  assert.equal(readFileSync(source, 'utf8'), 'unsaved human edit');
  assert.equal(f.calls.length, 1);
  assert.equal(f.flows.issues().length, 1);
});

test('invalid branches and empty discussions create no issue and no model work', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.investigations.action({ ...start(), branch: 'refs/heads/missing' }),
    /selected starting branch is unavailable/
  );
  await assert.rejects(f.investigations.action({ ...start('investigation-discuss'), message: '' }), /Enter a question/);
  assert.equal(f.flows.issues().length, 0);
  assert.equal(f.calls.length, 0);
});

test('Stop during follow-up capture finishes that capture but starts no later issue', async (t) => {
  const proposal = (title) => ({
    title,
    type: 'bug',
    description: title,
    reason: 'Observed source.txt:1.',
    verification: 'A focused behavioral check.',
  });
  const f = fixture(t, { propose: async () => [proposal('First finding'), proposal('Second finding')] });
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
  const started = await f.investigations.action(start());
  for (let count = 0; count < 200 && !captured; count++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(captured, true);
  await f.investigations.action({ action: 'investigation-stop', id: started.session.id });
  release();
  const stopped = await settled(f, started.session.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(f.flows.issues().filter(({ state }) => state === 'needs-approval').length, 1);
});

test('Retry reconciles an uncertain original Understand attempt instead of starting an unrelated operation', async (t) => {
  let round = 0;
  const f = fixture(t, {
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
  const started = await f.investigations.action(start());
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

test('failed automatic capture cannot silently switch to a newer Understand result on Retry', async (t) => {
  const f = fixture(t);
  const capture = f.flows.capture.bind(f.flows);
  let fail = true;
  f.flows.capture = async (input) => {
    if (input.needsApproval && fail) throw Error('Synthetic capture failure');
    return capture(input);
  };
  const started = await f.investigations.action(start());
  const failed = await settled(f, started.session.id);
  assert.equal(failed.status, 'failed');
  const originalAttemptId = failed.attemptId;
  const originalResult = failed.result;
  let flow = f.flows.read(f.flows.selected(failed.issueId));
  await f.flows.action({ action: 'start', issueId: failed.issueId, blockId: failed.blockId, revision: flow.revision });
  await f.flows.active.get(failed.issueId)?.task;
  fail = false;
  const retry = await f.investigations.action({ action: 'investigation-retry', id: failed.id });
  const stale = await settled(f, retry.session.id);
  assert.equal(stale.status, 'failed');
  assert.match(stale.error, /findings changed.*Run the investigation again/);
  assert.equal(stale.attemptId, originalAttemptId);
  assert.equal(stale.result, originalResult);
  assert.equal(f.flows.issues().length, 1);
  assert.equal(f.calls.length, 2);
});

test('preview reads saved running investigations without creating files, reconciling, or claiming the live server', async (t) => {
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

test('project branch selection is independent of the issue filing folder branch override', async (t) => {
  const f = fixture(t, { propose: async () => [] });
  const inbox = join(f.root, 'user/Inbox/folder.md');
  const content = readFileSync(inbox, 'utf8');
  writeFileSync(inbox, content.replace(/branch: .*/, 'branch: unavailable-folder-branch'));
  const started = await f.investigations.action(start());
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
