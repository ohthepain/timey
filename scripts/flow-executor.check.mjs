import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFlowExecutor } from './factory-ui/flow-executor.mjs';
import { digest } from './factory-ui/common.mjs';
import { conversationMessages, conversationState, conversationFiles } from './factory-ui/conversation-store.mjs';

function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'timey-flow-executor-')));
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  git('init', '-b', 'dev');
  git('config', 'user.name', 'Flow test');
  git('config', 'user.email', 'flow@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.issues/\n');
  writeFileSync(join(root, 'source.txt'), 'Initial source.\n');
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  git('add', '.');
  git('commit', '-m', 'Fixture');
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, '.issues/triage-labels.md'), 'Fixture policy.\n');
  const skillPath = join(root, '.issues/sample-skill.md');
  writeFileSync(skillPath, 'A fixture skill.\n');
  const calls = [];
  let emit;
  const connection = {
    async ready() {},
    async start(cwd, sandbox, retain, _issueId, _settingsRoot, instructions) {
      calls.push({ method: 'start', cwd, sandbox, instructions });
      retain({ status: 'ready', threadId: 'the-one-issue-chat' });
      return 'the-one-issue-chat';
    },
    async resume(id, cwd, sandbox) {
      calls.push({ method: 'resume', id, cwd, sandbox });
    },
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'skills/list')
        return {
          data: [{ skills: [{ name: 'sample', path: skillPath, enabled: true }] }],
        };
      if (method === 'model/list') return { data: [{ id: 'gpt-6.1-sol', displayName: 'Sol' }] };
      if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
      throw Error('Unexpected fixture transport method ' + method);
    },
    async turn(threadId, cwd, prompt, schema, skills, settings, receipt) {
      calls.push({
        method: 'turn',
        threadId,
        cwd,
        prompt,
        schema,
        skills,
        settings,
      });
      receipt.accepted({ threadId, turnId: 'turn-' + calls.length });
      emit({
        method: 'item/agentMessage/delta',
        params: { threadId, delta: 'Observed progress.' },
      });
      return 'Observed block result.';
    },
    async interrupt(threadId) {
      calls.push({ method: 'interrupt', threadId });
    },
    close() {
      calls.push({ method: 'close' });
    },
  };
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    issueCleanupTasks: new Map(),
    store: { runs: [], connected: new Set(), event() {} },
    issueChats: {
      tasks: new Map(),
      active: new Map(),
      scheduler: { view: () => ({ entries: [] }) },
      release() {},
    },
    ownServer() {},
    guard(...args) {
      calls.push({ method: 'guard', args });
    },
  };
  const executor = createFlowExecutor(service, {
    verifyWork: async () => ({ evidence: [] }),
    ...(!options.execute && {
      verifyCandidate: async () => ({ result: { summaries: [] }, evidence: [] }),
    }),
    createConnection({ onEvent }) {
      emit = onEvent;
      calls.push({ method: 'connection' });
      return connection;
    },
    ...options,
  });
  const issue = {
    id: 'fixture-issue',
    issueNumber: 4,
    title: 'Make the flow explicit',
    content: 'Do one explicit block at a time.',
  };
  const flow = {
    issueId: issue.id,
    type: 'feature',
    request: {
      goal: issue.title,
      proof: 'Saved output.',
      knownFacts: '',
      constraints: '',
    },
    target: { branch: 'dev', remote: 'origin', base: null },
    workspace: null,
    blocks: [],
  };
  const progress = [];
  let n = 0;
  function run(kind = 'work', changes = {}) {
    const attempt = { id: 'attempt-' + ++n, details: changes.details ?? [] };
    const block = {
      id: 'block-' + kind,
      kind,
      skill: null,
      prompt: 'Perform this explicit block only.',
      iterations: 1,
      edits: [],
      attempts: [attempt],
      ...changes,
    };
    return executor.run({
      issue,
      flow,
      block,
      attempt,
      signal: changes.signal,
      continuing: changes.continuing,
      input: changes.input ?? { confirmed: true },
      onProgress: (text) => progress.push(text),
      onWorkspace: (workspace) => {
        calls.push({ method: 'workspace', workspace });
        flow.workspace = workspace;
      },
    });
  }
  t.after(() => {
    executor.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    git,
    service,
    executor,
    connection,
    calls,
    issue,
    flow,
    run,
    progress,
    emit: (message) => emit(message),
  };
}

