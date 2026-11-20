import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BranchRepairs, branchCheckFailure } from './factory-ui/branch-repair.mjs';
import { branchRepairSource } from './factory-ui/branch-repair-workspace.mjs';
import { BlockCatalog } from './factory-ui/block-catalog.mjs';
import { git } from './factory-ui/common.mjs';

function fixture(t, run) {
  const root = mkdtempSync(join(tmpdir(), 'timey-branch-repair-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.issues'));
  git(root, 'init', '-q', '-b', 'dev');
  git(root, 'config', 'user.name', 'Branch repair check');
  git(root, 'config', 'user.email', 'repair@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.issues/\n');
  writeFileSync(join(root, 'source.txt'), 'Original\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Initial source');
  const base = git(root, 'rev-parse', 'HEAD');
  const checkout = join(root, '.issues/issue-work/test');
  git(root, 'worktree', 'add', '-qb', 'codex/issue-test', checkout, base);
  const issue = { id: '20261120-branch-repair', state: 'backlog' };
  const flow = {
    issueId: issue.id,
    revision: 1,
    blocks: [],
    workspace: { checkout, base, branch: 'codex/issue-test' },
  };
  const pauses = [];
  const flows = {
    service: { root },
    active: new Map(),
    catalog: new BlockCatalog(root),
    groups: { requireIndependent() {} },
    pauseAutoplay: (...args) => pauses.push(args),
  };
  const repairs = new BranchRepairs(flows, { run });
  const start = () => repairs.action(issue, flow, { action: 'branch-repair-start', revision: 1 });
  const finish = async () => {
    await repairs.active.get(issue.id)?.task;
    await Promise.resolve();
  };
  const approve = () => {
    const record = repairs.read(issue.id);
    return repairs.action(issue, flow, {
      action: 'branch-repair-approve',
      revision: 1,
      repairId: record.id,
      candidateTree: record.candidateTree,
    });
  };
  return { root, checkout, issue, flow, repairs, flows, start, finish, approve, pauses };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('repair progress survives reads and approval applies only the reviewed delta, preserving staged and uncommitted work', async (t) => {
  const release = deferred();
  const f = fixture(t, async ({ run, progress, step, retain }) => {
    assert.equal(readFileSync(join(run.checkout, 'source.txt'), 'utf8'), 'User edit\n');
    assert.equal(readFileSync(join(run.checkout, 'staged.txt'), 'utf8'), 'Staged by user\n');
    progress('Fallow: checking source\n');
    step('Repairing Fallow');
    await release.promise;
    writeFileSync(join(run.checkout, 'repair.txt'), 'Repair\n');
    retain({ checks: [{ label: 'Work formatting and Fallow output' }] });
  });
  writeFileSync(join(f.checkout, 'staged.txt'), 'Staged by user\n');
  git(f.checkout, 'add', 'staged.txt');
  writeFileSync(join(f.checkout, 'source.txt'), 'User edit\n');
  const before = branchRepairSource(f.checkout);
  await f.start();
  const progress = f.repairs.view(f.issue, f.flow);
  assert.equal(progress.status, 'running');
  assert.match(progress.output, /Fallow: checking/);
  assert.equal(progress.step, 'Repairing Fallow');
  await assert.rejects(f.start(), /already running/);
  assert.deepEqual(branchRepairSource(f.checkout), before);
  release.resolve();
  await f.finish();
  const ready = f.repairs.view(f.issue, f.flow);
  assert.equal(ready.status, 'ready');
  assert.match(ready.diff, /repair.txt/);
  assert.doesNotMatch(ready.diff, /User edit|Staged by user/);
  await f.approve();
  assert.equal(readFileSync(join(f.checkout, 'repair.txt'), 'utf8'), 'Repair\n');
  assert.equal(readFileSync(join(f.checkout, 'source.txt'), 'utf8'), 'User edit\n');
  assert.equal(git(f.checkout, 'write-tree'), before.index);
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), before.head);
  assert.equal(f.repairs.view(f.issue, f.flow).status, 'applied');
  assert.equal(f.flow.revision, 1);
});

