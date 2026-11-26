import { writeBrowserEvidenceFixture } from './flow-browser-evidence-fixture.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFlowExecutor } from './factory-ui/flow-executor.mjs';
import { digest } from './factory-ui/common.mjs';
import { groupProofRows } from './factory-ui/flow-group-proof.mjs';
import { reportedLiveProofRequirements, saveLiveProof } from './factory-ui/flow-live-proof.mjs';
import { runRetro } from './factory-ui/flow-retro.mjs';
import { collectEvidence, hydrateEvidence, registerEvidenceResolver } from './factory-ui/stores/evidence.mjs';
import { BlockCatalog } from './factory-ui/block-catalog.mjs';
import { blockDetails, definitionMap } from './factory-ui/flow-block-data.mjs';
import {
  conversationMessages,
  conversationState,
  conversationFiles,
  saveConversationState,
} from './factory-ui/conversation-store.mjs';
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
    async resume(id, cwd, sandbox, instructions) {
      calls.push({ method: 'resume', id, cwd, sandbox, instructions });
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
      return options.respond?.(prompt, cwd) ?? 'Observed block result.';
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

test('Work retains passing Flow scenarios and Node test name filters', async (t) => {
  const f = fixture(t);
  const focusedTests = [
    [
      'node',
      'scripts/flow-browser.mjs',
      '--project-discuss',
      '--project-issues',
      '--local-notes',
      '--issue-status-folders',
    ],
    [
      'node',
      '--test',
      '--test-name-pattern',
      'parallel lanes join before suggested publication',
      'scripts/flow.check.mjs',
    ],
  ];
  f.connection.turn = async (_threadId, checkout) => {
    const scripts = join(checkout, 'scripts');
    mkdirSync(scripts);
    writeFileSync(
      join(scripts, 'browser-scenario-policy.mjs'),
      readFileSync(new URL('./browser-scenario-policy.mjs', import.meta.url), 'utf8')
    );
    execFileSync('git', ['add', 'scripts'], { cwd: checkout });
    execFileSync('git', ['commit', '-qm', 'Add Flow scenarios'], { cwd: checkout });
    return '```flow-result\n' + JSON.stringify({ focusedTests }) + '\n```';
  };
  const result = await f.run('work');
  assert.deepEqual(result.result.focusedTests, [
    focusedTests[0],
    [
      'node',
      '--test',
      '--test-name-pattern=parallel lanes join before suggested publication',
      'scripts/flow.check.mjs',
    ],
  ]);
});

test('Work accepts focused Flow scenarios and CI parts registered in the candidate checkout', async (t) => {
  const f = fixture(t);
  const focusedTests = [
    ['node', 'scripts/flow-browser.mjs', '--ci-part=1a', '--candidate-browser-check', '--issue-annotations'],
    ['node', 'scripts/flow-browser.mjs', '--ci-part=1b', '--candidate-browser-check'],
  ];
  f.connection.turn = async (_threadId, checkout) => {
    const scripts = join(checkout, 'scripts');
    mkdirSync(scripts);
    writeFileSync(
      join(scripts, 'browser-scenario-policy.mjs'),
      `throw Error('The server must read the candidate registry without running it.');
export const flowBrowserScenarioNames = {
  '--candidate-browser-check': 'Candidate browser check',
  '--issue-annotations': 'Issue annotations',
};
export const flowBrowserCiParts = new Set(['--ci-part=1a', '--ci-part=1b']);
`
    );
    execFileSync('git', ['add', 'scripts'], { cwd: checkout });
    execFileSync('git', ['commit', '-qm', 'Register candidate browser check'], { cwd: checkout });
    writeFileSync(join(checkout, '.issues/browser-proof.txt'), 'Candidate-selected annotation scenario passed.\n');
    return (
      '```flow-result\n' + JSON.stringify({ focusedTests, files: { proof: '.issues/browser-proof.txt' } }) + '\n```'
    );
  };
  const result = await f.run('work');
  assert.deepEqual(result.result.focusedTests, focusedTests);
  const proof = result.artifacts.files.proof;
  const bytes = readFileSync(proof.path);
  assert.equal(bytes.toString(), 'Candidate-selected annotation scenario passed.\n');
  assert.equal(proof.sha256, digest(bytes));
  f.connection.turn = async () =>
    '```flow-result\n' +
    JSON.stringify({ focusedTests: [['node', 'scripts/flow-browser.mjs', '--project-discuss']] }) +
    '\n```';
  await assert.rejects(f.run('work', { continuing: true }), /argument 3 "--project-discuss"/);
});

test('Work and Retry distinguish implementation from an earlier idle issue capture', async (t) => {
  const f = fixture(t);
  const details = [
    { key: 'goal', value: 'Create an idle issue capturing the agreed project Settings design.' },
    {
      key: 'constraints',
      value:
        'Create the issue only and leave it idle; do not start implementation. Preserve inheritance and keep secrets read-only.',
    },
  ];
  await f.run('work', { details });
  await f.run('work', { details, continuing: true });
  const turns = f.calls.filter(({ method }) => method === 'turn');
  assert.equal(turns.length, 2);
  for (const turn of turns) {
    const input = JSON.parse(turn.prompt);
    assert.equal(input.workExecution.issueId, f.issue.id);
    assert.match(input.workExecution.task, /Implement the saved issue/);
    assert.match(input.workExecution.task, /capture-only.*earlier creation/i);
    assert.match(input.workExecution.task, /Preserve.*product constraints.*human.*permission/i);
    assert.match(input.workExecution.task, /implementation.*proof/i);
    assert.deepEqual(input.details, details);
  }
  assert.equal(f.calls.filter(({ method }) => method === 'resume').length, 1);
});

test('Work and Retry authorize implementation from the saved Asset Storage design', async (t) => {
  const f = fixture(t);
  const details = [
    { key: 'goal', value: 'Add Asset Storage management' },
    {
      key: 'report',
      value:
        'Finish the design interview, record the remaining decisions in the plan, and obtain the user’s confirmation of shared understanding and explicit approval before implementing or enabling deletion behavior.',
    },
    {
      key: 'constraints',
      value: 'Enabling deletion for existing project data requires explicit approval after the review.',
    },
  ];
  await f.run('work', { details });
  await f.run('work', { details, continuing: true });

  const sessions = f.calls.filter(({ method }) => method === 'start' || method === 'resume');
  assert.deepEqual(
    sessions.map(({ method }) => method),
    ['start', 'resume']
  );
  for (const { instructions } of sessions) {
    assert.match(instructions, /Running Work authorizes implementation within the saved issue scope/);
    assert.match(instructions, /generic design or implementation sign-off/);
    assert.match(instructions, /Preserve explicit checkpoints for specific operations/);
    assert.match(instructions, /Continue with independent work/);
  }
  for (const turn of f.calls.filter(({ method }) => method === 'turn')) {
    assert.deepEqual(JSON.parse(turn.prompt).details, details);
  }
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

test('Work repairs formatting and Fallow in its own chat and standalone Verify cannot run', async (t) => {
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
  await assert.rejects(() => f.run('verify'), /Run tests in Work or Merge/);
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

test('late provider output cannot change a completed investigation response or its retained checksum', async (t) => {
  const f = fixture(t);
  f.flow.routeType = 'investigation';
  f.connection.close = () =>
    f.emit({ method: 'item/agentMessage/delta', params: { threadId: 'the-one-issue-chat', delta: 'late fragment' } });
  const result = await f.run('understand', {
    definition: {
      usable: true,
      prompt: 'Investigate only.',
      artifacts: [{ key: 'response', kind: 'file', label: 'Block response' }],
    },
  });
  const response = result.artifacts.files.response;
  assert.equal(readFileSync(response.path, 'utf8'), result.output);
  assert.equal(digest(readFileSync(response.path)), response.sha256);
  f.emit({
    method: 'item/agentMessage/delta',
    params: { threadId: 'the-one-issue-chat', delta: 'another late fragment' },
  });
  assert.equal(digest(readFileSync(response.path)), response.sha256);
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

test('native Flow approvals wait for a decision bound to the current block and attempt', async (t) => {
  const f = fixture(t);
  const requested = Promise.withResolvers();
  const approved = Promise.withResolvers();
  f.connection.selection = { provider: 'anthropic' };
  f.connection.requests = new Map();
  f.connection.turn = async () => {
    const request = {
      id: 'permission',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'the-one-issue-chat', command: 'Edit fixture', availableDecisions: ['accept', 'decline'] },
    };
    f.connection.requests.set(request.id, request);
    f.emit({ method: 'ui/approval', params: { requestId: request.id, ...request.params } });
    requested.resolve();
    return approved.promise;
  };
  f.connection.answer = (id, threadId, response) => {
    assert.equal(threadId, 'the-one-issue-chat');
    assert.equal(response.decision, 'option:0');
    f.connection.requests.delete(id);
    approved.resolve('Approved result.');
  };
  const running = f.run('understand');
  await requested.promise;
  const [request] = f.executor.approvals(f.issue.id);
  assert.equal(request.blockId, 'block-understand');
  assert.equal(request.options[0].label, 'Allow once');
  assert.throws(
    () => f.executor.answer(f.issue.id, request.blockId, 'stale-attempt', request.requestId, {}),
    /no longer belongs/
  );
  f.executor.answer(f.issue.id, request.blockId, request.attemptId, request.requestId, { decision: 'option:0' });
  await running;
  assert.deepEqual(f.executor.approvals(f.issue.id), []);
});

test('protected merge and delete block without saved delivery evidence and start no model', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run('merge'), /No protected PR candidate or managed/);
  await assert.rejects(f.run('delete-worktree'), /No managed checkout/);
  assert.equal(f.calls.filter((call) => call.method === 'connection').length, 0);
});

for (const installed of ['matching', 'missing', 'stale', 'missing workspace']) {
  test(`Work verification prepares ${installed} dependencies and retains command evidence`, async (t) => {
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
    const f = fixture(t);
    const { workspace } = await f.run('understand');
    writeFileSync(join(workspace.checkout, 'pnpm-lock.yaml'), lock);
    writeFileSync(join(workspace.checkout, 'pnpm-workspace.yaml'), workspaces);
    if (installed !== 'missing')
      installFixture(workspace.checkout, installed === 'stale' ? 'old lock' : lock, installed !== 'missing workspace');
    const summary = join(workspace.checkout, '.issues/evidence/work-summary.json');
    const ctx = { signal: new AbortController().signal, onProgress() {} };
    const result = await runWorkVerification(ctx, workspace, join(f.root, 'verification'), async (input) => {
      executions.push(input);
      writeFileSync(input.log, 'Fixture command result.');
      if (input.command === 'pnpm') return installFixture(input.cwd);
      mkdirSync(dirname(summary), { recursive: true });
      writeFileSync(summary, '{}');
      return 'Verification summary: ' + summary;
    });
    assert.deepEqual(
      executions.map(({ command }) => command),
      installed === 'matching' ? [process.execPath] : ['pnpm', process.execPath]
    );
    assert.ok(executions.every(({ cwd }) => cwd === workspace.checkout));
    if (installed !== 'matching') assert.deepEqual(executions[0].args, ['install', '--frozen-lockfile']);
    assert.ok(executions.at(-1).args.includes('--work-checks'));
    assert.ok(result.evidence.some(({ path }) => path === summary));
    assert.ok(result.evidence.every((item) => existsSync(item.path)));
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
  const task = f.run('update-branch', { signal: abort.signal });
  await started;
  abort.abort();
  await assert.rejects(task, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(readFileSync(error.evidence[0].path, 'utf8'), 'Command began.\n');
    return true;
  });
  assert.equal(receivedSignal.aborted, true);
});

function mergeFixture(
  t,
  {
    merged = false,
    onWait,
    repair,
    onGit,
    onReady,
    onLookup,
    onMerge,
    onInspect,
    github,
    mergeNow,
    respond,
    browser,
  } = {}
) {
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
    base: { ref: 'dev', sha: f.git('rev-parse', 'dev'), repo: { full_name: 'test/fixture' } },
  });
  const f = fixture(t, {
    repair,
    respond,
    mergeNow,
    async mergeDelay(interval) {
      await onWait?.(advanceTarget, interval);
    },
    async execute(input) {
      const { command, cwd, args, log } = input;
      if (command === 'node') return browser(input);
      if (log) writeFileSync(log, '$ git ' + args.join(' ') + '\n', { flag: 'a' });
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
    async verifyCandidate() {
      assert.fail('Merge must use GitHub checks without invoking local verification.');
    },
    provider: {
      config: { repository: 'test/fixture', target: 'dev' },
      async gh(args) {
        if (args[1] === 'repos/test/fixture/git/commits/actual-merge') {
          const checkout = f.flow.workspace.checkout;
          return JSON.stringify({
            sha: 'actual-merge',
            tree: { sha: f.git('-C', checkout, 'rev-parse', 'HEAD^{tree}') },
            parents: [f.git('rev-parse', 'dev'), publishedHead].map((sha) => ({ sha })),
          });
        }
        if (github) return github(args);
        return JSON.stringify({ data: { repository: { pullRequest: {} } } });
      },
      async findIssueBranchPR(branch) {
        await onLookup?.();
        return pullRequest(branch);
      },
      async ready(pr, branch, head, settings) {
        assert.equal(head, pr.head.sha);
        observations.push({ operation: 'ready', head });
        await onReady?.(pr, branch, head, settings);
        return {
          head,
          merged,
          target: f.git('rev-parse', 'dev'),
          checks: [
            {
              name: 'Verify',
              detailsUrl: 'https://github.com/test/fixture/actions/runs/90/job/91',
            },
          ],
          ...(merged ? { merge: { revision: 'actual-merge', url: 'https://example.invalid/pr/9' } } : {}),
        };
      },
      async inspect() {
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
  });
  f.git('remote', 'add', 'origin', 'git@github.com:test/fixture.git');
  writeFileSync(
    join(f.root, '.issues/issue-delivery-config.json'),
    JSON.stringify({ provider: 'github', repository: 'test/fixture', remote: 'origin', target: 'dev' })
  );
  return {
    ...f,
    observations,
    advanceTarget,
    publishHead(head) {
      publishedHead = head;
    },
  };
}

test('Update Branch leaves publication of the updated candidate to Merge', async (t) => {
  const f = mergeFixture(t);
  await f.run('understand');
  f.advanceTarget();
  const update = await f.run('update-branch');
  assert.ok(update.result.fetchedCommit);
  f.flow.blocks.push({
    id: 'updated-branch',
    kind: 'update-branch',
    after: [],
    attempts: [{ status: 'completed', result: update.result }],
  });
  await f.run('merge', { after: ['updated-branch'] });
  assert.ok(f.observations.some(({ operation }) => operation === 'push'));
});

test('Merge retains the final candidate observations and earlier Work proof through the Artifact store', async (t) => {
  const observations = { batchOrder: ['large', 'small'], selection: ['small'], bytes: 42 };
  const gitAt = (cwd, ...args) => f.git('-C', cwd, ...args);
  const f = mergeFixture(t, {
    browser(input) {
      assert.deepEqual(input.args, ['scripts/flow-browser.mjs', '--asset-storage']);
      writeBrowserEvidenceFixture(input, {
        head: gitAt(input.cwd, 'rev-parse', 'HEAD'),
        tree: gitAt(input.cwd, 'rev-parse', 'HEAD^{tree}'),
        scenarios: [{ name: 'Asset Storage', passed: true }],
        files: {
          'asset-storage-observations.json': JSON.stringify(observations),
          'asset-storage.png': 'fixture screenshot bytes',
        },
      });
    },
    onGit(args) {
      if (args[0] === 'push')
        assert.ok(
          existsSync(
            join(
              f.root,
              '.issues/factory-ui/flow-evidence',
              'attempt-2',
              'browser-' + args[2].split(':')[0],
              'asset-storage-observations.json'
            )
          )
        );
    },
  });
  await f.run('understand');
  const { checkout } = f.flow.workspace;
  const registry = join(checkout, 'scripts', 'browser-scenario-policy.mjs');
  mkdirSync(join(registry, '..'), { recursive: true });
  writeFileSync(registry, "const flowBrowserScenarioNames = { '--asset-storage': 'Asset Storage' };");
  writeFileSync(join(checkout, 'source.txt'), 'Work source.\n');
  gitAt(checkout, 'add', 'source.txt');
  gitAt(checkout, 'add', 'scripts');
  gitAt(checkout, 'commit', '-qm', 'Commit Work candidate');
  const work = {
    head: gitAt(checkout, 'rev-parse', 'HEAD'),
    tree: gitAt(checkout, 'rev-parse', 'HEAD^{tree}'),
    focusedTests: [['node', 'scripts/flow-browser.mjs', '--asset-storage']],
  };
  const path = join(f.root, '.issues', 'original-work.json');
  writeFileSync(path, '{"original":true}');
  const proof = { path, sha256: digest(readFileSync(path)) };
  f.flow.blocks.push({
    id: 'work',
    kind: 'work',
    attempts: [{ id: 'work-1', status: 'completed', result: work, artifacts: { files: { proof } } }],
  });
  f.publishHead(work.head);
  writeFileSync(join(f.root, 'source.txt'), 'Target source.\n');
  f.git('commit', '-am', 'Advance target with conflicting source');
  const repairTurn = f.connection.turn.bind(f.connection);
  f.connection.turn = async (...args) => {
    assert.match(gitAt(checkout, 'ls-files', '-u'), /source.txt/);
    writeFileSync(join(checkout, 'source.txt'), 'Work and target source.\n');
    gitAt(checkout, 'add', 'source.txt');
    gitAt(checkout, 'commit', '--no-edit');
    await repairTurn(...args);
    const path = '.issues/merge-target-update.json';
    writeFileSync(
      join(checkout, path),
      JSON.stringify({
        sourceCommit: gitAt(checkout, 'rev-parse', 'HEAD'),
        sourceTree: gitAt(checkout, 'rev-parse', 'HEAD^{tree}'),
        sourceDiff: '',
        sourceClean: true,
        sourceEnvironment: { node: process.version },
        fixture: 'GitHub responses are simulated.',
        scenarios: [{ result: { head: 'fixture-head', revision: 'fixture-merge' } }],
      })
    );
    return (
      'Repair retained browser evidence.\n```flow-result\n' + JSON.stringify({ files: { result: path } }) + '\n```'
    );
  };
  const outcome = await f.run('merge', {
    definition: {
      mergeWorkflow: { policy: 'automatic', pollSeconds: 5, checkTimeoutSeconds: 900, repairAttempts: 3 },
      artifacts: [{ key: 'result', kind: 'file', label: 'Repair result' }],
    },
  });
  const receipt = JSON.parse(readFileSync(outcome.result.deliveryReceipt.path));
  assert.equal(receipt.candidate.commit, outcome.result.head);
  assert.notEqual(receipt.candidate.tree, work.tree);
  assert.equal(receipt.workProof.attempts[0].status, 'different-tree');
  assert.deepEqual(receipt.workProof.attempts[0].file, proof);
  assert.equal(receipt.browser.exit, 0);
  const { repairBrowserProof } = receipt;
  assert.equal(repairBrowserProof.attemptId, 'attempt-2');
  assert.equal(repairBrowserProof.round, 1);
  assert.equal(repairBrowserProof.sourceCommit, receipt.candidate.commit);
  assert.equal(repairBrowserProof.sourceTree, receipt.candidate.tree);
  assert.deepEqual(repairBrowserProof.environment, {
    node: process.version,
    fixture: 'GitHub responses are simulated.',
  });
  assert.equal(digest(readFileSync(repairBrowserProof.file.path)), repairBrowserProof.file.sha256);
  assert.equal(receipt.jobs[0].jobId, '91');
  const artifacts = await openArtifactStore({ id: 'proof', kind: 'files' }, { root: f.root, projectId: 'factory' });
  const manifest = await collectEvidence({ root: f.root, flow: outcome, artifacts });
  assert.deepEqual(manifest.gaps, []);
  const observation = manifest.files.find(({ path }) => path.endsWith('asset-storage-observations.json'));
  assert.equal(observation.ref.storeId, 'proof');
  assert.deepEqual(JSON.parse(await artifacts.get(observation.ref)), observations);
  const screenshot = receipt.browser.files.find(({ path }) => path.endsWith('.png'));
  assert.equal(digest(readFileSync(screenshot.path)), screenshot.sha256);
  await verifyDeliveredBrowserRetrospective(f, outcome, repairBrowserProof);
});

async function verifyDeliveredBrowserRetrospective(f, merge, proof) {
  f.service.store.directory = join(f.root, '.issues');
  f.service.codex = f.connection;
  const retro = await runRetro(
    f.service,
    {
      issue: f.issue,
      flow: {
        ...f.flow,
        blocks: [...f.flow.blocks, { kind: 'merge', label: 'Merge', attempts: [{ id: proof.attemptId, ...merge }] }],
      },
      signal: new AbortController().signal,
      definition: { prompt: 'Review the fixture.' },
    },
    () => ({
      async begin() {},
      async ask() {
        return JSON.stringify({ summary: 'Reviewed fixture evidence.', recommendations: [] });
      },
      close() {},
    })
  );
  const index = JSON.parse(readFileSync(retro.evidence[0].path));
  const [delivery] = JSON.parse(readFileSync(index.sections.deliveryReceipts.path));
  assert.equal(delivery.repairBrowserProof.file.sha256, proof.file.sha256);
  assert.equal(digest(readFileSync(delivery.repairBrowserProof.file.path)), proof.file.sha256);
  assert.match(readFileSync(delivery.repairBrowserProof.file.path, 'utf8'), /GitHub responses are simulated/);
}

test('Merge uses GitHub readiness for a master without starting another verification turn', async (t) => {
  const f = mergeFixture(t);
  await f.run('understand');
  f.issue.issue_group = {
    children: [{ id: 'attached', title: 'Attached issue', requestedProof: 'Open the browser fixture.' }],
  };
  const attempts = [{ status: 'blocked', evidence: [{ label: 'Merge repair index' }] }];
  const callsBeforeMerge = f.calls.length;

  const merged = await f.run('merge', { attempts });

  assert.equal(merged.result.revision, 'actual-merge');
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['push', 'ready', 'ready', 'merge']
  );
  assert.ok(!f.calls.slice(callsBeforeMerge).some(({ instructions }) => instructions));
});

test('Work surfaces an attached live check before Merge without granting remote writes', async (t) => {
  const child = {
    id: 'live-check',
    title: 'Verify the live transition',
    requestedProof: 'Observe a disposable live PR merge after its required checks.',
  };
  const f = fixture(t, {
    prepareWorkDependencies: async () => {},
    respond(prompt) {
      const input = JSON.parse(prompt);
      assert.match(input.liveProofHandoff, /does not authorize that side effect/);
      assert.deepEqual(
        input.subIssues.attached.map(({ id }) => id),
        [child.id]
      );
      const manifest = { liveProofRequirements: [{ id: child.id, check: child.requestedProof }] };
      return `The candidate is ready for an authorized live check.\n\`\`\`flow-result\n${JSON.stringify(manifest)}\n\`\`\``;
    },
  });
  f.issue.issue_group = { children: [child] };
  const result = await f.run('work');
  assert.equal(result.status, undefined);
  assert.equal(result.result.liveProofRequirements[0].check, child.requestedProof);
  assert.ok(result.result.head);
});

test('An authorized live attachment remains in history while Merge uses GitHub readiness', async (t) => {
  const child = {
    id: '20261126T044948057-295a460d8895b92a',
    title: 'Work All Night waits for required checks',
    requestedProof:
      'Observe an unreviewed live PR stay open while a required check is pending or failing, then merge automatically when checks pass.',
  };
  const liveProofRequirements = [{ id: child.id, check: child.requestedProof }];
  const sibling = { id: 'other', title: 'Check the report', requestedProof: 'Inspect the rendered report.' };
  const f = mergeFixture(t);
  await f.run('understand');
  f.issue.issue_group = { children: [child, sibling] };
  const workspace = f.flow.workspace;
  const candidate = {
    head: f.git('-C', workspace.checkout, 'rev-parse', 'HEAD'),
    tree: f.git('-C', workspace.checkout, 'rev-parse', 'HEAD^{tree}'),
  };
  const legacyFile = join(f.root, '.issues', 'legacy-proof.json');
  const legacyBytes = JSON.stringify([
    {
      id: child.id,
      status: 'passed',
      source: 'live-github',
      observation:
        'Fixture of a retained live record showing an unreviewed PR stayed open while pending and merged after success.',
    },
  ]);
  writeFileSync(legacyFile, legacyBytes);
  const work = {
    id: 'work',
    kind: 'work',
    after: [],
    attempts: [
      {
        status: 'completed',
        result: { tree: candidate.tree },
        artifacts: { files: { subIssueProof: { path: legacyFile, sha256: digest(legacyBytes) } } },
      },
    ],
  };
  f.flow.blocks.push(work);
  assert.equal(groupProofRows(f.flow, candidate.tree, {}, f.root).get(child.id).status, 'passed');
  const reported = reportedLiveProofRequirements({ issue: f.issue, attempt: {} }, { liveProofRequirements });
  work.attempts.push({ status: 'blocked', result: { tree: candidate.tree, liveProofRequirements: reported } });
  assert.equal(groupProofRows(f.flow, candidate.tree, {}, f.root).has(child.id), false);
  assert.equal(readFileSync(legacyFile, 'utf8'), legacyBytes);

  const merge = { id: 'block-merge', kind: 'merge', after: ['work'], attempts: [] };
  f.flow.blocks.push(merge);
  const prepare = () => f.run('merge', { after: merge.after, attempts: merge.attempts, input: { prepareMerge: true } });
  const store = {
    async save(flow) {
      return structuredClone(flow);
    },
  };
  const scope = { repository: 'test/disposable', branch: 'proof-source', target: 'proof-target' };
  const submit = (action, input) =>
    saveLiveProof(
      f.service,
      f.issue,
      f.flow,
      workspace,
      'live-proof-' + action,
      {
        ...input,
        confirmed: true,
      },
      store
    );
  await assert.rejects(
    submit('authorize', {
      childId: child.id,
      check: child.requestedProof,
      candidate,
      scope: { ...scope, repository: 'test/fixture', target: 'dev' },
    }),
    /outside the production PR/
  );
  const { record: authorization } = await submit('authorize', {
    childId: child.id,
    check: child.requestedProof,
    candidate,
    scope,
  });
  const bundle = {
    authorizationId: authorization.id,
    status: 'passed',
    pr: { ...scope, number: 41, head: candidate.head },
    observations: [
      { at: '2026-11-26T08:01:00Z', observed: 'Required check pending, zero reviews, PR open.' },
      { at: '2026-11-26T08:02:00Z', observed: 'Required check passed, zero reviews, PR automatically merged.' },
    ],
    logs: [{ name: 'github-observations', text: 'Fixture transcript of the two GitHub observations' }],
  };
  await assert.rejects(submit('attach', { ...bundle, source: 'fixture' }), /live-github/);
  const { record: attachment } = await submit('attach', { ...bundle, source: 'live-github' });
  assert.equal((await submit('attach', { ...bundle, source: 'live-github' })).record.id, attachment.id);
  f.flow.liveProof = JSON.parse(JSON.stringify(f.flow.liveProof));
  const ready = await prepare();
  assert.equal(ready.result.mergeConfirmation.pr, 9);
  assert.ok(!f.observations.some(({ operation }) => operation === 'merge'));
  assert.equal((await f.run('merge', { after: merge.after })).result.revision, 'actual-merge');
  assert.equal(f.calls.filter(({ method }) => method === 'turn').length, 1);
  assert.deepEqual(f.flow.liveProof.attachments, [attachment]);
  for (const { path, sha256 } of attachment.evidence) assert.equal(digest(readFileSync(path)), sha256);
});

test('Retro retains historical final group proof and command logs for a second runner', async (t) => {
  const producer = mergeFixture(t);
  await producer.run('understand');
  const folder = join(producer.root, '.issues/factory-ui/flow-evidence/legacy-group-proof');
  mkdirSync(folder, { recursive: true });
  const retained = (name, contents) => {
    const path = join(folder, name);
    writeFileSync(path, contents);
    return { path, sha256: digest(readFileSync(path)) };
  };
  const checks = [['node scripts/flow-browser.mjs --project-discuss', 'Discuss scenario rendered and passed']];
  const [command, output] = checks[0];
  const proof = retained('sub-issue-proof.json', JSON.stringify([{ id: 'attached', status: 'passed' }]));
  const log = retained('command-1.log', `$ ${command}\n${output}\n\nStatus: completed, exit: 0`);
  const { checkout } = producer.flow.workspace;
  const groupVerification = {
    head: producer.git('-C', checkout, 'rev-parse', 'HEAD'),
    tree: producer.git('-C', checkout, 'rev-parse', 'HEAD^{tree}'),
    threadId: 'legacy-thread',
    turnId: 'legacy-turn',
  };
  const index = retained(
    'verification.json',
    JSON.stringify({ ...groupVerification, proof, logs: [{ ...log, command }] })
  );
  const verification = { ...index, label: 'Final group verification', groupVerification };
  const merge = {
    id: 'legacy-merge',
    result: { groupProof: { ...groupVerification, file: proof, verification } },
    evidence: [verification, proof, log],
  };
  await verifyFinalGroupRetrospective(t, producer, merge, checks);
});

test('Retro retains a failed Work verdict through a blocked Merge, retry, and Close', async (t) => {
  const producer = mergeFixture(t);
  await producer.run('understand');
  const live = { id: 'live', title: 'Verify the live check', requestedProof: 'Observe the live check in GitHub.' };
  const attached = { id: 'attached', title: 'Check the browser', requestedProof: 'Run the browser scenario.' };
  const sameTree = { id: 'same-tree', title: 'Check the report', requestedProof: 'Inspect the report.' };
  producer.issue.issue_group = { children: [attached, live, sameTree] };
  const path = join(producer.root, '.issues', 'failed-sub-issue-proof.json');
  const rows = [{ id: 'attached', status: 'failed', observation: 'Browser assertion failed.' }];
  writeFileSync(path, JSON.stringify(rows));
  const result = {
    head: producer.git('rev-parse', 'HEAD'),
    tree: producer.git('rev-parse', 'HEAD^{tree}'),
    threadId: 'proof-thread',
    turnId: 'proof-turn',
    liveProofRequirements: reportedLiveProofRequirements(
      { issue: producer.issue, attempt: {} },
      { liveProofRequirements: [{ id: live.id, check: live.requestedProof }] }
    ),
  };
  const work = {
    id: 'work-proof',
    status: 'blocked',
    result,
    artifacts: {
      files: {
        subIssueProof: { path, sha256: digest(readFileSync(path)) },
      },
    },
  };
  const response = 'One final candidate child failed.';
  const groupFolder = join(producer.root, '.issues', 'group-proof-' + result.head);
  mkdirSync(groupFolder);
  const oldEvidence = (name, body) => {
    const path = join(groupFolder, name);
    writeFileSync(path, body);
    return { path, sha256: digest(readFileSync(path)) };
  };
  const legacyEvidence = [
    oldEvidence('output.txt', response),
    oldEvidence('artifact-subIssueProof-verdicts.json', JSON.stringify(rows)),
    oldEvidence('artifact-log-combined.log', 'Final browser run exited 1.'),
  ];
  writeFileSync(join(producer.root, 'source.txt'), 'Retried candidate.');
  producer.git('commit', '-am', 'Retried candidate');
  const passedHead = producer.git('rev-parse', 'HEAD');
  const candidateTree = producer.git('rev-parse', 'HEAD^{tree}');
  const passed = oldEvidence(
    'retained-passing-proof.json',
    JSON.stringify([{ id: sameTree.id, status: 'passed', observation: 'Report inspection passed.' }])
  );
  const workRetry = {
    id: 'work-retry',
    status: 'completed',
    result: { head: passedHead, tree: candidateTree },
    artifacts: { files: { subIssueProof: passed } },
  };
  producer.git('commit', '--allow-empty', '-m', 'Publish identical tree');
  const head = producer.git('rev-parse', 'HEAD');
  const merge = [
    { id: 'blocked-merge', status: 'blocked', evidence: legacyEvidence },
    { id: 'retried-merge', status: 'completed', result: { pr: 9, head, revision: head } },
  ];
  const close = [{ id: 'closed', status: 'completed' }];
  producer.service.store.directory = join(producer.root, '.issues');
  producer.service.codex = {
    async ready() {},
    async call(_, { threadId }) {
      if (threadId !== result.threadId) return { thread: { turns: [] } };
      return {
        thread: {
          turns: [
            {
              id: result.turnId,
              items: [
                { type: 'agentMessage', text: response },
                {
                  type: 'commandExecution',
                  command: 'node scripts/flow-browser.mjs --asset-storage',
                  aggregatedOutput: 'Browser assertion failed.',
                  exitCode: 1,
                  status: 'failed',
                },
              ],
            },
          ],
        },
      };
    },
  };
  const retro = await runRetro(
    producer.service,
    {
      issue: producer.issue,
      flow: {
        blocks: [
          { kind: 'work', label: 'Work', attempts: [work, workRetry] },
          { kind: 'merge', label: 'Merge', attempts: merge },
          { kind: 'close', label: 'Close', attempts: close },
        ],
      },
      signal: new AbortController().signal,
      definition: { prompt: 'Review the fixture.' },
    },
    () => ({
      async begin() {},
      async ask() {
        return JSON.stringify({ summary: 'Reviewed fixture evidence.', recommendations: [] });
      },
      close() {},
    })
  );
  const { sections } = JSON.parse(readFileSync(retro.evidence[0].path));
  const [record, retry, legacy] = JSON.parse(readFileSync(sections.groupVerifications.path));
  const snapshot = JSON.parse(readFileSync(sections.groupClosure.path));
  assert.deepEqual(snapshot.candidate, { head, tree: candidateTree });
  const [browserProof, pending, retained] = snapshot.children;
  assert.equal(browserProof.verdict.status, 'failed');
  assert.equal(browserProof.verdict.tree, result.tree);
  assert.equal(browserProof.outstandingProof, attached.requestedProof);
  assert.match(browserProof.applicability, /earlier tree/);
  assert.equal(pending.verdict, null);
  assert.equal(pending.outstandingProof, live.requestedProof);
  assert.match(pending.applicability, /no bounded authorization/);
  assert.equal(retained.verdict.head, passedHead);
  assert.equal(retained.outstandingProof, null);
  assert.match(retained.applicability, /source tree is identical/);
  assert.equal(record.turnId, result.turnId);
  assert.equal(record.tree, result.tree);
  assert.deepEqual(JSON.parse(readFileSync(record.proof.path)), rows);
  assert.deepEqual(
    record.operations.map(({ id, status }) => [id, status]),
    [...merge, ...close].map(({ id, status }) => [id, status])
  );
  assert.equal(record.logs[0].exitCode, 1);
  assert.equal(readFileSync(record.logs[0].path, 'utf8'), 'Browser assertion failed.');
  assert.equal(retry.attemptId, workRetry.id);
  assert.equal(retry.tree, candidateTree);
  assert.equal(legacy.attemptId, 'blocked-merge');
  assert.equal(legacy.turnId, result.turnId);
  assert.equal(legacy.tree, result.tree);
  assert.deepEqual(JSON.parse(readFileSync(legacy.proof.path)), rows);
  assert.equal(readFileSync(legacy.logs[0].path, 'utf8'), 'Final browser run exited 1.');
});

async function verifyFinalGroupRetrospective(t, producer, merge, checks) {
  const stored = new Map();
  const artifacts = {
    async put({ body }) {
      const hash = digest(body);
      stored.set(hash, body);
      return hash;
    },
    async get(hash) {
      return stored.get(hash);
    },
  };
  const consumer = fixture(t);
  const manifest = await collectEvidence({ root: producer.root, flow: { merge }, artifacts });
  assert.deepEqual(manifest.gaps, []);
  const resolver = await hydrateEvidence({ manifest, artifacts, directory: join(consumer.root, '.issues/hydrated') });
  t.after(registerEvidenceResolver(consumer.root, resolver));
  rmSync(join(producer.root, '.issues/factory-ui/flow-evidence'), { recursive: true });
  rmSync(producer.flow.workspace.checkout, { recursive: true });
  consumer.service.store.directory = join(consumer.root, '.issues');
  const { threadId, turnId, head, tree } = merge.result.groupProof;
  consumer.service.codex = {
    async ready() {},
    async call(_, request) {
      assert.equal(request.threadId, threadId);
      return { thread: { turns: [{ id: turnId, items: [] }] } };
    },
  };
  const retro = await runRetro(
    consumer.service,
    {
      issue: producer.issue,
      flow: { blocks: [{ label: 'Merge', attempts: [merge] }] },
      signal: new AbortController().signal,
      definition: { prompt: 'Review the fixture.' },
    },
    () => ({
      async begin() {},
      async ask() {
        return JSON.stringify({ summary: 'Reviewed fixture evidence.', recommendations: [] });
      },
      close() {},
    })
  );
  const { sections } = JSON.parse(readFileSync(retro.evidence[0].path));
  const [verification] = JSON.parse(readFileSync(sections.groupVerifications.path));
  const [attempt] = JSON.parse(readFileSync(sections.attempts.path));
  const [thread] = JSON.parse(readFileSync(sections.threads.path));
  assert.equal(attempt.result.groupProof.turnId, turnId);
  assert.equal(verification.attemptId, attempt.id);
  assert.equal(verification.threadId, thread.id);
  assert.equal(verification.turnId, thread.turns[0].id);
  assert.deepEqual(thread.turns[0].attemptIds, [attempt.id]);
  assert.equal(verification.head, head);
  assert.equal(verification.tree, tree);
  const read = ({ path, sha256 }) => {
    assert.ok(path.startsWith(consumer.root + '/'));
    const bytes = readFileSync(path);
    assert.equal(digest(bytes), sha256);
    return bytes.toString();
  };
  assert.equal(JSON.parse(read(verification.proof))[0].id, 'attached');
  assert.deepEqual(
    verification.logs.map(({ command }) => command),
    checks.map(([command]) => command)
  );
  for (const [index, [command, output]] of checks.entries()) {
    assert.equal(read(verification.logs[index]), `$ ${command}\n${output}\n\nStatus: completed, exit: 0`);
  }
  t.diagnostic(
    JSON.stringify({
      attemptId: attempt.id,
      threadId,
      turnId,
      head,
      tree,
      proof: { sha256: verification.proof.sha256, contents: read(verification.proof) },
      logs: verification.logs.map((log) => ({ command: log.command, sha256: log.sha256, contents: read(log) })),
    })
  );
}

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

test('Merge requires approval of its exact commit and target', async (t) => {
  const f = mergeFixture(t);
  await f.run('understand');
  const first = await f.run('merge', humanFirstMerge);
  assert.equal(first.status, 'blocked');
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['push', 'ready']
  );
  const result = await approveMerge(f, first);
  assert.equal(result.result.revision, 'actual-merge');
  assert.equal(result.workspace.pr, 9);
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['push', 'ready', 'push', 'ready', 'ready', 'merge']
  );
  assert.equal(f.calls.filter((item) => item.method === 'guard').at(-1).args[2], 'merge');
});

test('Automatic Merge can continue from a previously saved approval handoff', async (t) => {
  const f = mergeFixture(t);
  await f.run('understand');
  const prepared = await f.run('merge', humanFirstMerge);
  assert.ok(prepared.result.mergeConfirmation);

  const merged = await f.run('merge', {
    definition: { mergeWorkflow: { ...humanFirstMerge.definition.mergeWorkflow, policy: 'automatic' } },
    attempts: [approvalAttempt(prepared)],
    continuing: true,
  });

  assert.equal(merged.result.revision, 'actual-merge');
  assert.equal(merged.result.mergeConfirmation, undefined);
});

test('Merge pushes each new candidate, then expires approval if the target moves again', async (t) => {
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
    ['push', 'push', 'ready']
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

test('Merge repairs a target conflict before requesting GitHub readiness', async (t) => {
  const { inspectReadiness } = await import('./factory-ui/strategy-readiness.mjs');
  let observed = false;
  const f = mergeFixture(t, {
    async onReady(pr, branch, head, { waitForChecks } = {}) {
      if (observed) return;
      observed = true;
      const live = {
        headRefOid: head,
        baseRefName: 'dev',
        baseRefOid: f.flow.workspace.base,
        baseRef: { target: { oid: f.git('rev-parse', 'dev') } },
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'APPROVED',
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: { nodes: [{ name: 'test', isRequired: true, status: 'COMPLETED', conclusion: 'SUCCESS' }] },
                },
              },
            },
          ],
        },
      };
      const provider = {
        config: { repository: 'test/fixture', target: 'dev' },
        gh: () => JSON.stringify([{ data: { repository: { pullRequest: live } } }]),
      };
      await inspectReadiness(provider, pr, branch, head, undefined, waitForChecks);
    },
  });
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
    ['push', 'ready', 'ready', 'ready', 'merge']
  );
  assert.equal(issueGit('merge-base', 'HEAD', 'dev'), f.git('rev-parse', 'dev'));
  assert.equal(readFileSync(join(checkout, 'source.txt'), 'utf8'), 'Issue and target changes.\n');
});