test('an explicit work block makes one model turn and records its managed checkout before connection', async (t) => {
  const f = fixture(t);
  const turnResult = f.connection.turn;
  f.connection.turn = async (...args) => {
    await turnResult(...args);
    const proof = join(args[1], '.issues', 'observed-proof.txt');
    mkdirSync(join(args[1], '.issues'), { recursive: true });
    writeFileSync(proof, 'The created issue appeared in the same folder.');
    return [
      'Observed the issue in the same folder. The browser was unavailable for the reload check.',
      '',
      '```flow-result',
      '{"files":{"proof":".issues/observed-proof.txt"}}',
      '```',
    ].join('\n');
  };
  const requestedProof = 'Create an issue from the folder and show it there before and after reload.';
  const result = await f.run('work', { skill: 'sample', details: [{ key: 'requestedProof', value: requestedProof }] });
  assert.equal(f.calls.filter((call) => call.method === 'turn').length, 1);
  assert.equal(f.calls.find((call) => call.method === 'start').sandbox, 'workspace-write');
  assert.ok(
    f.calls.findIndex((call) => call.method === 'workspace') < f.calls.findIndex((call) => call.method === 'connection')
  );
  const turn = f.calls.find((call) => call.method === 'turn');
  assert.deepEqual(turn.skills, [
    {
      type: 'skill',
      name: 'sample',
      path: join(f.root, '.issues/sample-skill.md'),
    },
  ]);
  assert.equal(JSON.parse(turn.prompt).block, 'work');
  assert.deepEqual(JSON.parse(turn.prompt).details, [{ key: 'requestedProof', value: requestedProof }]);
  const system = f.calls.find((call) => call.method === 'start').instructions;
  assert.match(system, /Keep all work inside the saved issue checkout/);
  assert.match(system, /Use Requested Proof to check the current result/);
  assert.doesNotMatch(system, /Do not continue to another block/);
  assert.equal(result.workspace.branch, 'codex/issue-4');
  assert.equal(f.service.lifecycleRuns[f.issue.id].chatCheckout.checkout, result.workspace.checkout);
  assert.match(conversationFiles(f.root, f.issue.id).directory, /issue-work.*fixture-issue.*conversations/);
  assert.equal(readFileSync(result.evidence[0].path, 'utf8'), result.output);
  assert.match(result.output, /The browser was unavailable for the reload check/);
  assert.equal(result.status, undefined);
  assert.equal(
    readFileSync(result.artifacts.files.proof.path, 'utf8'),
    'The created issue appeared in the same folder.'
  );
  assert.equal(conversationState(f.root, f.issue.id).flowBlocks['block-work'].status, 'idle');
  assert.ok(f.progress.includes('Observed progress.'));
});

test('a new checkout uses the selected starting commit and retains it when the source branch moves', async (t) => {
  const f = fixture(t);
  const destination = f.git('rev-parse', 'dev');
  f.git('checkout', '-b', 'selected-base');
  writeFileSync(join(f.root, 'source.txt'), 'Content from the selected starting branch.\n');
  f.git('commit', '-am', 'Selected branch content');
  const selected = f.git('rev-parse', 'HEAD');
  f.git('checkout', 'dev');
  f.flow.startingPoint = { ref: 'refs/heads/selected-base', name: 'selected-base', commit: selected };
  f.git('update-ref', 'refs/heads/selected-base', destination);
  const first = await f.run('work');
  assert.equal(first.workspace.base, selected);
  assert.equal(
    readFileSync(join(first.workspace.checkout, 'source.txt'), 'utf8'),
    'Content from the selected starting branch.\n'
  );
  assert.equal(f.git('rev-parse', 'dev'), destination);
  assert.equal(f.git('branch', '--show-current'), 'dev');
  f.flow.startingPoint = { ref: 'refs/heads/dev', name: 'dev', commit: destination };
  const retry = await f.run('work');
  assert.equal(retry.workspace.base, selected, 'A retained checkout must keep its original base.');
});

test('Work repairs formatting and Fallow in its own chat and leaves full checks to Verify', async (t) => {
  const checks = [];
  const f = fixture(t, {
    async verifyWork(_ctx, workspace, folder) {
      checks.push({ workspace, folder });
      if (checks.length === 1)
        throw Object.assign(Error('Fallow failed'), {
          verificationFailure: true,
          evidence: [{ label: 'Failure', path: 'fallow.log' }],
        });
      return { evidence: [] };
    },
    async verifyCandidate() {
      checks.push('full Verify');
      return { result: { head: 'checked-head' }, evidence: [] };
    },
  });
  const worked = await f.run('work');
  assert.equal(worked.result.verification, undefined);
  assert.equal(worked.artifacts.values.candidate, worked.result.head);
  assert.ok(worked.evidence.some(({ path }) => path === 'fallow.log'));
  const turns = f.calls.filter(({ method }) => method === 'turn');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].threadId, turns[1].threadId);
  assert.match(turns[0].prompt, /--work-checks[\s\S]*--write-format/);
  assert.match(turns[1].prompt, /fallow\.log/);
  assert.equal(checks.length, 2);
  assert.equal((await f.run('verify')).result.head, 'checked-head');
  assert.equal(checks.at(-1), 'full Verify');
});

test('Work stays blocked when Fallow still fails after repairs', async (t) => {
  const f = fixture(t, {
    async verifyWork() {
      throw Object.assign(Error('Still failing the required check'), { verificationFailure: true });
    },
  });
  await assert.rejects(f.run('work'), /Still failing/);
  assert.equal(f.calls.filter(({ method }) => method === 'turn').length, 4);
});

