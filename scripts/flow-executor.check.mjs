import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFlowExecutor } from './factory-ui/flow-executor.mjs';
import { digest } from './factory-ui/common.mjs';
import { conversationMessages, conversationState, conversationFiles } from './factory-ui/conversation-store.mjs';
import { resumeWorkDependencies, runWorkVerification } from './factory-ui/flow-verification.mjs';

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
      definition: changes.definition,
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

test('dependency recovery retains DNS diagnostics across interruption and resumes within its retry bound', async (t) => {
  const f = fixture(t);
  const checkout = join(f.root, 'saved-issue-checkout');
  mkdirSync(checkout);
  const lock = 'lockfileVersion: 9.0\n';
  writeFileSync(join(checkout, 'pnpm-lock.yaml'), lock);
  const workspace = { checkout };
  const folder = join(f.root, 'attempt-evidence');
  const first = new AbortController();
  const initial = {
    signal: first.signal,
    onProgress() {},
  };
  await assert.rejects(
    runWorkVerification(initial, { ...workspace, base: 'base' }, folder, async ({ log }) => {
      first.abort();
      mkdirSync(folder, { recursive: true });
      writeFileSync(log, 'registry DNS lookup failed: ENOTFOUND');
      throw Error('registry DNS lookup failed: ENOTFOUND');
    }),
    /ENOTFOUND/
  );
  const recoveryPath = join(checkout, '.issues/evidence/dependency-recovery.json');
  const interrupted = JSON.parse(readFileSync(recoveryPath, 'utf8'));
  assert.equal(interrupted.attempts.length, 1);
  assert.equal(interrupted.attempts[0].status, 'interrupted');
  assert.match(interrupted.attempts[0].diagnostic, /ENOTFOUND/);
  assert.ok(existsSync(interrupted.attempts[0].log));

  let installs = 0;
  await resumeWorkDependencies(
    { signal: new AbortController().signal, onProgress() {} },
    workspace,
    folder,
    async (input) => {
      assert.deepEqual(input.args, ['install', '--frozen-lockfile']);
      installs += 1;
      if (installs === 1) throw Error('registry DNS lookup failed: EAI_AGAIN');
      mkdirSync(join(checkout, 'node_modules/.pnpm'), { recursive: true });
      writeFileSync(join(checkout, 'node_modules/.pnpm/lock.yaml'), lock);
      writeFileSync(input.log, 'Install completed.');
    }
  );
  const recovered = JSON.parse(readFileSync(recoveryPath, 'utf8'));
  assert.equal(installs, 2);
  assert.equal(recovered.retryLimit, 3);
  assert.equal(recovered.attempts.length, 3);
  assert.equal(recovered.attempts[1].status, 'failed');
  assert.equal(recovered.attempts[2].status, 'passed');
  assert.equal(recovered.status, 'ready');
  assert.match(recovered.recovery, /dependencyPreflight confirmed/);
  assert.match(recovered.attempts[1].diagnostic, /EAI_AGAIN/);
});

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
      '{"files":{"proof":".issues/observed-proof.txt"},"focusedTests":[["node","--test","scripts/folder-operations.check.mjs"]]}',
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
  assert.deepEqual(result.result.focusedTests, [['node', '--test', 'scripts/folder-operations.check.mjs']]);
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

