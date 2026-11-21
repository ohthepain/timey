import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gitFixture } from './git-fixture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { createProjectDiscussTools } from './factory-ui/project-discuss-tools.mjs';
import { moveIssueStorage } from './factory-ui/issue-storage-actions.mjs';
import { makeBlock } from './factory-ui/flow-store.mjs';
import { ProjectInvestigations } from './factory-ui/project-investigations.mjs';
import { BlockCatalog } from './factory-ui/block-catalog.mjs';
import { digest } from './factory-ui/common.mjs';
import { successfulInvestigationSource } from './factory-ui/investigation-flow.mjs';

async function fixture(t, execute) {
  const { root, git } = gitFixture(t, 'investigation-flow-');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, '.fixture-codex');
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, 'source.txt'), 'source');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  git('branch', 'dev');
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
        if (execute) {
          const result = await execute(ctx);
          if (result) return result;
        }
        const body = 'Observed source.txt. Verify the boundary before changing it.';
        const path = join(root, '.issues/factory-ui/flow-evidence', ctx.attempt.id, 'response.md');
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, body);
        const file = { path, sha256: digest(body), label: 'Block response' };
        return {
          output: body,
          summary: body,
          evidence: [file],
          result: { head: git('rev-parse', 'HEAD') },
          artifacts: { files: { response: file }, values: {} },
        };
      },
      close() {},
    },
  });
  t.after(() => flows.close());
  const created = await flows.capture({
    requestId: randomUUID(),
    description: 'Investigate source boundaries',
    type: 'investigation',
    reusable: true,
    startingRef: 'refs/heads/dev',
  });
  const issueId = created.issue.id;
  const flow = flows.read(flows.selected(issueId));
  flow.blocks[0].data.fields = { type: 'investigation', goal: 'Investigate source boundaries' };
  flows.store.save(flow, flow.revision);
  const run = async (kind, input = {}) => {
    const current = flows.read(flows.selected(issueId));
    const block = current.blocks.find((entry) => entry.kind === kind);
    const result = await flows.action({
      action: 'start',
      issueId,
      blockId: block.id,
      revision: current.revision,
      ...input,
    });
    await flows.active.get(issueId)?.task;
    return flows
      .read(flows.selected(issueId))
      .blocks.find((entry) => entry.id === block.id)
      .attempts.find((entry) => entry.id === result.attemptId);
  };
  return { root, git, service, flows, calls, issueId, run, flow: () => flows.read(flows.selected(issueId)) };
}

test('investigation creation starts nothing and either output runs independently from retained inquiry findings', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    f.flow().blocks.map(({ kind }) => kind),
    ['request', 'investigate', 'generate-report', 'create-issues']
  );
  assert.equal(f.calls.length, 0);
  assert.deepEqual(
    f
      .flow()
      .blocks.slice(2)
      .map(({ skill }) => skill),
    ['generate-report', 'create-issues']
  );
  await assert.rejects(f.run('generate-report'), /successfully completed investigation/);
  const inquiry = await f.run('investigate');
  const issues = await f.run('create-issues');
  assert.equal(issues.status, 'completed');
  assert.equal(issues.investigationSource.attemptId, inquiry.id);
  assert.deepEqual(issues.supplementalFindings, []);
  const current = f.flow();
  const output = current.blocks.find(({ kind }) => kind === 'create-issues');
  await f.flows.action({ action: 'remove', issueId: f.issueId, blockId: output.id, revision: current.revision });
  const report = await f.run('generate-report');
  assert.equal(report.investigationSource.attemptId, inquiry.id);
  assert.equal(report.status, 'completed');
  assert.equal(f.calls.filter(({ block }) => block.kind === 'investigate').length, 1);
});