test('an unchanged explicit continuation reuses the same checkout, conversation and selected skill', async (t) => {
  const f = fixture(t);
  const first = await f.run('work', { skill: 'sample' });
  const second = await f.run('work', {
    skill: 'sample',
    continuing: true,
  });
  assert.deepEqual(first.workspace, second.workspace);
  assert.equal(f.calls.filter((call) => call.method === 'start').length, 1);
  assert.equal(f.calls.filter((call) => call.method === 'thread/read').length, 1);
  assert.equal(f.calls.filter((call) => call.method === 'turn').length, 2);
  assert.equal(new Set(f.calls.filter((call) => call.method === 'turn').map((call) => call.threadId)).size, 1);
  assert.deepEqual(
    f.calls.filter((call) => call.method === 'turn').map((call) => call.prompt),
    [f.calls.find((call) => call.method === 'turn').prompt, f.calls.find((call) => call.method === 'turn').prompt]
  );
  assert.equal(conversationMessages(f.root, f.issue.id).length, 4);
  await f.run('work', { skill: null, continuing: true });
  assert.equal(f.calls.filter((call) => call.method === 'start').length, 2);
});

test('read-only request and understanding need no legacy lifecycle configuration', async (t) => {
  const f = fixture(t);
  rmSync(join(f.root, '.issues/triage-labels.md'));
  await f.run('request');
  await f.run('understand');
  assert.equal(f.calls.filter((call) => call.method === 'turn').length, 2);
  assert.ok(
    f.calls.filter((call) => ['start', 'resume'].includes(call.method)).every((call) => call.sandbox === 'read-only')
  );
  await assert.rejects(f.run('work'), /lifecycle configuration is missing.*Project settings/);
  assert.equal(f.calls.filter((call) => call.method === 'turn').length, 2);
});

test('legacy work and queued prompts prevent model or checkout startup', async (t) => {
  const f = fixture(t);
  f.service.lifecycleTasks.set(f.issue.id, Promise.resolve());
  await assert.rejects(f.run(), /Legacy issue work/);
  assert.equal(f.calls.length, 0);
  f.service.lifecycleTasks.clear();
  f.service.issueChats.scheduler.view = () => ({ entries: [{ id: 'queued' }] });
  await assert.rejects(f.run(), /queued prompts/);
  assert.equal(f.calls.length, 0);
});

test('skills unavailable from the real transport list never dispatch a model turn', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run('understand', { skill: 'missing' }), /available skill/);
  assert.equal(f.calls.filter((call) => call.method === 'turn').length, 0);
});

test('prototype requires an explicit instruction and edit sends only enabled items', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run('prototype', { prompt: '' }), /Describe the prototype/);
  assert.equal(f.calls.length, 0);
  await f.run('edit', {
    details: [{ key: 'enabledEdits', value: ['Use a blue title.'] }],
    edits: [
      { id: 'yes', text: 'Use a blue title.', enabled: true },
      { id: 'no', text: 'Delete every title.', enabled: false },
    ],
  });
  const prompt = f.calls.find((call) => call.method === 'turn').prompt;
  assert.match(prompt, /Use a blue title/);
  assert.doesNotMatch(prompt, /Delete every title/);
});

test('Sol runs the configured iterations in the same conversation using an available Sol model', async (t) => {
  const f = fixture(t);
  const result = await f.run('sol', { iterations: 3 });
  const turns = f.calls.filter((call) => call.method === 'turn');
  assert.equal(turns.length, 3);
  assert.ok(turns.every((call) => call.settings.model === 'gpt-6.1-sol'));
  assert.equal(new Set(turns.map((call) => call.threadId)).size, 1);
  assert.equal(result.result.iterations, 3);
});

test('Sol refuses substitute models and starts no review', async (t) => {
  const f = fixture(t);
  const call = f.connection.call;
  f.connection.call = (method, params) =>
    method === 'model/list' ? Promise.resolve({ data: [{ id: 'gpt-6-luna' }] }) : call(method, params);
  await assert.rejects(f.run('sol'), /No Sol model is available/);
  assert.equal(f.calls.filter((entry) => entry.method === 'turn').length, 0);
});

test('abort interrupts the owned model turn and retains partial output with uncertain state', async (t) => {
  const f = fixture(t);
  const abort = new AbortController();
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let fail;
  f.connection.turn = async () =>
    new Promise((_, reject) => {
      fail = reject;
      started();
    });
  f.connection.interrupt = async (threadId) => {
    f.calls.push({ method: 'interrupt', threadId });
    fail(
      Object.assign(Error('Interrupted'), {
        terminalStatus: 'interrupted',
        partialText: 'Partial evidence.',
      })
    );
  };
  const task = f.run('understand', { signal: abort.signal });
  await ready;
  abort.abort();
  await assert.rejects(task, (error) => {
    assert.equal(readFileSync(error.evidence[0].path, 'utf8'), 'Partial evidence.');
    return true;
  });
  assert.equal(f.calls.filter((call) => call.method === 'interrupt').length, 1);
  assert.equal(conversationState(f.root, f.issue.id).flowBlocks['block-understand'].status, 'idle');
});