test('Work continues in the same conversation until its checked changes are committed', async (t) => {
  let checks = 0;
  const f = fixture(t, {
    async verifyWork(_ctx, workspace) {
      if (++checks === 1) writeFileSync(join(workspace.checkout, 'source.txt'), 'Checked candidate.\n');
      return { evidence: [] };
    },
  });
  const turn = f.connection.turn.bind(f.connection);
  let turns = 0;
  f.connection.turn = async (...args) => {
    if (++turns === 2) {
      assert.match(args[2], /commit/i);
      f.git('-C', args[1], 'commit', '-am', 'Commit checked changes');
    }
    return turn(...args);
  };
  const worked = await f.run('work');
  assert.equal(turns, 2);
  assert.equal(checks, 2);
  const conversations = f.calls.filter(({ method }) => method === 'turn').map(({ threadId }) => threadId);
  assert.equal(new Set(conversations).size, 1);
  assert.equal(worked.result.base, worked.workspace.base);
  assert.equal(worked.result.commit, worked.result.head);
  assert.equal(worked.result.tree, f.git('-C', worked.workspace.checkout, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(worked.result.uncommitted, false);
  assert.equal(worked.artifacts.values.candidateTree, worked.result.tree);
  assert.equal(worked.artifacts.values.candidateCommit, worked.result.commit);
  assert.equal(worked.artifacts.values.candidateUncommitted, false);
});

test('Work cannot complete while checked changes remain uncommitted', async (t) => {
  const f = fixture(t, {
    async verifyWork(_ctx, workspace) {
      writeFileSync(join(workspace.checkout, 'new-source.txt'), 'Uncommitted candidate.\n');
      return { evidence: [] };
    },
  });
  await assert.rejects(f.run('work'), /unfinished steps after 3 continuations.*[Cc]ommit/);
  assert.equal(f.calls.filter(({ method }) => method === 'turn').length, 4);
  assert.equal(readFileSync(join(f.flow.workspace.checkout, 'new-source.txt'), 'utf8'), 'Uncommitted candidate.\n');
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

test('investigations inspect committed snapshots, retain proof, and remove temporary files without Git worktrees', async (t) => {
  const f = fixture(t);
  f.flow.routeType = 'investigation';
  const refs = f.git('show-ref');
  const worktrees = f.git('worktree', 'list', '--porcelain');
  const source = f
    .git('ls-files')
    .split('\n')
    .find((name) => name && !name.startsWith('.'));
  const original = readFileSync(join(f.root, source), 'utf8');
  writeFileSync(join(f.root, source), 'uncommitted source');
  f.connection.turn = async (_id, cwd) => {
    assert.equal(readFileSync(join(cwd, source), 'utf8'), original);
    assert.equal(f.git('worktree', 'list', '--porcelain'), worktrees);
    writeFileSync(join(cwd, 'diagnostic.txt'), 'Diagnostic proof');
    return (
      'Observed findings.\n```flow-result\n' +
      JSON.stringify({ files: { log: 'diagnostic.txt' }, values: {} }) +
      '\n```'
    );
  };
  const result = await f.run('understand', {
    definition: {
      usable: true,
      prompt: 'Investigate only.',
      artifacts: [
        { key: 'response', kind: 'file', label: 'Block response' },
        { key: 'log', kind: 'file', label: 'Diagnostic log' },
      ],
    },
  });
  const snapshot = f.calls.find(({ method }) => method === 'start').cwd;
  assert.equal(existsSync(snapshot), false);
  assert.equal(readFileSync(result.artifacts.files.log.path, 'utf8'), 'Diagnostic proof');
  assert.equal(readFileSync(join(f.root, source), 'utf8'), 'uncommitted source');
  assert.equal(f.git('show-ref'), refs);
  assert.equal(f.git('worktree', 'list', '--porcelain'), worktrees);
  assert.equal(f.flow.workspace, null);
  assert.equal(result.workspace, undefined);
});

test('failed investigation removes its temporary snapshot and retains its response evidence', async (t) => {
  const f = fixture(t);
  f.flow.routeType = 'investigation';
  f.connection.turn = async () => {
    throw Object.assign(Error('Diagnostic failed'), { terminalStatus: 'failed', partialText: 'Partial finding' });
  };
  await assert.rejects(f.run('understand'), /Diagnostic failed/);
  const snapshot = f.calls.find(({ method }) => method === 'start').cwd;
  assert.equal(existsSync(snapshot), false);
  assert.equal(f.flow.workspace, null);
  assert.match(
    readFileSync(join(f.root, '.issues/factory-ui/flow-evidence/attempt-1/output.txt'), 'utf8'),
    /Partial finding/
  );
});

test('read-only Understand is told that Factory retains its response without a writable proof file', async (t) => {
  const f = fixture(t);
  const result = await f.run('understand');
  const start = f.calls.find(({ method }) => method === 'start');
  assert.equal(start.sandbox, 'read-only');
  assert.match(start.instructions, /Factory automatically saves your final response/);
  assert.match(start.instructions, /do not need to create a proof file/i);
  assert.match(
    f.calls.find(({ method }) => method === 'turn').prompt,
    /Factory automatically saves your final response/
  );
  assert.equal(existsSync(result.artifacts.files.response.path), true);
});

test('Understand receives retained source publication attempts from the coordinator instead of its empty checkout', async (t) => {
  const f = fixture(t);
  f.issue.source_issue = 'original-issue';
  mkdirSync(join(f.root, '.issues/closed'), { recursive: true });
  writeFileSync(
    join(f.root, '.issues/closed/original-issue.md'),
    '---\nid: original-issue\ntitle: Publication problem\nstate: closed\n---\nOriginal request.\n'
  );
  mkdirSync(join(f.root, '.issues/flows/original-issue'), { recursive: true });
  const responsePath = join(f.root, '.issues/factory-ui/flow-evidence/original-attempt/github-response.json');
  mkdirSync(join(f.root, '.issues/factory-ui/flow-evidence/original-attempt'), { recursive: true });
  const responseBody = JSON.stringify({ status: 422, response: { message: 'Validation Failed' } });
  writeFileSync(responsePath, responseBody);
  writeFileSync(
    join(f.root, '.issues/flows/original-issue/flow.json'),
    JSON.stringify({
      blocks: [
        {
          kind: 'publish',
          attempts: [
            {
              id: 'original-attempt',
              startedAt: '2026-11-17T14:00:20.609Z',
              status: 'blocked',
              summary: 'GitHub request failed (HTTP 422).',
              details: [{ key: 'candidateCommit', value: 'candidate-revision' }],
              result: { head: 'pushed-revision' },
              evidence: [{ key: 'githubResponse', path: responsePath, sha256: digest(responseBody) }],
            },
          ],
        },
      ],
    })
  );
  const result = await f.run('understand');
  const input = JSON.parse(f.calls.find(({ method }) => method === 'turn').prompt);
  assert.equal(input.sourceIssue.issueId, 'original-issue');
  assert.equal(input.sourceIssue.attempts[0].id, 'original-attempt');
  assert.equal(input.sourceIssue.attempts[0].result.head, 'pushed-revision');
  assert.equal(input.sourceIssue.attempts[0].githubResponse.status, 422);
  const proof = result.evidence.find(({ key }) => key === 'sourceIssue');
  assert.equal(JSON.parse(readFileSync(proof.path, 'utf8')).attempts[0].details[0].value, 'candidate-revision');
  assert.equal(existsSync(join(result.workspace.checkout, '.issues/closed/original-issue.md')), false);
  writeFileSync(responsePath, 'Changed after retention');
  f.issue.source_attempt = 'original-attempt';
  await f.run('understand');
  const changed = JSON.parse(f.calls.findLast(({ method }) => method === 'turn').prompt);
  assert.match(changed.sourceIssue.attempts[0].githubResponse.unavailable, /changed or lacks a digest/);
  assert.equal(changed.sourceIssue.attemptId, 'original-attempt');
  f.issue.source_attempt = 'not-a-source-attempt';
  await f.run('understand');
  const selected = JSON.parse(f.calls.findLast(({ method }) => method === 'turn').prompt);
  assert.match(selected.sourceIssue.unavailable, /recorded source attempt is unavailable/);
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
      if (installWorkspace)
        mkdirSync(join(checkout, 'packages/example/node_modules'), {
          recursive: true,
        });
    }
    const f = fixture(t, {
      async execute(input) {
        executions.push(input);
        writeFileSync(input.log, 'Fixture command result.');
        if (input.command === 'pnpm') return installFixture(input.cwd);
        return (
          'FLOW_RESULT ' +
          JSON.stringify({
            head: 'fixture-head',
            tree: 'fixture-tree',
            summaries: [],
          })
        );
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
  const git = (...args) =>
    execFileSync('git', ['-C', workspace.checkout, ...args], {
      encoding: 'utf8',
    }).trim();
  mkdirSync(folder, { recursive: true });
  const proof = ['verification', 'step'].map((checkpoint) => {
    const path = join(folder, checkpoint + '.json');
    writeFileSync(path, JSON.stringify({ checkpoint }));
    return { path, sha256: digest(readFileSync(path)) };
  });
  return {
    head: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    base: workspace.base,
    proof,
  };
}

function mergeFixture(
  t,
  { merged = false, onWait, repair, beforeVerify, onGit, onReady, onLookup, onMerge, onInspect, github } = {}
) {
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
      onGit?.(args);
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
      async gh(args) {
        if (github) return github(args);
        return JSON.stringify({ data: { repository: { pullRequest: {} } } });
      },
      async findIssueBranchPR(branch) {
        await onLookup?.();
        return pullRequest(branch);
      },
      async ready(pr, branch, head) {
        assert.equal(head, pr.head.sha);
        observations.push({ operation: 'ready', head });
        await onReady?.(pr, branch, head);
        return {
          head,
          merged,
          target: f.git('rev-parse', 'dev'),
          ...(merged ? { merge: { revision: 'actual-merge', url: 'https://example.invalid/pr/9' } } : {}),
        };
      },
      async inspect() {
        await onInspect?.();
        return pullRequest();
      },
      async merge(_number, head, { beforeMerge }) {
        await beforeMerge();
        await onMerge?.(() => {
          merged = true;
        });
        observations.push({ operation: 'merge', head });
        return {
          revision: 'actual-merge',
          url: 'https://example.invalid/pr/9',
        };
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

const humanFirstMerge = {
  definition: { mergeWorkflow: { policy: 'human-first', pollSeconds: 5, checkTimeoutSeconds: 900, repairAttempts: 3 } },
};

function approveMerge(f, result) {
  return f.run('merge', {
    ...humanFirstMerge,
    attempts: [approvalAttempt(result)],
    continuing: true,
    input: { confirmed: true, mergeToken: result.result.mergeConfirmation.token },
  });
}

test('Merge verifies an unchanged PR once and requires approval of its exact commit and target', async (t) => {
  const f = mergeFixture(t);
  await f.run('understand');
  const first = await f.run('merge', humanFirstMerge);
  assert.equal(first.status, 'blocked');
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['ready', 'verify']
  );
  const result = await approveMerge(f, first);
  assert.equal(result.result.revision, 'actual-merge');
  assert.equal(result.workspace.pr, 9);
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['ready', 'verify', 'ready', 'ready', 'merge']
  );
  assert.equal(f.calls.filter((item) => item.method === 'guard').at(-1).args[2], 'merge');
});

test('overnight prepare verifies the PR and stops before automatic merge', async (t) => {
  const f = mergeFixture(t);
  await f.run('understand');
  const result = await f.run('merge', {
    definition: { mergeWorkflow: { ...humanFirstMerge.definition.mergeWorkflow, policy: 'automatic' } },
    input: { prepareMerge: true, confirmed: true },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.result.mergeConfirmation.pr, 9);
  assert.equal(result.result.verification.head, result.result.mergeConfirmation.head);
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['ready', 'verify']
  );
  assert.equal(
    f.calls.some((item) => item.method === 'guard' && item.args[2] === 'merge'),
    false
  );
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
  const first = await f.run('merge', humanFirstMerge);
  assert.equal(first.status, 'blocked');
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['ready', 'verify', 'push', 'ready', 'verify', 'push', 'ready']
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
  assert.equal(result.result.revision, 'actual-merge');
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['ready', 'ready', 'verify', 'push', 'ready', 'ready', 'merge']
  );
  assert.equal(issueGit('merge-base', 'HEAD', 'dev'), f.git('rev-parse', 'dev'));
  assert.equal(readFileSync(join(checkout, 'source.txt'), 'utf8'), 'Issue and target changes.\n');
});

test('Merge asks its worker to repair an inherited browser failure and verifies the repaired commit', async (t) => {
  const f = mergeFixture(t, {
    beforeVerify({ checkout }) {
      if (readFileSync(join(checkout, 'source.txt'), 'utf8') === 'Initial source.\n') {
        const folder = join(f.root, '.issues/failed-merge');
        mkdirSync(folder, { recursive: true });
        const log = join(folder, 'browser.log');
        const summary = join(folder, 'summary.json');
        writeFileSync(log, 'AssertionError: Only explicit Send starts a reply\n');
        writeFileSync(
          summary,
          JSON.stringify({
            checks: [
              { name: 'build', passed: true },
              { name: 'browser', passed: false, exit: 1, log },
            ],
          })
        );
        throw Object.assign(Error('Closure waited for background resource checks.'), {
          verificationFailure: { summaries: [summary], logs: [log] },
          evidence: [{ path: summary, label: 'Verification summary' }],
        });
      }
    },
  });
  await f.run('understand');
  const turn = f.connection.turn.bind(f.connection);
  let repairs = 0;
  f.connection.turn = async (...args) => {
    const [, checkout, prompt] = args;
    assert.match(prompt, /repair inherited test failures/);
    assert.match(prompt, /Closure waited for background resource checks/);
    const repairInput = JSON.parse(prompt);
    for (const item of repairInput.evidence) {
      assert.ok(item.path.startsWith(checkout + '/'), 'Repair evidence must be readable inside the issue checkout');
      assert.ok(existsSync(item.path));
    }
    const failed = repairInput.failedChecks.find((check) => check.name === 'browser');
    assert.equal(failed.exit, 1);
    assert.match(readFileSync(failed.log, 'utf8'), /Only explicit Send starts a reply/);
    repairs++;
    writeFileSync(join(checkout, 'source.txt'), 'Browser scenario repaired.\n');
    execFileSync('git', ['-C', checkout, 'commit', '-am', 'Repair inherited browser failure']);
    return turn(...args);
  };
  const result = await f.run('merge');
  assert.equal(repairs, 1);
  assert.equal(result.result.revision, 'actual-merge');
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['ready', 'ready', 'verify', 'push', 'ready', 'ready', 'merge']
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
  test(`Update Branch ${resolves ? 'commits a resolved conflict' : 'retains the merge after three failed conflict attempts'}`, async (t) => {
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
      await assert.rejects(f.run('update-branch'), /Files to review: source.txt.*Choose a default/);
      assert.equal(f.work('rev-parse', 'MERGE_HEAD'), target);
      f.work('merge', '--abort');
      assert.equal(f.work('show', 'HEAD:source.txt'), 'Local change.');
    }
    assert.equal(attempts, resolves ? 1 : 6);
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

test('Stop removes an investigation snapshot after the provider acknowledges interruption', async (t) => {
  const f = fixture(t);
  f.flow.routeType = 'investigation';
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const turn = Promise.withResolvers();
  f.connection.turn = async () => {
    started.resolve();
    return turn.promise;
  };
  f.connection.interrupt = async () => {
    turn.reject(Object.assign(Error('Stopped diagnostic'), { terminalStatus: 'interrupted' }));
  };
  const running = f.run('understand', { signal: controller.signal });
  await started.promise;
  controller.abort();
  await assert.rejects(running, /Stopped diagnostic|stopped/);
  const snapshot = f.calls.find(({ method }) => method === 'start').cwd;
  assert.equal(existsSync(snapshot), false);
  assert.equal(f.flow.workspace, null);
});

test('investigation skills use the project catalog and preserve the investigation instructions and model settings', async (t) => {
  const f = fixture(t);
  f.flow.routeType = 'investigation';
  f.flow.executionSettings = { values: { skill: 'sample', model: 'gpt-6.1-sol', effort: 'high' } };
  await f.run('understand', { skillExplicit: false, prompt: 'Inspect validation and retain historical findings.' });
  const catalog = f.calls.find(({ method }) => method === 'skills/list');
  assert.deepEqual(catalog.params.cwds, [f.root]);
  const turn = f.calls.find(({ method }) => method === 'turn');
  assert.equal(turn.skills.length, 1);
  assert.equal(turn.settings.effort, 'high');
  assert.match(
    f.calls.find(({ method }) => method === 'start').instructions,
    /Inspect validation and retain historical findings/
  );
});

test('Work recovers a local-listener permission refusal in the same chat before recording missing proof', async (t) => {
  const f = fixture(t);
  const original = f.connection.turn;
  let attempts = 0;
  f.connection.turn = async (...args) => {
    await original(...args);
    attempts++;
    return attempts === 1
      ? '```flow-result\n{"failure":"Requested proof unavailable: node scripts/flow-browser.mjs --project-discuss failed with listen EPERM on 127.0.0.1."}\n```'
      : 'The permission-enabled check passed and collected proof.\n```flow-result\n{"focusedTests":[]}\n```';
  };
  const result = await f.run('work');
  const turns = f.calls.filter(({ method }) => method === 'turn');
  assert.equal(turns.length, 2);
  assert.equal(turns[1].threadId, turns[0].threadId);
  assert.equal(turns[1].cwd, turns[0].cwd);
  assert.match(turns[1].prompt, /require_escalated/);
  assert.match(turns[1].prompt, /denied/i);
  assert.notEqual(result.status, 'blocked');
});

test('Work bounds repeated unfinished-check responses and retains their reason', async (t) => {
  const f = fixture(t);
  const original = f.connection.turn;
  f.connection.turn = async (...args) => {
    await original(...args);
    return '```flow-result\n{"failure":"The local server cannot start: listen EPERM on 127.0.0.1."}\n```';
  };
  await assert.rejects(f.run('work'), /unfinished steps after 3 continuations.*listen EPERM/);
  assert.equal(f.calls.filter(({ method }) => method === 'turn').length, 4);
});

test('Work respects an explicit denial of the native local-server permission request', async (t) => {
  const f = fixture(t);
  const original = f.connection.turn;
  f.connection.turn = async (...args) => {
    await original(...args);
    return '```flow-result\n{"failure":"The native permission request was denied. The local check failed with listen EPERM on 127.0.0.1."}\n```';
  };
  const result = await f.run('work');
  assert.equal(f.calls.filter(({ method }) => method === 'turn').length, 1);
  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /denied/);
});

test('Work stops when native permission requests are unavailable', async (t) => {
  const f = fixture(t);
  const original = f.connection.turn;
  f.connection.turn = async (...args) => {
    await original(...args);
    return '```flow-result\n{"failure":"Native permission requests are unavailable in this session. The check failed with listen EPERM on 127.0.0.1."}\n```';
  };
  const result = await f.run('work');
  assert.equal(f.calls.filter(({ method }) => method === 'turn').length, 1);
  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /unavailable/);
});

test('Work completes ordinary unfinished proof collection in the same run', async (t) => {
  let checks = 0;
  const f = fixture(t, {
    verifyWork: async () => {
      checks++;
      return { evidence: [] };
    },
  });
  const original = f.connection.turn;
  let turns = 0;
  f.connection.turn = async (...args) => {
    await original(...args);
    turns++;
    if (turns === 1)
      return '```flow-result\n{"failure":"Computed-style proof for the message divider was not collected; the focused browser check passed."}\n```';
    const folder = join(args[1], '.issues');
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'rendered-style.json'),
      JSON.stringify({ borderBottomStyle: 'none', borderBottomWidth: '0px' })
    );
    return 'Rendered border styles collected.\n```flow-result\n{"files":{"proof":".issues/rendered-style.json"},"focusedTests":[]}\n```';
  };
  const result = await f.run('work');
  const calls = f.calls.filter(({ method }) => method === 'turn');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].threadId, calls[1].threadId);
  assert.equal(calls[0].cwd, calls[1].cwd);
  assert.match(calls[1].prompt, /Continue|continue/);
  assert.notEqual(result.status, 'blocked');
  assert.equal(checks, 1);
  assert.equal(JSON.parse(readFileSync(result.artifacts.files.proof.path)).borderBottomWidth, '0px');
});

test('Work stops for a concrete human decision instead of continuing that decision itself', async (t) => {
  const f = fixture(t);
  const original = f.connection.turn;
  f.connection.turn = async (...args) => {
    await original(...args);
    return '```flow-result\n{"failure":"Choose which conflicting behavior to preserve.","blocker":"human-input"}\n```';
  };
  const result = await f.run('work');
  assert.equal(f.calls.filter(({ method }) => method === 'turn').length, 1);
  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /Choose which/);
});

test('unfinished Work continuations leave the full check-repair budget available', async (t) => {
  let checks = 0;
  const f = fixture(t, {
    async verifyWork() {
      checks++;
      if (checks <= 3) throw Object.assign(Error('Fix the required check'), { verificationFailure: true });
      return { evidence: [] };
    },
  });
  const turn = f.connection.turn.bind(f.connection);
  let turns = 0;
  f.connection.turn = async (...args) => {
    turns++;
    if (turns <= 3) return '```flow-result\n{"failure":"Requested measurement is still unfinished."}\n```';
    return turn(...args);
  };
  await f.run('work');
  assert.equal(turns, 7);
  assert.equal(checks, 4);
});

test('Update Branch aborts a pending merge before fetching and merging the latest starting branch', async (t) => {
  const f = await branchUpdateFixture(t, 'source.txt');
  const oldTarget = f.advance();
  writeFileSync(join(f.checkout, 'source.txt'), 'Issue implementation.\n');
  f.work('commit', '-am', 'Preserve issue implementation');
  const saved = f.work('rev-parse', 'HEAD');
  assert.throws(() => f.work('merge', '--no-edit', oldTarget));
  writeFileSync(join(f.checkout, 'draft.txt'), 'Keep this draft.\n');
  writeFileSync(join(f.root, 'source.txt'), 'Latest starting branch change.\n');
  f.git('commit', '-am', 'Advance starting branch again');
  const latest = f.git('rev-parse', 'HEAD');
  const turn = f.connection.turn.bind(f.connection);
  let repairs = 0;
  f.connection.turn = async (...args) => {
    repairs++;
    assert.equal(f.work('rev-parse', 'MERGE_HEAD'), latest);
    writeFileSync(join(f.checkout, 'source.txt'), 'Issue implementation.\nLatest starting branch change.\n');
    f.work('add', 'source.txt');
    return turn(...args);
  };
  await f.run('update-branch');
  assert.equal(repairs, 1);
  assert.equal(f.work('merge-base', 'HEAD', latest), latest);
  assert.equal(f.work('merge-base', 'HEAD', saved), saved);
  assert.equal(f.work('show', 'HEAD:draft.txt'), 'Keep this draft.');
  assert.equal(f.work('status', '--porcelain'), '');
});

test('Update Branch leaves an unfinished cherry-pick intact', async (t) => {
  const f = await branchUpdateFixture(t, 'source.txt');
  const incoming = f.advance();
  writeFileSync(join(f.checkout, 'source.txt'), 'Issue implementation.\n');
  f.work('commit', '-am', 'Preserve issue implementation');
  const saved = f.work('rev-parse', 'HEAD');
  assert.throws(() => f.work('cherry-pick', incoming));
  await assert.rejects(f.run('update-branch'), /Git operation already in progress/);
  assert.equal(f.work('rev-parse', 'CHERRY_PICK_HEAD'), incoming);
  assert.equal(f.work('rev-parse', 'HEAD'), saved);
  assert.equal(f.work('diff', '--name-only', '--diff-filter=U'), 'source.txt');
});

test('a new Merge run aborts a leftover local merge before synchronizing its target', async (t) => {
  const commands = [];
  const f = mergeFixture(t, { onGit: (args) => commands.push(args) });
  await f.run('understand');
  const { checkout } = f.flow.workspace;
  const work = (...args) => f.git('-C', checkout, ...args);
  writeFileSync(join(checkout, 'source.txt'), 'Issue implementation.\n');
  work('commit', '-am', 'Issue implementation');
  const saved = work('rev-parse', 'HEAD');
  writeFileSync(join(f.root, 'source.txt'), 'Target implementation.\n');
  f.git('commit', '-am', 'Target implementation');
  assert.throws(() => work('merge', '--no-edit', 'dev'));
  const turn = f.connection.turn.bind(f.connection);
  f.connection.turn = async (...args) => {
    writeFileSync(join(checkout, 'source.txt'), 'Both implementations.\n');
    work('add', 'source.txt');
    work('commit', '--no-edit');
    return turn(...args);
  };
  const result = await f.run('merge');
  assert.equal(result.result.revision, 'actual-merge');
  assert.equal(work('merge-base', 'HEAD', saved), saved);
  assert.equal(work('status', '--porcelain'), '');
  assert.equal(commands.filter((args) => args.join(' ') === 'merge --abort').length, 1);
});

test('Update Branch shows the worker decision when its response leaves conflicts unresolved', async (t) => {
  const f = await branchUpdateFixture(t, 'source.txt');
  f.advance();
  writeFileSync(join(f.checkout, 'source.txt'), 'Issue change.\n');
  f.connection.turn = async () =>
    'Decision needed: include or exclude the installed agent tooling?\n\n```flow-result\n{"status":"failure","values":{"decision":"Choose the audit scope."}}\n```';
  await assert.rejects(f.run('update-branch'), /Decision needed: include or exclude the installed agent tooling/);
});

test('Update Branch automatically retries a failed resolution with its diagnostic and then commits', async (t) => {
  const f = await branchUpdateFixture(t, 'source.txt');
  const target = f.advance();
  writeFileSync(join(f.checkout, 'source.txt'), 'Issue edit.\n');
  let calls = 0;
  const turn = f.connection.turn.bind(f.connection);
  f.connection.turn = async (...args) => {
    if (++calls === 1) return '```flow-result\n{"failure":"First approach did not resolve the file."}\n```';
    assert.match(args[2], /attempt 2 of 3/);
    assert.match(args[2], /First approach did not resolve/);
    writeFileSync(join(f.checkout, 'source.txt'), 'Issue and target edits.\n');
    f.work('add', 'source.txt');
    return turn(...args);
  };
  await f.run('update-branch');
  assert.equal(calls, 2);
  assert.equal(f.work('rev-parse', 'HEAD^2'), target);
  assert.equal(f.work('status', '--porcelain'), '');
});

test('Update Branch stops its conflict loop for an explicit human decision', async (t) => {
  const f = await branchUpdateFixture(t, 'source.txt');
  const target = f.advance();
  writeFileSync(join(f.checkout, 'source.txt'), 'Issue edit.\n');
  let calls = 0;
  f.connection.turn = async () => {
    calls++;
    return '```flow-result\n{"failure":"Choose which behavior to preserve.","blocker":"human-input"}\n```';
  };
  await assert.rejects(f.run('update-branch'), /Choose which behavior/);
  assert.equal(calls, 1);
  assert.equal(f.work('rev-parse', 'MERGE_HEAD'), target);
});

test('Merge gives a new blocker its own repair budget and keeps verifying changed candidates', async (t) => {
  let repairs = 0;
  const f = mergeFixture(t, {
    beforeVerify() {
      if (repairs >= 4) return;
      throw Object.assign(Error(repairs < 3 ? 'First broken check' : 'Second broken check'), {
        verificationFailure: { summaries: [] },
        blockerKey: repairs < 3 ? 'first' : 'second',
      });
    },
  });
  await f.run('understand');
  const turn = f.connection.turn.bind(f.connection);
  f.connection.turn = async (...args) => {
    const checkout = f.flow.workspace.checkout;
    writeFileSync(join(checkout, 'source.txt'), 'Repair ' + ++repairs + '\n');
    f.git('-C', checkout, 'commit', '-am', 'Repair ' + repairs);
    return turn(...args);
  };
  const result = await f.run('merge');
  assert.equal(repairs, 4);
  assert.equal(result.result.revision, 'actual-merge');
});

test('Merge stops after three changed candidates fail the same blocker', async (t) => {
  let repairs = 0;
  const f = mergeFixture(t, {
    beforeVerify() {
      throw Object.assign(Error('Same broken check'), { verificationFailure: { summaries: [] }, blockerKey: 'same' });
    },
  });
  await f.run('understand');
  const turn = f.connection.turn.bind(f.connection);
  f.connection.turn = async (...args) => {
    const checkout = f.flow.workspace.checkout;
    writeFileSync(join(checkout, 'source.txt'), 'Repair ' + ++repairs + '\n');
    f.git('-C', checkout, 'commit', '-am', 'Attempt repair');
    return turn(...args);
  };
  await assert.rejects(f.run('merge'), /three|3 repair attempts for the same blocker/);
  assert.equal(repairs, 3);
});

test('Merge downloads failed GitHub verification evidence, repairs it, verifies, pushes and merges', async (t) => {
  const { assertChecks } = await import('./factory-ui/strategy-readiness.mjs');
  let failed = true,
    downloads = 0;
  const f = mergeFixture(t, {
    onReady() {
      if (failed)
        assertChecks([
          {
            __typename: 'CheckRun',
            name: 'test',
            status: 'COMPLETED',
            conclusion: 'FAILURE',
            detailsUrl: 'https://github.com/test/fixture/actions/runs/77/job/88',
          },
        ]);
    },
    async github(args) {
      if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: {} } } });
      if (args[0] === 'api')
        return JSON.stringify({ head_sha: f.git('-C', f.flow.workspace.checkout, 'rev-parse', 'HEAD') });
      assert.equal(args[1], 'download');
      downloads++;
      const folder = args[args.indexOf('--dir') + 1];
      writeFileSync(join(folder, 'browser.log'), 'AssertionError: GitHub-only browser failure\n');
      writeFileSync(
        join(folder, 'ci-summary.json'),
        JSON.stringify({
          checks: [
            { name: 'browser', passed: false, exit: 1, log: '/home/runner/work/project/.issues/evidence/browser.log' },
          ],
        })
      );
      return '';
    },
  });
  await f.run('understand');
  const turn = f.connection.turn.bind(f.connection);
  f.connection.turn = async (...args) => {
    const input = JSON.parse(args[2]);
    assert.match(input.failure, /Failed checks: test/);
    const check = input.failedChecks.find((check) => check.name === 'browser');
    assert.match(readFileSync(check.log, 'utf8'), /GitHub-only browser failure/);
    assert.ok(check.log.startsWith(f.flow.workspace.checkout));
    writeFileSync(join(f.flow.workspace.checkout, 'source.txt'), 'CI repair\n');
    f.git('-C', f.flow.workspace.checkout, 'commit', '-am', 'Repair CI failure');
    failed = false;
    return turn(...args);
  };
  const result = await f.run('merge');
  assert.equal(downloads, 1);
  assert.equal(result.result.revision, 'actual-merge');
  assert.equal(f.observations.filter(({ operation }) => operation === 'verify').length, 1);
  assert.equal(f.observations.filter(({ operation }) => operation === 'push').length, 1);
});