test('edits during repair make its candidate stale and approval preserves the new edits', async (t) => {
  const f = fixture(t, async ({ run }) => writeFileSync(join(run.checkout, 'source.txt'), 'Candidate\n'));
  await f.start();
  await f.finish();
  writeFileSync(join(f.checkout, 'source.txt'), 'New edit\n');
  assert.equal(f.repairs.view(f.issue, f.flow).status, 'stale');
  await assert.rejects(f.approve(), /checkout or check configuration changed/);
  assert.equal(readFileSync(join(f.checkout, 'source.txt'), 'utf8'), 'New edit\n');
});

test('candidate or patch tampering cannot be approved', async (t) => {
  const f = fixture(t, async ({ run }) => writeFileSync(join(run.checkout, 'source.txt'), 'Candidate\n'));
  await f.start();
  await f.finish();
  const record = f.repairs.read(f.issue.id);
  writeFileSync(join(record.folder, 'repair.patch'), 'altered');
  await assert.rejects(f.approve(), /patch changed/);
  writeFileSync(join(record.checkout, 'source.txt'), 'Altered candidate\n');
  assert.equal(f.repairs.view(f.issue, f.flow).status, 'stale');
  await assert.rejects(f.approve(), /candidate changed/);
  assert.equal(readFileSync(join(f.checkout, 'source.txt'), 'utf8'), 'Original\n');
});

test('failed checks retain their cause and never expose an approvable candidate', async (t) => {
  const f = fixture(t, async ({ progress }) => {
    progress('Fallow failed in source.txt\n');
    throw Error('Required Fallow check failed');
  });
  await f.start();
  await f.finish();
  const view = f.repairs.view(f.issue, f.flow);
  assert.equal(view.status, 'failed');
  assert.match(view.error, /Fallow/);
  assert.match(view.output, /source.txt/);
  await assert.rejects(f.approve(), /Review the current/);
});

test('Stop ends the repair while keeping issue work untouched', async (t) => {
  const f = fixture(
    t,
    async ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
  );
  const before = branchRepairSource(f.checkout);
  await f.start();
  await f.repairs.action(f.issue, f.flow, { action: 'branch-repair-stop' });
  await f.finish();
  assert.equal(f.repairs.view(f.issue, f.flow).status, 'stopped');
  assert.deepEqual(branchRepairSource(f.checkout), before);
});

test('a new server shows an interrupted operation rather than a permanent spinner and refuses a duplicate start', async (t) => {
  const release = deferred();
  const f = fixture(t, () => release.promise);
  await f.start();
  const restarted = new BranchRepairs(f.flows);
  assert.equal(restarted.view(f.issue, f.flow).status, 'interrupted');
  await assert.rejects(
    restarted.action(f.issue, f.flow, { action: 'branch-repair-start', revision: 1 }),
    /interrupted/
  );
  release.resolve();
  await f.finish();
});

test('missing proof alone is not a broken branch; a retained Fallow blocker is', () => {
  const flow = (output) => ({ blocks: [{ attempts: [{ status: 'blocked', output }] }] });
  assert.equal(branchCheckFailure(flow('Requested Discuss-tab visual proof was not collected.')), null);
  assert.match(
    branchCheckFailure(flow('```flow-result\n{"failure":"Fallow failed; visual proof could not run."}\n```')).summary,
    /Fallow/
  );
  assert.equal(
    branchCheckFailure({
      blocks: [{ attempts: [{ status: 'failed', invalidatedAt: 'now', evidence: [{ label: 'Fallow' }] }] }],
    }),
    null
  );
});