test('Merge repairs a target conflict before waiting for pending GitHub readiness', async (t) => {
  const { inspectReadiness } = await import('./factory-ui/strategy-readiness.mjs');
  let repaired = false;
  const f = mergeFixture(t, {
    async onReady(pr, branch, head, { waitForChecks } = {}) {
      if (repaired) return;
      assert.equal(head, issueGit('rev-parse', 'HEAD'));
      const provider = { config: { repository: 'test/fixture', target: 'dev' } };
      await inspectReadiness(provider, { ...pr, mergeable: null }, branch, head, undefined, waitForChecks);
    },
    onWait() {
      assert.ok(repaired, 'A target conflict must reach repair before GitHub polling waits.');
    },
  });
  await f.run('understand');
  const { checkout } = f.flow.workspace;
  const issueGit = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  writeFileSync(join(checkout, 'source.txt'), 'Issue changes.\n');
  issueGit('commit', '-am', 'Issue changes');
  const publishedHead = issueGit('rev-parse', 'HEAD');
  f.publishHead(publishedHead);
  writeFileSync(join(f.root, 'source.txt'), 'Target changes.\n');
  f.git('commit', '-am', 'Target changes');
  const target = f.git('rev-parse', 'dev');
  const turn = f.connection.turn.bind(f.connection);
  f.connection.turn = async (...args) => {
    assert.match(issueGit('ls-files', '-u'), /source\.txt/);
    writeFileSync(join(checkout, 'source.txt'), 'Issue and target changes.\n');
    issueGit('add', 'source.txt');
    issueGit('commit', '--no-edit');
    repaired = true;
    return turn(...args);
  };

  const result = await f.run('merge');

  assert.equal(result.result.revision, 'actual-merge');
  assert.equal(issueGit('merge-base', 'HEAD', target), target);
  assert.equal(issueGit('merge-base', 'HEAD', publishedHead), publishedHead);
  assert.equal(readFileSync(join(checkout, 'source.txt'), 'utf8'), 'Issue and target changes.\n');
});