test('Merge stops when repairs cycle back to the same failing source tree', async (t) => {
  let repairs = 0;
  const f = mergeFixture(t, {
    beforeVerify() {
      throw Object.assign(Error('Same broken check'), { verificationFailure: { summaries: [] }, blockerKey: 'same' });
    },
  });
  await f.run('understand');
  const checkout = f.flow.workspace.checkout;
  const original = readFileSync(join(checkout, 'source.txt'), 'utf8');
  const turn = f.connection.turn.bind(f.connection);
  f.connection.turn = async (...args) => {
    writeFileSync(join(checkout, 'source.txt'), ++repairs % 2 ? 'Changed candidate\n' : original);
    f.git('-C', checkout, 'commit', '-am', 'Repair attempt');
    return turn(...args);
  };
  await assert.rejects(f.run('merge'), /same failing candidate without progress/);
  assert.equal(repairs, 2);
});

test('GitHub repair evidence rejects a run for another commit', async (t) => {
  const { retainGitHubFailure } = await import('./factory-ui/flow-ci-evidence.mjs');
  const f = fixture(t);
  const provider = {
    config: { repository: 'test/fixture' },
    async gh() {
      return JSON.stringify({ head_sha: 'other' });
    },
  };
  const error = { githubChecks: [{ url: 'https://github.com/test/fixture/actions/runs/77/job/88' }] };
  await assert.rejects(retainGitHubFailure(provider, error, 'expected', f.root), /different commit/);
});