test('report failure pauses playback while Create Issues stays manually runnable', async (t) => {
  const f = await fixture(t, async (ctx) =>
    ctx.block.kind === 'generate-report'
      ? { status: 'failed', summary: 'Report publication failed.', evidence: [] }
      : null
  );
  await f.run('investigate');
  await f.flows.action({ action: 'play', issueId: f.issueId });
  for (let count = 0; count < 100 && f.flows.autoplay.get(f.issueId)?.mode === 'playing'; count++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.flows.autoplay.get(f.issueId).mode, 'paused');
  assert.equal(f.calls.filter(({ block }) => block.kind === 'create-issues').length, 0);
  const issues = await f.run('create-issues');
  assert.equal(issues.status, 'completed');
  assert.deepEqual(issues.supplementalFindings, []);
});

test('only successful report findings are forwarded and presentation edits do not invalidate issue creation', async (t) => {
  const f = await fixture(t, async (ctx) =>
    ctx.block.kind === 'generate-report'
      ? {
          output: 'Report',
          artifacts: {
            values: { additionalFindings: 'New observed boundary', inspectedRevisions: ['new-revision'] },
            files: {},
          },
          evidence: [],
        }
      : null
  );
  await f.run('investigate');
  const report = await f.run('generate-report');
  const issues = await f.run('create-issues');
  assert.equal(issues.supplementalFindings[0].attemptId, report.id);
  assert.equal(issues.supplementalFindings[0].findings, 'New observed boundary');
  const flow = f.flow();
  await f.flows.action({
    action: 'update',
    issueId: f.issueId,
    blockId: flow.blocks.find(({ kind }) => kind === 'generate-report').id,
    changes: { prompt: 'Present the same findings as a table.' },
    revision: flow.revision,
  });
  const saved = f
    .flow()
    .blocks.find(({ kind }) => kind === 'create-issues')
    .attempts.at(-1);
  assert.equal(saved.id, issues.id);
  assert.equal(saved.invalidatedAt, undefined);
});

test('Retry retains publication and original run while deliberate generation creates another publication', async (t) => {
  let failed = true;
  const f = await fixture(t, async (ctx) => {
    if (ctx.block.kind === 'generate-report' && failed)
      return { status: 'failed', summary: 'Save interrupted.', evidence: [] };
    return null;
  });
  const inquiry = await f.run('investigate');
  const first = await f.run('generate-report');
  await f.run('investigate');
  failed = false;
  const recovered = await f.run('generate-report', { action: 'continue' });
  assert.equal(recovered.publicationId, first.publicationId);
  assert.equal(recovered.investigationSource.attemptId, inquiry.id);
  const deliberate = await f.run('generate-report');
  assert.notEqual(deliberate.publicationId, first.publicationId);
  assert.notEqual(deliberate.investigationSource.attemptId, inquiry.id);
  assert.equal(f.flow().blocks.find(({ kind }) => kind === 'investigate').attempts.length, 2);
});

test('idle standard adoption preserves inquiry IDs, history, settings and completed issue outcomes without executing', async (t) => {
  const f = await fixture(t);
  const catalog = new BlockCatalog(f.root).read().entries;
  const flow = f.flow();
  const old = makeBlock('understand', [flow.blocks[0].id], false, catalog);
  old.id = 'old-inquiry';
  old.flowKey = 'work';
  old.attempts = [
    {
      id: 'old-attempt',
      status: 'completed',
      startedAt: '2026-11-20T10:00:00Z',
      result: { head: f.git('rev-parse', 'HEAD') },
      output: 'Retained findings',
      evidence: [],
    },
  ];
  flow.blocks = [flow.blocks[0], old];
  flow.settings = { effort: 'high' };
  delete flow.investigationLayout;
  f.flows.store.save(flow, flow.revision);
  f.flows.investigations = {
    sessions: new Map([
      [
        'legacy',
        {
          id: 'legacy',
          issueId: f.issueId,
          attemptId: 'old-attempt',
          status: 'completed',
          mode: 'investigation',
          followupSource: { attemptId: 'old-attempt' },
          followups: [{ id: 'stable-proposal', issueId: 'saved-issue', title: 'Saved work' }],
        },
      ],
    ]),
  };
  const adopted = f.flow();
  assert.deepEqual(
    adopted.blocks.map(({ kind }) => kind),
    ['request', 'investigate', 'generate-report', 'create-issues']
  );
  assert.equal(adopted.blocks[1].id, 'old-inquiry');
  assert.equal(adopted.blocks[1].attempts[0].id, 'old-attempt');
  assert.deepEqual(adopted.settings, { effort: 'high' });
  assert.deepEqual(adopted.blocks[3].historicalCompletion.issueIds, ['saved-issue']);
  const source = successfulInvestigationSource(adopted, f.issueId);
  assert.equal(source.legacyFollowups[0].id, 'stable-proposal');
  assert.equal(f.calls.length, 0);
  const persisted = JSON.parse(readFileSync(f.flows.store.path(f.issueId), 'utf8'));
  assert.equal(persisted.blocks[1].kind, 'understand');
});