test('provider input stops the block and preserves its request instead of hanging', async (t) => {
  const f = fixture(t);
  f.connection.turn = async () => {
    f.emit({
      method: 'ui/approval',
      params: {
        threadId: 'the-one-issue-chat',
        requestId: 'question',
        questions: [{ id: 'q', question: 'Which output?' }],
      },
    });
    return new Promise(() => {});
  };
  await assert.rejects(f.run('understand'), (error) => {
    assert.match(error.message, /human input/);
    assert.equal(JSON.parse(readFileSync(error.evidence[0].path, 'utf8')).requestId, 'question');
    return true;
  });
  assert.equal(conversationState(f.root, f.issue.id).flowBlocks['block-understand'].status, 'attention');
});

test('protected merge and delete block without saved delivery evidence and start no model', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run('merge'), /No protected PR candidate or managed/);
  await assert.rejects(f.run('delete-worktree'), /No managed checkout/);
  assert.equal(f.calls.filter((call) => call.method === 'connection').length, 0);
});

for (const installed of ['matching', 'missing', 'stale', 'missing workspace']) {
  test(`explicit verification prepares ${installed} dependencies and retains command evidence`, async (t) => {
    const executions = [];
    const lock = 'lockfileVersion: 9.0\n';
    const workspaces = 'packages:\n  - packages/example\n';
    function installFixture(checkout, installedLock = lock, installWorkspace = true) {
      mkdirSync(join(checkout, 'node_modules/.pnpm'), { recursive: true });
      writeFileSync(join(checkout, 'node_modules/.pnpm/lock.yaml'), installedLock);
      if (installWorkspace) mkdirSync(join(checkout, 'packages/example/node_modules'), { recursive: true });
    }
    const f = fixture(t, {
      async execute(input) {
        executions.push(input);
        writeFileSync(input.log, 'Fixture command result.');
        if (input.command === 'pnpm') return installFixture(input.cwd);
        return 'FLOW_RESULT ' + JSON.stringify({ head: 'fixture-head', tree: 'fixture-tree', summaries: [] });
      },
    });
    // Verify prepares dependencies in an existing managed worktree.
    const { workspace } = await f.run('understand');
    writeFileSync(join(workspace.checkout, 'pnpm-lock.yaml'), lock);
    writeFileSync(join(workspace.checkout, 'pnpm-workspace.yaml'), workspaces);
    if (installed !== 'missing')
      installFixture(workspace.checkout, installed === 'stale' ? 'old lock' : lock, installed !== 'missing workspace');
    const modelCalls = f.calls.filter((call) => call.method === 'connection').length;
    const result = await f.run('verify');
    assert.deepEqual(
      executions.map(({ command }) => command),
      installed === 'matching' ? [process.execPath] : ['pnpm', process.execPath]
    );
    assert.ok(executions.every(({ cwd }) => cwd === workspace.checkout));
    if (installed !== 'matching') assert.deepEqual(executions[0].args, ['install', '--frozen-lockfile']);
    assert.match(executions.at(-1).args.at(-1), /checkCandidate/);
    assert.equal(result.result.head, 'fixture-head');
    assert.ok(result.evidence.every((item) => existsSync(item.path)));
    assert.equal(f.calls.filter((call) => call.method === 'connection').length, modelCalls);
  });
}

test('missing saved checkout blocks instead of silently replacing it', async (t) => {
  const f = fixture(t);
  f.service.lifecycleRuns[f.issue.id] = {
    issueId: f.issue.id,
    chatCheckout: {
      checkout: join(f.root, '.issues/issue-work/lost'),
      branch: 'codex/issue-4',
      base: f.git('rev-parse', 'HEAD'),
    },
  };
  await assert.rejects(f.run('understand'), /saved issue checkout is missing/);
  assert.equal(f.calls.length, 0);
});

test('stop during uncertain chat startup returns without creating a replacement chat', async (t) => {
  const f = fixture(t);
  const abort = new AbortController();
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  f.connection.start = async (_cwd, _sandbox, retain) => {
    retain({ status: 'starting' });
    signalStarted();
    return new Promise(() => {});
  };
  const task = f.run('understand', { signal: abort.signal });
  await started;
  abort.abort();
  await assert.rejects(task, /block was stopped/);
  const state = conversationState(f.root, f.issue.id).flowBlocks['block-understand'];
  assert.equal(state.status, 'attention');
  assert.equal(state.startup.status, 'starting');
  await assert.rejects(f.run('understand'), /startup is uncertain/);
  assert.equal(f.calls.filter((call) => call.method === 'turn').length, 0);
});