test('GitHub repair retains failed job output when verification artifacts are unavailable', async (t) => {
  const { retainGitHubFailure } = await import('./factory-ui/flow-ci-evidence.mjs');
  const f = fixture(t);
  const provider = {
    config: { repository: 'test/fixture' },
    async gh(args) {
      if (args[0] === 'api') return JSON.stringify({ head_sha: 'expected' });
      if (args[1] === 'download') throw Error('No verification artifact was uploaded.');
      assert.equal(args[1], 'view');
      return 'AssertionError: CI test failed before evidence upload.';
    },
  };
  const error = {
    githubChecks: [{ url: 'https://github.com/test/fixture/actions/runs/77/job/88' }],
  };
  await retainGitHubFailure(provider, error, 'expected', f.root);
  assert.match(readFileSync(error.evidence[0].path, 'utf8'), /CI test failed before evidence upload/);
});

test('Merge retries temporary readiness failures before running any local checks', async (t) => {
  let requests = 0;
  const f = mergeFixture(t, {
    onReady() {
      if (++requests < 3)
        throw Object.assign(Error('GitHub connection reset'), {
          transient: true,
        });
    },
  });
  await f.run('understand');
  const result = await f.run('merge');
  assert.equal(result.result.revision, 'actual-merge');
  assert.deepEqual(
    f.observations.slice(0, 4).map(({ operation }) => operation),
    ['ready', 'ready', 'ready', 'verify']
  );
  assert.equal(f.observations.filter(({ operation }) => operation === 'verify').length, 1);
  assert.equal(f.calls.filter(({ method }) => method === 'turn').length, 1);
});