test('native repair verifies the candidate after model work and feeds failed check logs into a bounded retry', async (t) => {
  const { runBranchRepair } = await import('./factory-ui/branch-repair-runner.mjs');
  const f = fixture(t, async () => {});
  const log = join(f.root, '.issues/check.log');
  writeFileSync(log, 'Fallow failure in source.txt\n');
  const prompts = [],
    retained = [],
    steps = [];
  let checks = 0;
  let closed = false;
  const connection = {
    ready: async () => {},
    call: async () => ({ data: [] }),
    close: () => {
      closed = true;
    },
    turn: async (_thread, _cwd, prompt) => {
      prompts.push(prompt);
      return 'Repaired the blocking check.';
    },
  };
  await runBranchRepair(
    {
      run: { checkout: f.checkout, folder: join(f.root, '.issues'), comparisonBase: f.flow.workspace.base },
      definition: { prompt: 'Repair only prerequisite checks.', defaultSkill: null },
      signal: new AbortController().signal,
      progress: () => {},
      step: (value) => steps.push(value),
      retain: (value) => retained.push(value),
    },
    {
      connection,
      attach: async (_connection, _cwd, _binding, retain, sandbox, instructions) => {
        assert.equal(sandbox, 'workspace-write');
        assert.match(instructions, /--work-checks/);
        retain({ threadId: 'retained-thread' });
        return 'retained-thread';
      },
      verify: async () => {
        checks++;
        if (checks === 1)
          throw Object.assign(Error('Fallow failed'), { verificationFailure: true, evidence: [{ path: log }] });
        return { evidence: [{ path: log, label: 'Passing verification' }] };
      },
    }
  );
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Fallow failure in source.txt/);
  assert.equal(checks, 2);
  assert.equal(retained.at(-1).checks[0].label, 'Passing verification');
  assert.equal(closed, true);
  assert.ok(steps.includes('Checking branch formatting and Fallow'));
});

test('native model-reported blockers cannot produce passing candidate checks', async (t) => {
  const { runBranchRepair } = await import('./factory-ui/branch-repair-runner.mjs');
  const f = fixture(t, async () => {});
  let checked = false;
  await assert.rejects(
    runBranchRepair(
      {
        run: { checkout: f.checkout, folder: join(f.root, '.issues'), comparisonBase: f.flow.workspace.base },
        definition: { prompt: 'Repair branch checks.', defaultSkill: null },
        signal: new AbortController().signal,
        progress() {},
        step() {},
        retain() {},
      },
      {
        connection: {
          ready: async () => {},
          call: async () => ({ data: [] }),
          close() {},
          turn: async () => '```flow-result\n{"failure":"Missing check configuration"}\n```',
        },
        attach: async () => 'thread',
        verify: async () => {
          checked = true;
        },
      }
    ),
    /reported a blocker/
  );
  assert.equal(checked, false);
});

test('changing an ignored environment file or retained check evidence invalidates approval', async (t) => {
  const f = fixture(t, async ({ run, retain }) => {
    writeFileSync(join(run.checkout, 'source.txt'), 'Repair\n');
    const path = join(run.folder, 'check.log');
    writeFileSync(path, 'Passing checks\n');
    retain({ checks: [{ path, label: 'Required checks' }] });
  });
  writeFileSync(join(f.checkout, '.gitignore'), '.issues/\n.env\n');
  writeFileSync(join(f.checkout, '.env'), 'EXAMPLE_VALUE=first\n');
  await f.start();
  await f.finish();
  writeFileSync(join(f.checkout, '.env'), 'EXAMPLE_VALUE=second\n');
  assert.equal(f.repairs.view(f.issue, f.flow).status, 'stale');
  await assert.rejects(f.approve(), /checkout or check configuration changed/);
  writeFileSync(join(f.checkout, '.env'), 'EXAMPLE_VALUE=first\n');
  const record = f.repairs.read(f.issue.id);
  writeFileSync(join(record.folder, 'check.log'), 'Altered checks\n');
  await assert.rejects(f.approve(), /check evidence changed/);
});

test('uncertain provider ownership requires reconciliation before another repair can start', async (t) => {
  const f = fixture(t, async () => {
    throw Object.assign(Error('Provider disconnected during work'), { uncertain: true });
  });
  await f.start();
  await f.finish();
  assert.equal(f.repairs.view(f.issue, f.flow).status, 'interrupted');
  await assert.rejects(f.start(), /interrupted/);
  f.repairs.reconcileWorker = async () => {
    throw Error('Original worker still active');
  };
  await assert.rejects(f.repairs.reconcile(f.issue), /still active/);
  f.repairs.reconcileWorker = async () => {};
  await f.repairs.reconcile(f.issue);
  assert.equal(f.repairs.read(f.issue.id).status, 'interrupted');
});