test('stop reaches explicit command execution and preserves its log', async (t) => {
  const abort = new AbortController();
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  let receivedSignal;
  const f = fixture(t, {
    execute(input) {
      receivedSignal = input.signal;
      writeFileSync(input.log, 'Command began.\n');
      signalStarted();
      return new Promise((_, reject) =>
        input.signal.addEventListener(
          'abort',
          () =>
            reject(
              Object.assign(Error('Command interrupted'), {
                name: 'AbortError',
                evidence: [{ path: input.log, label: 'Interrupted command output' }],
              })
            ),
          { once: true }
        )
      );
    },
  });
  const task = f.run('verify', { signal: abort.signal });
  await started;
  abort.abort();
  await assert.rejects(task, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(readFileSync(error.evidence[0].path, 'utf8'), 'Command began.\n');
    return true;
  });
  assert.equal(receivedSignal.aborted, true);
});

function verificationResult(workspace, folder) {
  const git = (...args) => execFileSync('git', ['-C', workspace.checkout, ...args], { encoding: 'utf8' }).trim();
  mkdirSync(folder, { recursive: true });
  const proof = ['verification', 'step'].map((checkpoint) => {
    const path = join(folder, checkpoint + '.json');
    writeFileSync(path, JSON.stringify({ checkpoint }));
    return { path, sha256: digest(readFileSync(path)) };
  });
  return { head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), base: workspace.base, proof };
}

function mergeFixture(t, { merged = false, onWait, repair, beforeVerify } = {}) {
  const verificationInput = () => 'fixture-input';
  const observations = [];
  let publishedHead;
  let nextTarget = 0;
  const advanceTarget = () => {
    const file = 'target-' + ++nextTarget + '.txt';
    writeFileSync(join(f.root, file), 'Change on target.\n');
    f.git('add', file);
    f.git('commit', '-m', file);
  };
  const pullRequest = (branch = f.flow.workspace.branch) => ({
    number: 9,
    state: merged ? 'closed' : 'open',
    merged_at: merged ? '2026-11-16T00:00:00Z' : null,
    head: { sha: publishedHead || f.flow.workspace.base, ref: branch, repo: { full_name: 'test/fixture' } },
    base: { ref: 'dev', repo: { full_name: 'test/fixture' } },
  });
  const f = fixture(t, {
    repair,
    verificationInput,
    async mergeDelay() {
      await onWait?.(advanceTarget);
    },
    async execute({ cwd, args }) {
      const git = (...values) =>
        execFileSync('git', ['-C', cwd, ...values], { encoding: 'utf8', stdio: 'pipe' }).trim();
      if (args[0] === 'fetch') return git('update-ref', 'refs/remotes/origin/dev', f.git('rev-parse', 'dev'));
      if (args[0] === 'push') {
        publishedHead = args[2].split(':')[0];
        observations.push({ operation: 'push', head: publishedHead });
        return;
      }
      return git(...args);
    },
    async verifyCandidate(_ctx, workspace, folder) {
      await beforeVerify?.(workspace);
      const result = { ...verificationResult(workspace, folder), input: verificationInput() };
      observations.push({ operation: 'verify', head: result.head });
      return { result, evidence: [] };
    },
    provider: {
      config: { repository: 'test/fixture', target: 'dev' },
      async gh() {
        return JSON.stringify({ data: { repository: { pullRequest: {} } } });
      },
      async findIssueBranchPR(branch) {
        return pullRequest(branch);
      },
      async ready(pr, branch, head) {
        assert.equal(head, pr.head.sha);
        observations.push({ operation: 'ready', head });
        return {
          head,
          merged,
          target: f.git('rev-parse', 'dev'),
          ...(merged ? { merge: { revision: 'actual-merge', url: 'https://example.invalid/pr/9' } } : {}),
        };
      },
      async inspect() {
        return pullRequest();
      },
      async merge(_number, head, { beforeMerge }) {
        await beforeMerge();
        observations.push({ operation: 'merge', head });
        return { revision: 'actual-merge', url: 'https://example.invalid/pr/9' };
      },
    },
    validateSummary(_summary, _base, _tree, policy) {
      assert.equal(policy.auditPolicy, 'required');
    },
  });
  f.git('remote', 'add', 'origin', 'git@github.com:test/fixture.git');
  writeFileSync(
    join(f.root, '.issues/issue-delivery-config.json'),
    JSON.stringify({ provider: 'github', repository: 'test/fixture', remote: 'origin', target: 'dev' })
  );
  return { ...f, observations, advanceTarget };
}

test('Update Branch leaves full verification of the updated candidate to Merge', async (t) => {
  const f = mergeFixture(t);
  await f.run('understand');
  f.advanceTarget();
  const update = await f.run('update-branch');
  assert.ok(update.result.fetchedCommit);
  assert.equal(f.observations.filter(({ operation }) => operation === 'verify').length, 0);
  f.flow.blocks.push({
    id: 'updated-branch',
    kind: 'update-branch',
    after: [],
    attempts: [{ status: 'completed', result: update.result }],
  });
  await f.run('merge', { after: ['updated-branch'] });
  assert.equal(f.observations.filter(({ operation }) => operation === 'verify').length, 1);
});