test('Merge reports a GitHub conflict immediately when the issue already contains the target', async (t) => {
  const { inspectReadiness } = await import('./factory-ui/strategy-readiness.mjs');
  const f = mergeFixture(t, {
    async onReady(pr, branch, head, { waitForChecks } = {}) {
      const provider = { config: { repository: 'test/fixture', target: 'dev' } };
      await inspectReadiness(provider, { ...pr, mergeable: false }, branch, head, undefined, waitForChecks);
    },
    onWait() {
      assert.fail('A reported conflict must not enter the GitHub checks wait.');
    },
  });
  await f.run('understand');
  f.connection.turn = async () => assert.fail('There are no local conflicts to repair.');

  await assert.rejects(f.run('merge'), /GitHub reports a merge conflict, but the issue branch already contains/);
});

test('Merge preserves each GitHub browser failure and pushes all three repair candidates in order', async (t) => {
  let failedEvidence;
  let repairs = 0;
  const f = mergeFixture(t, {
    onReady() {
      if (repairs < 3) {
        const folder = join(f.root, '.issues/failed-merge-' + repairs);
        mkdirSync(folder, { recursive: true });
        const log = join(folder, 'browser.log');
        const commandLog = join(folder, 'command.log');
        const summary = join(folder, 'summary.json');
        writeFileSync(log, 'AssertionError: Only explicit Send starts a reply\n');
        writeFileSync(commandLog, 'Initial verification failed.\n');
        writeFileSync(
          summary,
          JSON.stringify({
            checks: [
              { name: 'build', passed: true },
              { name: 'browser', passed: false, exit: 1, log },
            ],
          })
        );
        const evidence = [
          { key: 'log', path: commandLog, label: 'Verification command output' },
          { path: summary, label: 'Verification summary' },
          { path: log, label: 'Failed verification checkpoint' },
        ].map((item) => ({ ...item, sha256: digest(readFileSync(item.path)) }));
        failedEvidence ??= evidence;
        throw Object.assign(Error('Closure waited for background resource checks.'), {
          code: 'ci-failure',
          verificationFailure: { summaries: [summary], logs: [log] },
          evidence,
        });
      }
    },
  });
  await f.run('understand');
  const turn = f.connection.turn.bind(f.connection);
  f.connection.turn = async (...args) => {
    const [, checkout, prompt] = args;
    assert.match(prompt, /repair inherited test failures/);
    assert.match(prompt, /Name the exact failed tests/);
    assert.match(prompt, /dedicated PR repair check/);
    assert.match(prompt, /do not duplicate full-suite runs/);
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
    writeFileSync(join(checkout, 'source.txt'), 'Browser repair ' + repairs + '\n');
    execFileSync('git', ['-C', checkout, 'commit', '-am', 'Repair inherited browser failure']);
    await turn(...args);
    const files = { result: '.issues/result.json', log: '.issues/merge.log' };
    for (const [key, file] of Object.entries(files))
      writeFileSync(join(checkout, file), JSON.stringify({ key, round: repairs }) + '\n');
    const logs = ['.issues/ci-repair.log'];
    writeFileSync(join(checkout, logs[0]), 'CI repair command ' + repairs + '\n');
    return 'Repair ' + repairs + '\n```flow-result\n' + JSON.stringify({ files, repair: { logs } }) + '\n```';
  };
  const result = await f.run('merge', {
    definition: {
      mergeWorkflow: { policy: 'automatic', pollSeconds: 5, checkTimeoutSeconds: 900, repairAttempts: 3 },
      artifacts: [
        { key: 'result', kind: 'file', label: 'Repair result' },
        { key: 'log', kind: 'file', label: 'Target fetch and merge output' },
      ],
    },
  });
  assert.equal(repairs, 3);
  assert.equal(result.result.revision, 'actual-merge');
  const selectedLog = result.artifacts.files.log;
  assert.ok(selectedLog.path.endsWith('/merge.log'));
  assert.equal(selectedLog.label, 'Target fetch and merge output');
  assert.match(readFileSync(selectedLog.path, 'utf8'), /\$ git push origin /);
  assert.deepEqual(result.evidence.slice(0, failedEvidence.length), failedEvidence);
  for (const checkpoint of failedEvidence) {
    assert.equal(digest(readFileSync(checkpoint.path)), checkpoint.sha256);
  }
  assert.equal(readFileSync(failedEvidence[0].path, 'utf8'), 'Initial verification failed.\n');
  const index = result.evidence.find(({ label }) => label === 'Merge repair index');
  const retrieve = ({ path, sha256 }) => {
    const bytes = readFileSync(path);
    assert.equal(digest(bytes), sha256);
    return bytes.toString();
  };
  const { attempts, attemptId, delivery } = JSON.parse(retrieve(index));
  const checkout = f.flow.workspace.checkout;
  assert.equal(delivery.candidate.commit, result.result.head);
  assert.equal(delivery.candidate.tree, f.git('-C', checkout, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(delivery.target.commit, result.result.target);
  assert.deepEqual(delivery.merge.parents, [delivery.target.commit, delivery.candidate.commit]);
  assert.equal(delivery.merge.commit, result.result.revision);
  assert.deepEqual(
    delivery.checks.map(({ runId, jobId }) => [runId, jobId]),
    [['90', '91']]
  );
  assert.deepEqual(
    attempts.map(({ round }) => round),
    [1, 2, 3]
  );
  const messages = conversationMessages(f.root, f.issue.id);
  for (const [i, record] of attempts.entries()) {
    const { round, candidate, conversation } = record;
    const { evidence } = JSON.parse(retrieve(record.result));
    const requestId = 'flow-request-' + attemptId + '-repair-' + round;
    const responseId = 'flow-result-' + attemptId + '-repair-' + round;
    const turnRecord = evidence.find(({ repairTurn }) => repairTurn);
    assert.deepEqual(JSON.parse(retrieve(turnRecord)).logs.map(retrieve), [
      JSON.stringify({ key: 'log', round }) + '\n',
      'CI repair command ' + round + '\n',
    ]);
    assert.deepEqual(conversation, {
      turnId: turnRecord.repairTurn.turnId,
      threadId: 'the-one-issue-chat',
      requestId,
      responseId,
      requestedAt: messages.find(({ id }) => id === requestId).at,
      respondedAt: messages.find(({ id }) => id === responseId).at,
    });
    assert.ok(record.startedAt <= conversation.requestedAt);
    assert.ok(conversation.requestedAt <= conversation.respondedAt);
    assert.ok(conversation.respondedAt <= record.finishedAt);
    assert.equal(candidate, attempts[i + 1]?.failedHead ?? result.result.head);
    assert.equal(record.failure.revision.commit, record.failedHead);
    assert.equal(record.failure.revision.comparisonTarget, delivery.target.commit);
    assert.equal(record.repairedRevision.commit, candidate);
    assert.match(retrieve(record.failure.checks[0].log), /Only explicit Send starts a reply/);
    assert.ok(f.observations.some(({ operation, head }) => operation === 'push' && head === candidate));
    assert.match(retrieve(record.log), /\$ git fetch /);
    for (const file of record.failure.evidence) {
      assert.ok(file.path.includes('/repair-' + round + '/'));
      retrieve(file);
    }
    for (const key of ['result', 'log']) {
      const file = evidence.find(({ path }) =>
        path.endsWith('artifact-' + key + '-' + (key === 'log' ? 'merge.log' : 'result.json'))
      );
      assert.ok(file.path.includes('/repair-' + round + '/'));
      assert.deepEqual(JSON.parse(retrieve(file)), { key, round });
    }
    t.diagnostic(
      JSON.stringify({
        round,
        candidate,
        conversation,
        resultSha256: record.result.sha256,
        logSha256: record.log.sha256,
      })
    );
  }
  await verifyRepairRetrospective(t, f, { id: attemptId, ...result }, turn);
});

async function verifyRepairRetrospective(t, f, merge, turn) {
  const checkout = f.flow.workspace.checkout;
  const newPath = join(f.root, 'source.txt');
  writeFileSync(newPath, 'Target source change.\n');
  f.git('commit', '-am', 'Introduce a conflict on the target');
  let retries = 0;
  f.connection.turn = async (...args) => {
    await turn(...args);
    retries++;
    if (retries === 2) {
      writeFileSync(join(checkout, 'source.txt'), 'Browser repair 3\nTarget source change.\n');
      f.git('-C', checkout, 'add', 'source.txt');
    }
    const logs = ['.issues/conflict-command.log'];
    writeFileSync(join(checkout, logs[0]), 'Conflict command ' + retries + '\n');
    return 'Conflict work\n```flow-result\n' + JSON.stringify({ repair: { logs } }) + '\n```';
  };
  const branch = await f.run('update-branch');
  assert.equal(retries, 2);
  assert.equal(f.git('-C', checkout, 'rev-parse', 'HEAD^2'), f.git('rev-parse', 'dev'));

  const conflict = { id: 'attempt-3', ...branch };
  const attempts = [merge, conflict];
  const turnFiles = attempts.flatMap(({ evidence }) => evidence.filter(({ repairTurn }) => repairTurn));
  assert.equal(turnFiles.length, 5);
  const bytes = new Map();
  const artifacts = {
    async put({ body }) {
      const hash = digest(body);
      bytes.set(hash, body);
      return hash;
    },
    async get(hash) {
      return bytes.get(hash);
    },
  };
  const manifest = await collectEvidence({ root: f.root, flow: attempts, artifacts });
  assert.deepEqual(manifest.gaps, []);
  for (const file of turnFiles) {
    for (const log of JSON.parse(readFileSync(file.path)).logs) rmSync(log.path);
    rmSync(file.path);
  }
  rmSync(join(checkout, '.issues'), { recursive: true });

  const resolver = await hydrateEvidence({ manifest, artifacts, directory: join(f.root, '.issues/hydrated') });
  const repairIndex = merge.evidence.find(({ label }) => label === 'Merge repair index');
  const durable = JSON.parse(resolver.read(repairIndex.path, repairIndex.sha256));
  for (const record of durable.attempts) {
    const { log } = record.failure.checks[0];
    assert.match(resolver.read(log.path, log.sha256).toString(), /Only explicit Send starts a reply/);
    for (const file of record.failure.evidence) rmSync(file.path);
  }
  assert.deepEqual(durable.delivery.merge.parents, [merge.result.target, merge.result.head]);
  rmSync(repairIndex.path);
  t.after(registerEvidenceResolver(f.root, resolver));
  f.service.store.directory = join(f.root, '.issues');
  f.service.codex = {
    async ready() {},
    async call() {
      return { thread: { turns: turnFiles.map(({ repairTurn }) => ({ id: repairTurn.turnId, items: [] })) } };
    },
  };
  const outcome = await runRetro(
    f.service,
    {
      issue: f.issue,
      flow: {
        ...f.flow,
        blocks: [
          { label: 'Merge', attempts: [merge] },
          { label: 'Update Branch', attempts: [conflict] },
        ],
      },
      signal: new AbortController().signal,
      definition: { prompt: 'Review the fixture.' },
    },
    () => ({
      async begin() {},
      async ask() {
        return JSON.stringify({ summary: 'Reviewed fixture evidence.', recommendations: [] });
      },
      close() {},
    })
  );
  const index = JSON.parse(readFileSync(outcome.evidence[0].path));
  const repairs = JSON.parse(readFileSync(index.sections.repairs.path));
  const [mergeRepair] = JSON.parse(readFileSync(index.sections.mergeRepairs.path));
  assert.deepEqual(mergeRepair.delivery, durable.delivery);
  for (const record of mergeRepair.attempts) {
    const { log } = record.failure.checks[0];
    assert.match(readFileSync(log.path, 'utf8'), /Only explicit Send starts a reply/);
  }
  const threads = JSON.parse(readFileSync(index.sections.threads.path));
  assert.deepEqual(
    repairs.map(({ logs }) =>
      logs.map(({ path, sha256 }) => {
        const content = readFileSync(path);
        assert.equal(digest(content), sha256);
        return content.toString().trim();
      })
    ),
    [
      ['{"key":"log","round":1}', 'CI repair command 1'],
      ['{"key":"log","round":2}', 'CI repair command 2'],
      ['{"key":"log","round":3}', 'CI repair command 3'],
      ['Conflict command 1'],
      ['Conflict command 2'],
    ]
  );
  for (const repair of repairs) {
    const thread = threads.find(({ id }) => id === repair.threadId);
    const turn = thread.turns.find(({ id }) => id === repair.turnId);
    assert.deepEqual(turn.attemptIds, [repair.attemptId]);
    assert.deepEqual(turn.repairAttemptIds, [repair.id]);
  }
  t.diagnostic(
    JSON.stringify(repairs.map(({ id, turnId, logs }) => ({ id, turnId, hashes: logs.map(({ sha256 }) => sha256) })))
  );
}

for (const thrown of [false, true])
  test(`Merge names the failed test when its repair ${thrown ? 'throws' : 'returns blocked'}`, async (t) => {
    let failure;
    const f = mergeFixture(t, {
      onReady() {
        const folder = join(f.root, '.issues/failed-browser');
        mkdirSync(folder, { recursive: true });
        const summary = join(folder, 'summary.json');
        writeFileSync(summary, JSON.stringify({ checks: [{ name: 'browser', passed: false }] }));
        failure = Object.assign(Error('Fixture issues are absent from the initialized store.'), {
          code: 'ci-failure',
          verificationFailure: { summaries: [summary], logs: [] },
        });
        throw failure;
      },
    });
    await f.run('understand');
    f.connection.turn = async () => {
      if (thrown) throw Error('Three repair approaches were exhausted.');
      return '```flow-result\n' + JSON.stringify({ failure: 'Three repair approaches were exhausted.' }) + '\n```';
    };
    await assert.rejects(
      f.run('merge', {
        definition: {
          artifacts: [],
          mergeWorkflow: { policy: 'automatic', pollSeconds: 5, checkTimeoutSeconds: 900, repairAttempts: 3 },
        },
      }),
      (error) => {
        assert.match(error.message, /tests or verification checks failed.*browser/i);
        assert.match(error.message, /Three repair approaches were exhausted/);
        assert.match(error.message, /Fixture issues are absent/);
        assert.deepEqual(error.verificationFailure, failure.verificationFailure);
        return true;
      }
    );
    assert.deepEqual(
      f.observations.map(({ operation }) => operation),
      ['push', 'ready']
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

test('Work preserves distinct bases after Update Branch and a no-change result through Publish inputs', async (t) => {
  const checkedBases = [];
  const f = fixture(t, {
    async verifyWork(_ctx, workspace) {
      checkedBases.push(workspace.base);
      return { evidence: [] };
    },
  });
  f.git('remote', 'add', 'origin', f.root);
  const first = await f.run('work');
  const originalBase = first.workspace.base;
  writeFileSync(join(f.root, 'incoming.txt'), 'Incoming change.\n');
  f.git('add', 'incoming.txt');
  f.git('commit', '-m', 'Advance destination');
  const comparisonBase = f.git('rev-parse', 'HEAD');
  await f.run('update-branch');
  const beforeWork = f.git('-C', f.flow.workspace.checkout, 'rev-parse', 'HEAD');
  const worked = await f.run('work');
  assert.notEqual(comparisonBase, originalBase);
  assert.equal(worked.result.head, beforeWork, 'Work returns the existing commit without changes.');
  assert.equal(worked.workspace.base, originalBase);
  assert.equal(checkedBases.at(-1), comparisonBase);
  const prompt = JSON.parse(f.calls.filter(({ method }) => method === 'turn').at(-1).prompt);
  assert.equal(prompt.workComparisonBase, comparisonBase);
  assert.equal(prompt.destinationRevision, comparisonBase);
  assert.equal(worked.result.base, comparisonBase);
  assert.equal(worked.result.workspaceBase, originalBase);
  assert.equal(worked.artifacts.values.candidateBase, comparisonBase);
  assert.equal(worked.artifacts.values.candidateWorkspaceBase, originalBase);
  assert.equal(worked.artifacts.values.candidate, beforeWork);
  assert.equal(worked.artifacts.values.candidateUncommitted, false);
  const work = {
    id: 'work',
    kind: 'work',
    label: 'Work',
    after: [],
    attempts: [{ ...worked, status: 'completed' }],
  };
  const publish = { id: 'publish', kind: 'publish', label: 'Publish PR', after: ['work'], attempts: [] };
  f.flow.blocks = [work, publish];
  const definitions = definitionMap(new BlockCatalog(f.root).read().entries);
  const details = blockDetails(f.flow, f.issue, publish, definitions);
  assert.equal(details.find(({ key }) => key === 'candidateBase').value, comparisonBase);
  const workspaceDetail = details.find(({ key }) => key === 'candidateWorkspaceBase');
  assert.equal(workspaceDetail.value, originalBase);
  assert.equal(workspaceDetail.label, 'Original workspace base');
});

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
    await assert.rejects(f.run('work'), /legacy assignment still owns/);
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

test('a new Merge run preserves and resolves an in-progress merge of the current target', async (t) => {
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
    assert.equal(work('rev-parse', 'MERGE_HEAD'), f.git('rev-parse', 'dev'));
    writeFileSync(join(checkout, 'source.txt'), 'Both implementations.\n');
    work('add', 'source.txt');
    work('commit', '--no-edit');
    return turn(...args);
  };
  const result = await f.run('merge');
  assert.equal(result.result.revision, 'actual-merge');
  assert.equal(work('merge-base', 'HEAD', saved), saved);
  assert.equal(work('status', '--porcelain'), '');
  assert.equal(commands.filter((args) => args.join(' ') === 'merge --abort').length, 0);
});

test('Update Branch shows the worker decision when its response leaves conflicts unresolved', async (t) => {
  const f = await branchUpdateFixture(t, 'source.txt');
  f.advance();
  writeFileSync(join(f.checkout, 'source.txt'), 'Issue change.\n');
  f.connection.turn = async () =>
    'Decision needed: include or exclude the installed agent tooling?\n\n```flow-result\n{"status":"failure","values":{"decision":"Choose the audit scope."}}\n```';
  await assert.rejects(f.run('update-branch'), /Decision needed: include or exclude the installed agent tooling/);
});

for (const dependencyProblem of [
  'installed dependencies do not match the snapshot lockfile.',
  'installed dependency lock missing: node_modules/.pnpm/lock.yaml.',
]) {
  test(`Update Branch stops conflict retries when dependency preflight reports ${dependencyProblem}`, async (t) => {
    const f = await branchUpdateFixture(t, 'source.txt');
    const target = f.advance();
    writeFileSync(join(f.checkout, 'source.txt'), 'Issue edit.\n');
    f.work('commit', '-am', 'Issue change');
    const head = f.work('rev-parse', 'HEAD');
    const hooks = join(f.root, '.git', 'hooks');
    const countFile = join(f.checkout, '.issues', 'commit-hook-count');
    f.git('config', 'core.hooksPath', hooks);
    writeFileSync(
      join(hooks, 'pre-commit'),
      '#!/bin/sh\nprintf x >> .issues/commit-hook-count\n' +
        'echo "Execution preflight: ' +
        dependencyProblem +
        ' Run pnpm install --frozen-lockfile in this checkout." >&2\nexit 1\n',
      { mode: 0o755 }
    );
    let calls = 0;
    const turn = f.connection.turn.bind(f.connection);
    f.connection.turn = async (...args) => {
      calls++;
      writeFileSync(join(f.checkout, 'source.txt'), 'Issue and target edits.\n');
      f.work('add', 'source.txt');
      return turn(...args);
    };
    let failure;
    await assert.rejects(f.run('update-branch'), (error) => {
      failure = error;
      return true;
    });
    assert.equal(calls, 1, 'Dependency failures cannot be repaired by another conflict-resolution turn.');
    assert.equal(readFileSync(countFile, 'utf8'), 'x');
    assert.match(failure.message, /pnpm install --frozen-lockfile/);
    assert.equal(f.work('rev-parse', 'HEAD'), head);
    assert.equal(f.work('rev-parse', 'MERGE_HEAD'), target);
    assert.equal(f.work('diff', '--name-only', '--diff-filter=U'), '');
    assert.equal(f.work('show', ':source.txt'), 'Issue and target edits.');
  });
}

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

test('Merge gives a new blocker its own repair budget and keeps pushing changed candidates', async (t) => {
  let repairs = 0;
  const f = mergeFixture(t, {
    onReady() {
      if (repairs >= 4) return;
      throw Object.assign(Error(repairs < 3 ? 'First broken check' : 'Second broken check'), {
        code: 'ci-failure',
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
    onReady() {
      throw Object.assign(Error('Same broken check'), {
        code: 'ci-failure',
        verificationFailure: { summaries: [] },
        blockerKey: 'same',
      });
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

test('Merge downloads failed GitHub verification evidence, repairs it, pushes and merges', async (t) => {
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
  assert.equal(f.observations.filter(({ operation }) => operation === 'push').length, 2);
});

test('Merge stops when repairs cycle back to the same failing source tree', async (t) => {
  let repairs = 0;
  const f = mergeFixture(t, {
    onReady() {
      throw Object.assign(Error('Same broken check'), {
        code: 'ci-failure',
        verificationFailure: { summaries: [] },
        blockerKey: 'same',
      });
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
      if (args[0] === 'api') return JSON.stringify({ head_sha: 'expected', run_attempt: 1 });
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
  assert.deepEqual(
    error.githubRuns.map(({ head, runId, attempt, checks }) => [head, runId, attempt, checks[0].jobId]),
    [['expected', '77', 1, '88']]
  );
});

test('Merge retries temporary readiness failures before merging', async (t) => {
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
    f.observations.map(({ operation }) => operation),
    ['push', 'ready', 'ready', 'ready', 'ready', 'merge']
  );
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

test('Merge Continue checks GitHub again before merging', async (t) => {
  const f = mergeFixture(t);
  await f.run('understand');
  const prepared = await f.run('merge', humanFirstMerge);
  f.observations.length = 0;
  const result = await approveMerge(f, prepared);
  assert.equal(result.result.revision, 'actual-merge');
  assert.deepEqual(
    f.observations.map(({ operation }) => operation),
    ['push', 'ready', 'ready', 'merge']
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
});

for (const transient of [true, false]) {
  test('Merge can retry after exhausted or permanent GitHub failures: ' + transient, async (t) => {
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
    await assert.rejects(approveMerge(f, prepared), (error) => {
      assert.match(error.message, transient ? /HTTP 503/ : /HTTP 403/);
      return true;
    });
    assert.equal(requests, transient ? 4 : 1);
    failed = false;
    const result = await f.run('merge');
    assert.equal(result.result.revision, 'actual-merge');
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

void test('Merge waits for newly published checks to register before merging', async (t) => {
  const { inspectReadiness } = await import('./factory-ui/strategy-readiness.mjs');
  let waiting = true;
  let waits = 0;
  const f = mergeFixture(t, {
    onReady(pr, branch, head, settings) {
      const required = {
        __typename: 'CheckRun',
        name: 'test',
        isRequired: true,
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
      };
      const view = {
        headRefOid: head,
        baseRefName: 'dev',
        baseRefOid: f.git('rev-parse', 'dev'),
        mergeStateStatus: waiting ? 'BLOCKED' : 'CLEAN',
        reviewDecision: '',
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: waiting ? [] : [required] } } } }] },
      };
      const provider = {
        config: { repository: 'test/fixture', target: 'dev' },
        gh: async () => JSON.stringify([{ data: { repository: { pullRequest: view } } }]),
      };
      return inspectReadiness(provider, pr, branch, head, undefined, settings?.waitForChecks);
    },
    onWait() {
      waits++;
      waiting = false;
    },
  });
  await f.run('understand');
  assert.equal((await f.run('merge')).result.revision, 'actual-merge');
  assert.equal(waits, 1);
  assert.equal(
    f.calls.filter(({ method }) => method === 'turn').length,
    1,
    'Pending CI must not invoke a repair worker.'
  );
});

void test('Merge refreshes the target while waiting for CI and incorporates an advance during the wait', async (t) => {
  let pending = 3;
  let fetches = 0;
  const f = mergeFixture(t, {
    onReady() {
      if (pending) throw Object.assign(Error('Required checks pending'), { code: 'STRATEGY_PENDING' });
    },
    onGit(args) {
      if (args[0] === 'fetch') fetches++;
    },
    onWait(advance) {
      if (!pending) return;
      assert.equal(fetches, 2 * (4 - pending), 'Refresh the target before and after each pending readiness request.');
      assert.equal(
        f.observations.some(({ operation }) => operation === 'verify'),
        false
      );
      if (--pending === 0) advance();
    },
  });
  await f.run('understand');
  const result = await f.run('merge');
  assert.equal(result.result.revision, 'actual-merge');
  f.git('-C', f.flow.workspace.checkout, 'merge-base', '--is-ancestor', f.git('rev-parse', 'dev'), 'HEAD');
  assert.equal(f.observations.filter(({ operation }) => operation === 'push').length, 2);
});

test('Merge waits for pending GitHub tests before merging', async (t) => {
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
});

void test('Merge extends for fresh suite progress once and accepts passing checks on the final poll', async (t) => {
  const minute = 60_000;
  const observations = [0, 15, 20, 25, 30, 30];
  const completions = [
    [],
    ['Early checks'],
    ['Early checks', 'Non-browser tests (1/2)'],
    ['Early checks', 'Non-browser tests (1/2)', 'Non-browser tests (2/2)'],
    ['Early checks', 'Non-browser tests (1/2)', 'Non-browser tests (2/2)', 'Flow browser (1/2)'],
  ];
  let time = 0;
  let polls = 0;
  let waits = 0;
  const f = mergeFixture(t, {
    mergeNow: () => time,
    onReady(_pr, _branch, head, { waitForChecks } = {}) {
      if (!waitForChecks) return;
      assert.equal(time, observations[polls] * minute, 'Readiness is checked again at the hard cap');
      const completedSuites = completions[polls++];
      if (!completedSuites) return;
      throw Object.assign(Error('Required check test is pending.'), {
        code: 'STRATEGY_PENDING',
        ciProgress: { head, completedSuites },
      });
    },
    onWait() {
      time = observations[++waits] * minute;
    },
  });
  await f.run('understand');
  assert.equal((await f.run('merge')).result.revision, 'actual-merge');
  assert.equal(polls, 6);
  assert.equal(waits, 4);
});

void test('Merge ignores completed suites for other heads and times out after one fresh observation', async (t) => {
  let time = 0;
  let polls = 0;
  let waits = 0;
  const f = mergeFixture(t, {
    mergeNow: () => time,
    onReady() {
      polls++;
      throw Object.assign(Error('Required check test is pending.'), {
        code: 'STRATEGY_PENDING',
        ciProgress: { head: 'a different commit', completedSuites: ['Early checks', 'Non-browser tests'] },
      });
    },
    onWait() {
      waits++;
      time += 15 * 60_000;
    },
  });
  await f.run('understand');
  await assert.rejects(f.run('merge'), /GitHub checks did not finish in time/);
  assert.equal(polls, 3);
  assert.equal(waits, 1);
});

void test('Merge counts a completed CI suite only once after repeated or rerun observations', async (t) => {
  const minute = 60_000;
  const observations = [0, 15, 20, 20];
  let time = 0;
  let waits = 0;
  let polls = 0;
  const f = mergeFixture(t, {
    mergeNow: () => time,
    onReady(_pr, _branch, head) {
      assert.equal(time, observations[polls] * minute);
      throw Object.assign(Error('Required check test is pending.'), {
        code: 'STRATEGY_PENDING',
        ciProgress: { head, completedSuites: polls++ ? ['Early checks'] : [] },
      });
    },
    onWait() {
      time = observations[++waits] * minute;
    },
  });
  await f.run('understand');
  await assert.rejects(f.run('merge'), /GitHub checks did not finish in time/);
  assert.equal(polls, 4);
  assert.equal(waits, 2);
});

test('Merge bounds unsuccessful merge requests and reports the last GitHub error', async (t) => {
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
    return true;
  });
  assert.equal(requests, 4);
  assert.equal(f.calls.filter(({ method }) => method === 'turn').length, 1);
});

test('Merge retains the original merge error when outcome inspection also fails', async (t) => {
  let requested = false;
  const f = mergeFixture(t, {
    onMerge() {
      requested = true;
      throw Error('HTTP 422 merge candidate rejected');
    },
    onLookup() {
      if (requested) throw Object.assign(Error('HTTP 503 outcome lookup unavailable'), { transient: true });
    },
  });
  await f.run('understand');
  await assert.rejects(f.run('merge'), (error) => {
    assert.match(error.message, /HTTP 422 merge candidate rejected/);
    assert.match(error.message, /Merge outcome could not be checked: HTTP 503 outcome lookup unavailable/);
    return true;
  });
});

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

test('shared source ownership rejects an older local checkout when another runner retains uncommitted work', async (t) => {
  const f = fixture(t);
  await f.run();
  const before = f.calls.filter((call) => call.method === 'connection').length;
  f.service.projectStores = { runnerId: 'receiver', records: { get: async () => null } };
  f.flow.sourceUnavailable = 'Newer uncommitted source remains on the sender.';
  f.flow.sourceUnavailableRunnerId = 'sender';
  await assert.rejects(f.run(), /owning runner/);
  assert.equal(f.calls.filter((call) => call.method === 'connection').length, before);
});

test('shared execution uses its canonical workspace ahead of stale local lifecycle source', async (t) => {
  const f = fixture(t);
  const original = await f.run();
  const checkout = join(f.root, '.issues/issue-work/peer-commit');
  f.git('worktree', 'add', '-b', 'codex/peer-commit', checkout, 'HEAD');
  writeFileSync(join(checkout, 'source.txt'), 'Peer committed source.\n');
  f.git('-C', checkout, 'add', 'source.txt');
  f.git('-C', checkout, 'commit', '-m', 'Peer commit');
  f.service.lifecycleRuns[f.issue.id].work = original.workspace;
  f.flow.workspace = { checkout, branch: 'codex/peer-commit', base: original.workspace.base };
  f.service.projectStores = { runnerId: 'receiver', records: { get: async () => null } };
  const result = await f.run();
  assert.equal(result.workspace.checkout, realpathSync(checkout));
  assert.equal(readFileSync(join(result.workspace.checkout, 'source.txt'), 'utf8'), 'Peer committed source.\n');
});

test('a peer checkpoint replaces a stale same-path workspace without changing its local source', async (t) => {
  const f = fixture(t);
  const original = await f.run();
  const staleBytes = readFileSync(join(original.workspace.checkout, 'source.txt'));
  const sender = join(f.root, '.issues/issue-work/sender');
  f.git('worktree', 'add', '-b', 'codex/sender', sender, 'HEAD');
  writeFileSync(join(sender, 'source.txt'), 'New shared checkpoint.\n');
  f.git('-C', sender, 'add', 'source.txt');
  f.git('-C', sender, 'commit', '-m', 'Shared checkpoint');
  const { openArtifactStore } = await import('./factory-ui/stores/artifacts.mjs');
  const { createSourceCheckpoint } = await import('./factory-ui/stores/source-checkpoints.mjs');
  const artifacts = await openArtifactStore(
    { id: 'files', kind: 'files' },
    { root: f.root, projectId: 'source-fixture' }
  );
  f.flow.sourceCheckpoint = await createSourceCheckpoint({
    checkout: sender,
    artifacts,
    projectId: 'source-fixture',
    base: original.workspace.base,
  });
  f.flow.workspaceRunnerId = 'sender';
  f.service.projectStores = {
    runnerId: 'receiver',
    projectId: 'source-fixture',
    artifacts,
    issueArtifacts: async () => artifacts,
  };
  const result = await f.run();
  assert.notEqual(result.workspace.checkout, original.workspace.checkout);
  assert.equal(readFileSync(join(result.workspace.checkout, 'source.txt'), 'utf8'), 'New shared checkpoint.\n');
  assert.deepEqual(readFileSync(join(original.workspace.checkout, 'source.txt')), staleBytes);
});

test('block override reaches the provider while confirmed provider changes start a fresh conversation', async (t) => {
  const f = fixture(t);
  f.flow.executionSettings = { values: { model: 'gpt-6-astra', effort: 'high' }, sources: {}, basis: 'frozen' };
  saveConversationState(f.root, f.issue.id, {
    flowBlocks: { 'block-work': { threadId: 'anthropic:previous', basis: 'old' } },
  });
  await assert.rejects(f.run('work', { model: 'gpt-6.1-sol', continuing: true }), /Confirm the provider handoff/);
  assert.equal(
    f.calls.some((call) => call.method === 'turn'),
    false
  );
  const handoff = {
    fromThreadId: 'anthropic:previous',
    toModel: 'gpt-6.1-sol',
    summary: 'Keep the prior diagnosis.',
    history: 'retained-history.json',
  };
  const result = await f.run('work', { model: 'gpt-6.1-sol', continuing: true, modelHandoff: handoff });
  const turn = f.calls.find((call) => call.method === 'turn');
  assert.equal(turn.settings.model, 'gpt-6.1-sol');
  assert.equal(result.modelSettings.model, 'gpt-6.1-sol');
  assert.equal(f.flow.executionSettings.values.model, 'gpt-6-astra');
  assert.equal(
    f.calls.some((call) => call.method === 'resume'),
    false
  );
  assert.match(f.calls.find((call) => call.method === 'start').instructions, /Keep the prior diagnosis/);
});