test('custom and uncertain legacy flows retain their configuration and never start work during adoption', async (t) => {
  const f = await fixture(t);
  const catalog = new BlockCatalog(f.root).read().entries;
  for (const custom of [true, false]) {
    const flow = f.flow();
    const inquiry = makeBlock('understand', [flow.blocks[0].id], false, catalog);
    if (custom) inquiry.prompt = 'My custom inquiry instructions.';
    else inquiry.attempts = [{ id: 'uncertain', status: 'uncertain' }];
    flow.blocks = [flow.blocks[0], inquiry];
    delete flow.investigationLayout;
    f.flows.store.save(flow, flow.revision);
    assert.equal(f.flow().blocks.length, 2);
    assert.equal(f.flow().blocks[1].kind, 'understand');
  }
  assert.equal(f.calls.length, 0);
});

test('cold loading a legacy issue retains durable creation receipts before the Home service exists', async (t) => {
  const f = await fixture(t);
  const catalog = new BlockCatalog(f.root).read().entries;
  const flow = f.flow();
  const old = makeBlock('understand', [flow.blocks[0].id], false, catalog);
  old.id = old.flowKey = 'work';
  old.attempts = [
    {
      id: 'durable-inquiry',
      status: 'completed',
      startedAt: '2026-11-20T10:00:00Z',
      output: 'Saved findings',
      evidence: [],
    },
  ];
  flow.blocks = [flow.blocks[0], old];
  delete flow.investigationLayout;
  f.flows.store.save(flow, flow.revision);
  const sessionId = randomUUID();
  const directory = join(f.root, '.issues/factory-ui/project-home/investigations');
  mkdirSync(directory, { recursive: true });
  const revision = f.git('rev-parse', 'HEAD');
  writeFileSync(
    join(directory, sessionId + '.json'),
    JSON.stringify({
      id: sessionId,
      issueId: f.issueId,
      attemptId: 'durable-inquiry',
      status: 'completed',
      mode: 'investigation',
      folder: 'Inbox',
      settings: { model: 'retained-model', effort: 'high' },
      startingPoint: { ref: 'refs/heads/dev', name: 'dev', commit: revision },
      followupSource: { attemptId: 'durable-inquiry' },
      followupBasis: 'durable-basis',
      followups: [{ id: 'durable-finding', title: 'Saved work', issueId: 'saved-work' }],
    })
  );
  assert.equal(f.flows.investigations, undefined);
  const adopted = f.flow();
  assert.deepEqual(adopted.blocks[3].historicalCompletion.issueIds, ['saved-work']);
  assert.equal(adopted.blocks[3].legacyFollowups[0].folder, 'Inbox');
  const source = successfulInvestigationSource(adopted, f.issueId);
  assert.equal(source.revision, revision);
  assert.equal(source.legacyFollowups[0].id, 'durable-finding');
  assert.equal(source.legacyFollowups[0].folder, 'Inbox');
  await f.flows.action({
    action: 'update',
    issueId: f.issueId,
    blockId: adopted.blocks[2].id,
    revision: adopted.revision,
    changes: { prompt: 'Use a concise summary.' },
  });
  const persisted = JSON.parse(readFileSync(f.flows.store.path(f.issueId), 'utf8'));
  assert.equal(persisted.investigationRunSources['durable-inquiry'].settings.model, 'retained-model');
  assert.equal(persisted.blocks[3].legacyFollowups[0].followupBasis, 'durable-basis');
  assert.equal(persisted.blocks[3].attempts.length, 0);
  assert.equal(f.calls.length, 0);
});