function approvalAttempt(result) {
  return { id: 'approval-attempt', status: 'blocked', result: result.result };
}

function approveMerge(f, result) {
  return f.run('merge', {
    attempts: [approvalAttempt(result)],
    continuing: true,
    input: { confirmed: true, mergeToken: result.result.mergeConfirmation.token },
  });
}

test('Merge verifies an unchanged PR once and requires approval of its exact commit and target', async (t) => {
  const f = mergeFixture(t);
  await f.run('understand');
  const first = await f.run('merge');
  assert.equal(first.status, 'blocked');
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['verify', 'ready']
  );
  const result = await approveMerge(f, first);
  assert.equal(result.result.revision, 'actual-merge');
  assert.equal(result.workspace.pr, 9);
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['verify', 'ready', 'ready', 'ready', 'merge']
  );
  assert.equal(f.calls.filter((item) => item.method === 'guard').at(-1).args[2], 'merge');
});

test('Merge verifies and pushes each new candidate, then expires approval if the target moves again', async (t) => {
  let waits = 0;
  const f = mergeFixture(t, {
    onWait(advance) {
      if (++waits === 1) advance();
    },
  });
  await f.run('understand');
  f.advanceTarget();
  const first = await f.run('merge');
  assert.equal(first.status, 'blocked');
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['verify', 'push', 'verify', 'push', 'ready']
  );
  assert.equal(first.result.mergeConfirmation.target, f.git('rev-parse', 'dev'));
  f.advanceTarget();
  const second = await approveMerge(f, first);
  assert.equal(second.status, 'blocked');
  assert.notEqual(second.result.mergeConfirmation.token, first.result.mergeConfirmation.token);
  assert.equal(
    f.observations.some(({ operation }) => operation === 'merge'),
    false
  );
  assert.equal((await approveMerge(f, second)).result.revision, 'actual-merge');
});

test('Merge repairs a target conflict in its owning checkout before it verifies or pushes', async (t) => {
  const f = mergeFixture(t);
  await f.run('understand');
  const { checkout } = f.flow.workspace;
  const issueGit = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  writeFileSync(join(checkout, 'source.txt'), 'Issue changes.\n');
  issueGit('commit', '-am', 'Issue changes');
  writeFileSync(join(f.root, 'source.txt'), 'Target changes.\n');
  f.git('commit', '-am', 'Target changes');
  const turn = f.connection.turn.bind(f.connection);
  f.connection.turn = async (...args) => {
    assert.equal(args[1], checkout);
    assert.match(args[2], /Resolve the target merge conflicts/);
    writeFileSync(join(checkout, 'source.txt'), 'Issue and target changes.\n');
    issueGit('add', 'source.txt');
    issueGit('commit', '--no-edit');
    return turn(...args);
  };
  const result = await f.run('merge');
  assert.equal(result.status, 'blocked');
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['verify', 'push', 'ready']
  );
  assert.equal(issueGit('merge-base', 'HEAD', 'dev'), f.git('rev-parse', 'dev'));
  assert.equal(readFileSync(join(checkout, 'source.txt'), 'utf8'), 'Issue and target changes.\n');
});

test('Merge asks its worker to repair an inherited browser failure and verifies the repaired commit', async (t) => {
  const f = mergeFixture(t, {
    beforeVerify({ checkout }) {
      if (readFileSync(join(checkout, 'source.txt'), 'utf8') === 'Initial source.\n')
        throw Object.assign(Error('Closure waited for background resource checks.'), { verificationFailure: true });
    },
  });
  await f.run('understand');
  const turn = f.connection.turn.bind(f.connection);
  let repairs = 0;
  f.connection.turn = async (...args) => {
    const [, checkout, prompt] = args;
    assert.match(prompt, /repair inherited test failures/);
    assert.match(prompt, /Closure waited for background resource checks/);
    repairs++;
    writeFileSync(join(checkout, 'source.txt'), 'Browser scenario repaired.\n');
    execFileSync('git', ['-C', checkout, 'commit', '-am', 'Repair inherited browser failure']);
    return turn(...args);
  };
  const result = await f.run('merge');
  assert.equal(repairs, 1);
  assert.ok(result.result.mergeConfirmation);
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['verify', 'push', 'ready']
  );
});

test('external merge reconciliation records GitHub facts without manufacturing verification or acceptance', async (t) => {
  const f = mergeFixture(t, { merged: true });
  await f.run('understand');
  const result = await f.run('merge');
  assert.equal(result.result.alreadyMerged, true);
  assert.equal(result.result.revision, 'actual-merge');
  assert.match(result.summary, /Acceptance remains separate/);
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['ready']
  );
});