test('Merge bounds temporary lookup failures and retains the final reason without repairing tests', async (t) => {
  let requests = 0;
  const f = mergeFixture(t, {
    onLookup() {
      requests++;
      throw Object.assign(Error('GitHub gateway unavailable HTTP 503'), {
        transient: true,
      });
    },
  });
  await f.run('understand');
  await assert.rejects(f.run('merge'), /GitHub gateway unavailable HTTP 503/);
  assert.equal(requests, 4);
  assert.deepEqual(f.observations, []);
  assert.equal(f.calls.filter(({ method }) => method === 'turn').length, 1);
});

test('Merge Retry checks GitHub first and reuses the previous exact verification', async (t) => {
  const f = mergeFixture(t);
  await f.run('understand');
  const prepared = await f.run('merge', humanFirstMerge);
  f.observations.length = 0;
  const result = await approveMerge(f, prepared);
  assert.equal(result.result.revision, 'actual-merge');
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['ready', 'ready', 'merge']
  );
});

test('Merge retries an uncertain successful merge by inspecting GitHub without another merge request', async (t) => {
  let merges = 0;
  const f = mergeFixture(t, {
    onMerge(markMerged) {
      merges++;
      markMerged();
      throw Object.assign(Error('HTTP 502 after merge'), { transient: true });
    },
  });
  await f.run('understand');
  const result = await f.run('merge');
  assert.equal(result.result.revision, 'actual-merge');
  assert.equal(merges, 1);
  assert.equal(f.observations.filter(({ operation }) => operation === 'verify').length, 1);
});