test('adoption preserves customized execution and Request definitions', async (t) => {
  const f = await fixture(t);
  const catalog = new BlockCatalog(f.root).read().entries;
  const baseline = f.flow();
  const changes = [
    (request, inquiry) => {
      inquiry.lane = 1;
    },
    (request, inquiry) => {
      inquiry.iterations = 2;
    },
    (request, inquiry) => {
      inquiry.suggested = true;
    },
    (request) => {
      request.links = { goal: 'custom-source' };
    },
    (request) => {
      request.definitionChecksum = 'custom-definition';
    },
    (request) => {
      request.declaredDetails = [];
    },
    (request) => {
      request.label = 'Custom request';
    },
  ];
  for (const customize of changes) {
    const flow = structuredClone(baseline);
    flow.revision = f.flow().revision;
    const inquiry = makeBlock('understand', [flow.blocks[0].id], false, catalog);
    customize(flow.blocks[0], inquiry);
    flow.blocks = [flow.blocks[0], inquiry];
    delete flow.investigationLayout;
    f.flows.store.save(flow, flow.revision);
    assert.equal(f.flow().blocks.length, 2);
    assert.equal(f.flow().blocks[1].kind, 'understand');
  }
  assert.equal(f.calls.length, 0);
});

test('saved investigation settings reach ordinary starts and each inquiry snapshots current execution settings', async (t) => {
  const f = await fixture(t);
  const investigations = new ProjectInvestigations(f.service, f.flows);
  t.after(() => investigations.close());
  await investigations.action({
    action: 'investigation-save',
    requestId: randomUUID(),
    issueId: f.issueId,
    revision: f.flow().revision,
    reusable: true,
    branch: 'refs/heads/dev',
    focus: 'Custom',
    prompt: 'Use the saved investigation goal.',
    instructions: 'Keep the saved investigation constraint.',
  });
  let flow = f.flow();
  flow.settings = { effort: 'high' };
  flow.blocks[1].prompt = 'Keep explicit block instructions.';
  f.flows.store.save(flow, flow.revision);
  const first = await f.run('investigate');
  assert.match(first.investigation.prompt, /saved investigation goal/);
  assert.match(first.investigation.prompt, /saved investigation constraint/);
  assert.match(first.investigation.prompt, /explicit block instructions/);
  assert.equal(first.investigation.settings.effort, 'high');
  assert.match(
    first.details.find(({ key }) => key === 'investigationConfiguration').value.prompt,
    /saved investigation goal/
  );
  flow = f.flow();
  flow.settings = { effort: 'medium' };
  f.flows.store.save(flow, flow.revision);
  const second = await f.run('investigate');
  assert.equal(second.investigation.settings.effort, 'medium');
  assert.equal(f.flow().blocks[1].attempts[0].investigation.settings.effort, 'high');
});