async function branchUpdateFixture(t, targetFile = 'incoming.txt') {
  const f = fixture(t);
  f.git('remote', 'add', 'origin', f.root);
  await f.run('understand');
  const { checkout } = f.flow.workspace;
  return {
    ...f,
    checkout,
    work: (...args) => f.git('-C', checkout, ...args),
    advance() {
      writeFileSync(join(f.root, targetFile), 'Incoming change.\n');
      f.git('add', targetFile);
      f.git('commit', '-m', 'Advance destination');
      return f.git('rev-parse', 'HEAD');
    },
  };
}

test('Update Branch fetches first and silently saves full local changes only when behind', async (t) => {
  const f = await branchUpdateFixture(t);
  const initialHead = f.work('rev-parse', 'HEAD');
  writeFileSync(join(f.checkout, 'source.txt'), 'Staged change.\n');
  f.work('add', 'source.txt');
  writeFileSync(join(f.checkout, 'source.txt'), 'Working copy.\n');
  writeFileSync(join(f.checkout, 'draft.txt'), 'New file.\n');
  const current = await f.run('update-branch');
  assert.equal(readFileSync(current.artifacts.files.mergeMessage.path, 'utf8'), 'Already up to date.\n');
  assert.equal(f.work('rev-parse', 'HEAD'), initialHead);
  assert.equal(f.work('show', ':source.txt'), 'Staged change.');
  assert.equal(f.work('ls-files', '--others', '--exclude-standard'), 'draft.txt');

  const target = f.advance();
  const updated = await f.run('update-branch');
  assert.equal(f.work('merge-base', 'HEAD', target), target);
  assert.equal(f.work('show', 'HEAD:source.txt'), 'Working copy.');
  assert.equal(f.work('show', 'HEAD:draft.txt'), 'New file.');
  assert.equal(f.work('status', '--porcelain'), '');
  assert.equal(
    readFileSync(updated.artifacts.files.mergeMessage.path, 'utf8').trim(),
    f.work('show', '-s', '--format=%B')
  );
});

test('Update Branch uses the local starting branch upstream independently of Destination', async (t) => {
  const f = await branchUpdateFixture(t);
  const base = f.work('rev-parse', 'HEAD');
  f.git('branch', 'local-start', base);
  f.flow.startingPoint = { ref: 'refs/heads/local-start', name: 'local-start', commit: base };
  f.flow.destination = { branch: 'unrelated-destination' };
  const target = f.advance();
  await assert.rejects(f.run('update-branch'), /starting branch has no remote upstream/);
  assert.equal(f.work('rev-parse', 'HEAD'), base);
  f.git('fetch', 'origin', 'dev');
  f.git('branch', '--set-upstream-to=origin/dev', 'local-start');
  const updated = await f.run('update-branch');
  assert.deepEqual(updated.result, {
    upstream: 'origin/dev',
    fetchedCommit: target,
    head: target,
    containsFetchedCommit: true,
  });
  assert.match(readFileSync(updated.artifacts.files.mergeMessage.path, 'utf8'), /^Fast-forwarded to /);
});

test('Update Branch stops before merging when a normal Git hook rejects the local commit', async (t) => {
  const f = await branchUpdateFixture(t);
  f.advance();
  const head = f.work('rev-parse', 'HEAD');
  const hooks = join(f.root, '.git', 'hooks');
  f.git('config', 'core.hooksPath', hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho fixture-rejected >&2\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(f.checkout, 'source.txt'), 'Keep this work.\n');
  await assert.rejects(f.run('update-branch'), /fixture-rejected/);
  assert.equal(f.work('rev-parse', 'HEAD'), head);
  assert.equal(f.work('show', ':source.txt'), 'Keep this work.');
  assert.equal(existsSync(join(f.checkout, 'incoming.txt')), false);
});