for (const transient of [true, false]) {
  test('Merge retains verification across exhausted or permanent GitHub failures: ' + transient, async (t) => {
    let failed = false;
    let requests = 0;
    const f = mergeFixture(t, {
      onReady() {
        requests++;
        if (failed)
          throw Object.assign(Error(transient ? 'HTTP 503 upstream unavailable' : 'HTTP 403 forbidden'), { transient });
      },
    });
    await f.run('understand');
    const prepared = await f.run('merge', humanFirstMerge);
    failed = true;
    requests = 0;
    let retained;
    await assert.rejects(approveMerge(f, prepared), (error) => {
      assert.match(error.message, transient ? /HTTP 503/ : /HTTP 403/);
      retained = error.deliveryVerification;
      assert.deepEqual(retained, prepared.result.verification);
      return true;
    });
    assert.equal(requests, transient ? 4 : 1);
    failed = false;
    const result = await f.run('merge', {
      attempts: [
        {
          id: 'failed',
          status: 'blocked',
          result: { verification: retained },
        },
      ],
    });
    assert.equal(result.result.revision, 'actual-merge');
    assert.equal(f.observations.filter(({ operation }) => operation === 'verify').length, 1);
    assert.equal(f.calls.filter(({ method }) => method === 'turn').length, 1);
  });
}