test('manual follow-up receipts preserve completed issue creation without a project session', async (t) => {
  const f = await fixture(t);
  const catalog = new BlockCatalog(f.root).read().entries;
  const flow = f.flow();
  const old = makeBlock('understand', [flow.blocks[0].id], false, catalog);
  old.id = old.flowKey = 'work';
  old.attempts = [
    {
      id: 'manual-inquiry',
      status: 'completed',
      startedAt: '2026-11-20T10:00:00Z',
      output: 'Saved findings',
      result: { head: f.git('rev-parse', 'HEAD') },
      evidence: [],
    },
  ];
  flow.blocks = [flow.blocks[0], old];
  delete flow.investigationLayout;
  f.flows.store.save(flow, flow.revision);
  const directory = join(f.root, '.issues/flows/investigation-followups');
  mkdirSync(directory, { recursive: true });
  const basis = 'a'.repeat(64);
  const path = join(directory, basis + '.json');
  const receipt = {
    source: { issueId: f.issueId, attemptId: 'manual-inquiry', basis },
    folder: 'Inbox',
    proposals: [{ id: 'original-proposal', title: 'Saved work', result: { issueId: 'existing-work' } }],
  };
  writeFileSync(path, JSON.stringify(receipt));
  assert.deepEqual(f.flow().blocks[3].historicalCompletion.issueIds, ['existing-work']);
  receipt.proposals.push({ id: 'remaining-proposal', title: 'Remaining work', error: 'Capture failed.' });
  writeFileSync(path, JSON.stringify(receipt));
  assert.equal(f.flow().blocks[3].historicalCompletion, undefined);
  assert.equal(f.calls.length, 0);
});

for (const historicalFlowOutputs of [undefined, false]) {
  test(
    'explicit Retry of adopted partial creation preserves its source with legacy flowOutputs ' +
      String(historicalFlowOutputs),
    async (t) => {
      const f = await fixture(t);
      const inquiry = await f.run('investigate');
      const flow = f.flow();
      const old = makeBlock('understand', [flow.blocks[0].id], false, new BlockCatalog(f.root).read().entries);
      old.id = old.flowKey = 'work';
      old.attempts = [inquiry];
      flow.blocks = [flow.blocks[0], old];
      delete flow.investigationLayout;
      f.flows.store.save(flow, flow.revision);
      const sessionId = randomUUID();
      const session = {
        flowOutputs: historicalFlowOutputs,
        id: sessionId,
        issueId: f.issueId,
        attemptId: inquiry.id,
        status: 'failed',
        mode: 'investigation',
        branch: 'refs/heads/dev',
        startingPoint: flow.startingPoint,
        settings: flow.executionSettings.values,
        focus: 'Custom',
        prompt: 'Retained goal',
        instructions: '',
        folder: 'Inbox',
        messages: [],
        receipts: {},
        followupSource: {
          issueId: f.issueId,
          blockId: old.id,
          attemptId: inquiry.id,
          attemptDigest: digest(JSON.stringify(inquiry)),
        },
        followups: [
          { id: 'successful-finding', title: 'Saved work', issueId: 'saved-issue' },
          { id: 'remaining-finding', title: 'Remaining work', error: 'Capture failed.' },
        ],
      };
      const directory = join(f.root, '.issues/factory-ui/project-home/investigations');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, sessionId + '.json'), JSON.stringify(session));
      const adopted = f.flow();
      assert.equal(adopted.blocks[1].kind, 'investigate');
      f.flows.store.save(adopted, adopted.revision);
      const investigations = new ProjectInvestigations(f.service, f.flows);
      t.after(() => investigations.close());
      await investigations.action({ action: 'investigation-retry', id: sessionId, requestId: randomUUID() });
      await investigations.active.get(sessionId)?.task;
      const finished = investigations.selected(sessionId);
      assert.equal(finished.status, 'completed', finished.error);
      assert.deepEqual(
        f.calls.map(({ block }) => block.kind),
        ['investigate', 'create-issues']
      );
      const output = f.flow().blocks[3].attempts.at(-1);
      assert.equal(output.investigationSource.attemptId, inquiry.id);
      assert.equal(output.investigationSource.legacyFollowups[0].issueId, 'saved-issue');
      assert.equal(f.flow().blocks[2].attempts.length, 0);
    }
  );
}