test('Update Branch formats local changes before running the save commit hook', async (t) => {
  const f = await branchUpdateFixture(t);
  const target = f.advance();
  const formatter = resolve('node_modules/.bin/vp');
  const hooks = join(f.root, '.git', 'hooks');
  f.git('config', 'core.hooksPath', hooks);
  mkdirSync(join(f.checkout, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(f.root, '.git/info/exclude'), 'node_modules/\n');
  writeFileSync(
    join(f.checkout, 'node_modules/.bin/vp'),
    `#!${process.execPath}\nrequire('node:child_process').execFileSync(${JSON.stringify(formatter)}, process.argv.slice(2), { stdio: 'inherit' });\n`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(hooks, 'pre-commit'),
    [
      '#!/bin/sh',
      'if git diff --cached --name-only | grep -qx settings.json; then',
      '  test "$(git show :settings.json)" = \'{ "ready": true }\'',
      'fi',
    ].join('\n') + '\n',
    { mode: 0o755 }
  );
  writeFileSync(join(f.checkout, 'package.json'), '{"name":"branch-update-fixture","private":true}\n');
  writeFileSync(join(f.checkout, 'settings.json'), '{"ready":true}\n');
  await f.run('update-branch');
  assert.equal(f.work('show', 'HEAD:settings.json'), '{ "ready": true }');
  assert.equal(f.work('merge-base', 'HEAD', target), target);
});

for (const resolves of [true, false]) {
  test(`Update Branch gives Codex one conflict attempt and ${resolves ? 'commits the resolution' : 'retains the merge'}`, async (t) => {
    const f = await branchUpdateFixture(t, 'source.txt');
    const target = f.advance();
    writeFileSync(join(f.checkout, 'source.txt'), 'Local change.\n');
    const turn = f.connection.turn.bind(f.connection);
    let attempts = 0;
    f.connection.turn = async (...args) => {
      attempts++;
      assert.equal(args[1], f.checkout);
      assert.match(args[2], /only these conflicted paths.*source.txt/);
      if (!resolves) return 'Decision needed.\n\n```flow-result\n{"failure":"Choose a default."}\n```';
      writeFileSync(join(f.checkout, 'source.txt'), 'Local change.\nIncoming change.\n');
      f.work('add', 'source.txt');
      return turn(...args);
    };
    if (resolves) {
      await f.run('update-branch');
      assert.equal(f.work('rev-parse', 'HEAD^2'), target);
      assert.equal(f.work('show', 'HEAD:source.txt'), 'Local change.\nIncoming change.');
      assert.equal(f.work('status', '--porcelain'), '');
    } else {
      await assert.rejects(f.run('update-branch'), /Files to review: source.txt.*Choose a default/);
      assert.equal(f.work('rev-parse', 'MERGE_HEAD'), target);
      assert.equal(f.work('show', 'HEAD:source.txt'), 'Local change.');
      await assert.rejects(f.run('update-branch'), /already in progress.*source.txt/);
      f.work('merge', '--abort');
      assert.equal(f.work('show', 'HEAD:source.txt'), 'Local change.');
    }
    assert.equal(attempts, 1);
  });
}

test('new-flow deletion passes its actual checkout through the unchanged protected cleanup adapter', async (t) => {
  const calls = [];
  const f = fixture(t, {
    async deleteWorktree(service, input) {
      calls.push(input);
      assert.equal(service.lifecycleRuns[input.issueId].work.checkout, f.flow.workspace.checkout);
      return input.expected
        ? { deleted: true }
        : { path: f.flow.workspace.checkout, branch: f.flow.workspace.branch, revision: f.flow.workspace.base };
    },
  });
  await f.run('understand');
  const result = await f.run('delete-worktree');
  assert.equal(result.result.deleted, true);
  assert.equal(calls.length, 2);
  assert.equal(f.service.lifecycleRuns[f.issue.id].work, undefined);
});

test('the running block uses a local ownership view while global legacy guards keep seeing its claim', async (t) => {
  const f = fixture(t);
  const own = { attemptId: 'currently-owned' };
  f.service.flows = {
    active: new Map([
      [f.issue.id, own],
      ['another-issue', { attemptId: 'other' }],
    ]),
  };
  await f.run('understand');
  assert.equal(f.service.flows.active.get(f.issue.id), own);
  assert.equal(f.service.flows.active.size, 2);
});

test('unconfirmed provider input and accepted disconnect keep checkout ownership uncertain', async (t) => {
  const input = fixture(t);
  input.connection.turn = async () => {
    input.emit({ method: 'ui/approval', params: { threadId: 'the-one-issue-chat', requestId: 'permission' } });
    return new Promise(() => {});
  };
  input.connection.interrupt = async () => {
    throw Error('Connection lost before interruption was confirmed.');
  };
  await assert.rejects(input.run('understand'), (error) => error.uncertain === true);
  const disconnected = fixture(t);
  disconnected.connection.turn = async (...args) => {
    args[6].accepted({ threadId: 'the-one-issue-chat', turnId: 'accepted-turn' });
    throw Error('Codex disconnected while the original turn remained active.');
  };
  await assert.rejects(disconnected.run('understand'), (error) => error.uncertain === true);
});

test('the next explicit block turn receives retained user feedback', async (t) => {
  const f = fixture(t);
  await f.run('prototype', { comments: [{ id: 'feedback', text: 'Keep the save control visible while scrolling.' }] });
  assert.match(f.calls.find((call) => call.method === 'turn').prompt, /Keep the save control visible while scrolling/);
});

test('retained blocked and completed legacy claims require reconciliation before a new flow writer', async (t) => {
  for (const status of ['blocked', 'completed']) {
    const f = fixture(t);
    writeFileSync(
      join(f.root, '.issues/factory.json'),
      JSON.stringify({ version: 1, actions: [{ id: 'retained', issues: [f.issue.id], status }] })
    );
    await assert.rejects(f.run('verify'), /legacy assignment still owns/);
    assert.equal(f.calls.length, 0);
  }
});