test('Stop interrupts GitHub retry backoff without checking or repairing tests', async (t) => {
  const controller = new AbortController();
  let requests = 0;
  const f = mergeFixture(t, {
    onLookup() {
      requests++;
      throw Object.assign(Error('HTTP 503'), { transient: true });
    },
    onWait() {
      controller.abort();
    },
  });
  await f.run('understand');
  await assert.rejects(f.run('merge', { signal: controller.signal }), /aborted/i);
  assert.equal(requests, 1);
  assert.deepEqual(f.observations, []);
});

test('Merge waits for pending GitHub tests without rerunning local verification', async (t) => {
  let pending = true;
  const f = mergeFixture(t, {
    onReady() {
      if (pending)
        throw Object.assign(Error('GitHub tests pending'), {
          code: 'STRATEGY_PENDING',
        });
    },
    onWait() {
      assert.equal(
        f.observations.some(({ operation }) => operation === 'verify'),
        false
      );
      pending = false;
    },
  });
  await f.run('understand');
  assert.equal((await f.run('merge')).result.revision, 'actual-merge');
  assert.equal(f.observations.filter(({ operation }) => operation === 'verify').length, 1);
});

test('Merge bounds unsuccessful merge requests while preserving completed verification', async (t) => {
  let requests = 0;
  const f = mergeFixture(t, {
    onMerge() {
      requests++;
      throw Object.assign(Error('HTTP 502 merge gateway unavailable'), {
        transient: true,
      });
    },
  });
  await f.run('understand');
  await assert.rejects(f.run('merge'), (error) => {
    assert.match(error.message, /HTTP 502 merge gateway unavailable/);
    assert.ok(error.deliveryVerification.proof.length);
    return true;
  });
  assert.equal(requests, 4);
  assert.equal(f.observations.filter(({ operation }) => operation === 'verify').length, 1);
  assert.equal(f.calls.filter(({ method }) => method === 'turn').length, 1);
});