test('removing Generate report keeps Create Issues runnable from the completed inquiry', async (t) => {
  const f = await fixture(t);
  const inquiry = await f.run('investigate');
  const current = f.flow();
  const report = current.blocks.find(({ kind }) => kind === 'generate-report');
  await f.flows.action({ action: 'remove', issueId: f.issueId, blockId: report.id, revision: current.revision });
  const issues = await f.run('create-issues');
  assert.equal(issues.status, 'completed');
  assert.equal(issues.investigationSource.attemptId, inquiry.id);
  assert.deepEqual(issues.supplementalFindings, []);
});

test('approval of a saved investigation follow-up leaves it idle', async (t) => {
  const f = await fixture(t);
  const inquiry = await f.run('investigate');
  const captured = await f.flows.capture({
    requestId: randomUUID(),
    description: 'Repair the observed parser boundary',
    type: 'bug',
    needsApproval: true,
    sourceIssue: f.issueId,
    sourceAttempt: inquiry.id,
  });
  const id = captured.issue.id;
  const before = f.calls.length;
  const view = await f.flows.view(id);
  await f.flows.action({ action: 'approve-issue', issueId: id, revision: view.flow.revision });
  assert.equal(f.flows.selected(id).state, 'backlog');
  assert.equal(f.calls.length, before);
  assert.ok(f.flows.read(f.flows.selected(id)).blocks.every(({ attempts }) => attempts.length === 0));
  assert.equal(f.flows.active.has(id), false);
});

test('report follow-up creation from an archived investigation uses guarded approval without restoration or inquiry', async (t) => {
  const f = await fixture(t);
  const inquiry = await f.run('investigate');
  await moveIssueStorage(f.service, { action: 'archive', issueIds: [f.issueId] });
  const calls = f.calls.length;
  const tools = createProjectDiscussTools(f.service, {
    flows: () => f.flows,
    reportContext: () => ({
      reportId: 'retained-report',
      outputAttemptId: 'retained-output',
      source: { issueId: f.issueId, attemptId: inquiry.id },
    }),
  });
  const saved = await tools.invoke('issue_create', {
    requestId: randomUUID(),
    description: 'Repair uncovered archived investigation work',
    type: 'bug',
    needsApproval: false,
  });
  const child = f.flows.selected(saved.issueId);
  assert.equal(child.state, 'needs-approval');
  assert.equal(child.source_issue, f.issueId);
  assert.equal(child.source_attempt, inquiry.id);
  assert.equal(f.flows.selected(f.issueId).location, 'archive');
  assert.equal(f.calls.length, calls);
  assert.ok(f.flows.read(child).blocks.every(({ attempts }) => attempts.length === 0));
});

test('Run again preserves custom inquiry prompts across successive reusable runs', async (t) => {
  const f = await fixture(t);
  const { ProjectInvestigations } = await import('./factory-ui/project-investigations.mjs');
  const owner = new ProjectInvestigations(f.service, f.flows);
  t.after(() => owner.close());
  const current = f.flow();
  const inquiry = current.blocks.find(({ kind }) => kind === 'investigate');
  await f.flows.action({
    action: 'update',
    issueId: f.issueId,
    blockId: inquiry.id,
    revision: current.revision,
    changes: { prompt: 'Inspect only the custom parser boundary.' },
  });
  for (let run = 0; run < 2; run++) {
    const saved = await owner.action({ action: 'investigation-run', requestId: randomUUID(), issueId: f.issueId });
    await owner.active.get(saved.session.id)?.task;
    assert.equal(owner.selected(saved.session.id).status, 'completed');
  }
  assert.deepEqual(
    f.calls.filter(({ block }) => block.kind === 'investigate').map(({ block }) => block.prompt),
    ['Inspect only the custom parser boundary.', 'Inspect only the custom parser boundary.']
  );
});