test('Merge retains the original merge error when outcome inspection also fails', async (t) => {
  let requested = false;
  const f = mergeFixture(t, {
    onMerge() {
      requested = true;
      throw Error('HTTP 422 merge candidate rejected');
    },
    onInspect() {
      if (requested) throw Object.assign(Error('HTTP 503 outcome lookup unavailable'), { transient: true });
    },
  });
  await f.run('understand');
  await assert.rejects(f.run('merge'), (error) => {
    assert.match(error.message, /HTTP 422 merge candidate rejected/);
    assert.match(error.message, /Merge outcome could not be checked: HTTP 503 outcome lookup unavailable/);
    assert.ok(error.deliveryVerification.proof.length);
    return true;
  });
  assert.equal(f.observations.filter(({ operation }) => operation === 'verify').length, 1);
});

for (const invalidated of [false, true]) {
  test(
    'Merge recovery retains verification through failed claim attempts and respects invalidation: ' + invalidated,
    async (t) => {
      const f = mergeFixture(t);
      await f.run('understand');
      const prepared = await f.run('merge', humanFirstMerge);
      await f.run('merge', {
        attempts: [
          approvalAttempt(prepared),
          {
            id: 'failed-claim',
            status: 'blocked',
            summary: 'Reconcile the interrupted shared issue claim.',
            ...(invalidated ? { invalidatedAt: '2026-11-21T00:00:00Z' } : {}),
          },
        ],
      });
      assert.equal(f.observations.filter(({ operation }) => operation === 'verify').length, invalidated ? 2 : 1);
    }
  );
}

test('oversized input is rejected before dispatch and does not retain uncertain ownership', async (t) => {
  const { CodexConnection } = await import('./factory-ui/codex.mjs');
  const { maximumTextInputLength, oversizedTextInputMessage } = await import('./factory-ui/codex-input.mjs');
  const f = fixture(t);
  const connection = new CodexConnection();
  connection.call = () => assert.fail('Oversized input must never reach turn/start.');
  f.connection.turn = (...args) => connection.turn(...args);
  await assert.rejects(
    f.run('understand', { details: [{ key: 'context', value: 'x'.repeat(maximumTextInputLength + 1) }] }),
    (error) => {
      assert.equal(error.message, oversizedTextInputMessage);
      assert.equal(error.turnRejected, true);
      assert.notEqual(error.uncertain, true);
      return true;
    }
  );
  assert.equal(connection.turns.size, 0);
  assert.equal(conversationState(f.root, f.issue.id).flowBlocks['block-understand'].status, 'idle');
});

test('large source issue history reaches Work by retained file reference without exceeding the input limit', async (t) => {
  const { maximumTextInputLength } = await import('./factory-ui/codex-input.mjs');
  const f = fixture(t);
  f.issue.source_issue = 'large-source';
  mkdirSync(join(f.root, '.issues/closed'), { recursive: true });
  const report = 'Full source evidence.\n'.repeat(60000);
  writeFileSync(
    join(f.root, '.issues/closed/large-source.md'),
    '---\nid: large-source\ntitle: Large source\nstate: closed\n---\n' + report
  );
  const result = await f.run('work');
  const prompt = f.calls.find(({ method }) => method === 'turn').prompt;
  assert.ok(prompt.length < maximumTextInputLength, `Work input contains ${prompt.length} characters`);
  const input = JSON.parse(prompt);
  assert.equal(input.sourceIssue.issueId, 'large-source');
  const reference = input.sourceIssue.evidence;
  const bytes = readFileSync(reference.path, 'utf8');
  assert.equal(digest(bytes), reference.sha256);
  assert.ok(JSON.parse(bytes).report.includes(report.trim()));
  assert.equal(result.evidence.find(({ key }) => key === 'sourceIssue').path, reference.path);
});

test('Retry replaces a conversation whose oversized first input was never accepted', async (t) => {
  const { maximumTextInputLength, oversizedTextInputMessage } = await import('./factory-ui/codex-input.mjs');
  const { appendMessage } = await import('./factory-ui/conversation-store.mjs');
  const f = fixture(t);
  await f.run('understand');
  const state = conversationState(f.root, f.issue.id);
  delete state.flowBlocks['block-understand'].flowReceipt;
  const { saveConversationState } = await import('./factory-ui/conversation-store.mjs');
  saveConversationState(f.root, f.issue.id, state);
  appendMessage(f.root, f.issue.id, {
    id: 'flow-request-rejected',
    kind: 'flow-block-request',
    blockId: 'block-understand',
    body: 'x'.repeat(maximumTextInputLength + 1),
  });
  f.connection.resume = () => assert.fail('The rejected first turn has no persisted conversation to resume.');
  await f.run('understand', {
    continuing: true,
    attempts: [
      { id: 'rejected', status: 'blocked', summary: oversizedTextInputMessage, output: 'Running understand block.' },
    ],
  });
  assert.equal(f.calls.filter(({ method }) => method === 'start').length, 2);
});
