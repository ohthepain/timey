import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { FactoryUI } from './factory-test-service.mjs';
import { factory } from './factory-ledger.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { verificationView } from './factory-ui/verification-recovery.mjs';

function fixture(t) {
  const f = gitFixture(t, 'verify-recovery-');
  f.git('branch', '-m', 'target');
  writeFileSync(join(f.root, '.gitignore'), '.issues/\n');
  writeFileSync(join(f.root, 'code.js'), 'base\n');
  mkdirSync(join(f.root, 'shared-skill'));
  writeFileSync(join(f.root, 'shared-skill/SKILL.md'), 'Shared instructions\n');
  symlinkSync('shared-skill', join(f.root, 'skill-link'));
  f.git('add', '.');
  f.git('commit', '-qm', 'base');
  mkdirSync(join(f.root, '.issues'));
  writeFileSync(join(f.root, '.issues/preferences.json'), '{"commit":true}');
  writeFileSync(
    join(f.root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-for-fix | unused | unused2 |\n| ready-to-fix | implement | verify |\n| ready-to-verify | verify | commit |\n| ready-for-commit | commit | review |\n| ready-to-close | review | closed |\n| closed | closed | — |\n'
  );
  const report = join(f.root, '.issues/20261027-one.md');
  writeFileSync(
    report,
    '---\nid: 20261027-one\nstate: implement\ngrill_later: false\n---\n# Existing implementation\n'
  );
  const api = factory(f.root);
  api.init();
  const queue = readQueue(f.root);
  const action = { id: 'existing-action', kind: 'implement', status: 'running', issues: ['20261027-one'] };
  const worker = join(f.root, '.issues/worker');
  f.git('worktree', 'add', '-b', 'worker', worker);
  writeFileSync(join(worker, 'feature.js'), 'implemented\n');
  f.git('-C', worker, 'add', '.');
  f.git('-C', worker, 'commit', '-qm', 'implementation');
  const service = new FactoryUI(f.root);
  t.after(() => service.close());
  service.guard = () => ({});
  service.api.record = (_id, changes) => {
    Object.assign(action, changes);
  };
  // Use the actual registry reader with one stable retained action.
  const registry = JSON.parse(readFileSync(join(f.root, '.issues/factory.json')));
  registry.actions.push(action);
  writeFileSync(join(f.root, '.issues/factory.json'), JSON.stringify(registry));
  const run = service.store.add(action, 'worker', queue.head);
  service.store.update(run, {
    checkout: worker,
    threadId: 'original-chat',
    sourceBranch: 'refs/heads/target',
    resultTurnId: 'implementation-turn',
    result: {
      outcome: 'completed',
      summary: 'Implementation finished',
      evidence: 'Focused checks passed',
      remaining: [],
    },
  });
  service.store.connected.delete(run.id);
  return {
    ...f,
    service,
    get run() {
      return service.store.runs.find((r) => r.id === run.id);
    },
    action,
    report,
    worker,
  };
}
async function failVerification(f) {
  f.service.check = async () => {
    throw Error('Wider test helper failed');
  };
  await assert.rejects(f.service.finishWorker(f.run, f.action, f.run.result), /Wider test helper/);
  f.service.store.update(f.run, { status: 'blocked' });
}
function input(f) {
  const q = readQueue(f.root),
    issue = q.issues.find((i) => i.id === '20261027-one');
  const view = verificationView(f.service, q, issue);
  return { issueId: issue.id, runId: f.run.id, basis: view.basis };
}
test('finished implementation moves to Verify on failed checks and can retry unchanged code without a chat', async (t) => {
  const f = fixture(t);
  await failVerification(f);
  assert.match(readFileSync(f.report, 'utf8'), /state: verify/);
  assert.equal(f.run.result.outcome, 'completed');
  assert.equal(
    verificationView(f.service, readQueue(f.root), readQueue(f.root).issues[0]).defaultBranch,
    'refs/heads/target'
  );
  assert.equal(f.run.verification.status, 'failed');
  const original = f.run.threadId;
  let checks = 0;
  f.service.check = async () => {
    checks++;
    return { head: f.git('-C', f.worker, 'rev-parse', 'HEAD'), summaries: [] };
  };
  f.service.retryVerification(input(f));
  await f.service.verificationTasks.get(f.run.id);
  assert.equal(checks, 1);
  assert.equal(f.run.status, 'completed', JSON.stringify(f.run.verification));
  assert.equal(f.run.verification.status, 'passed');
  assert.equal(f.run.threadId, original);
  assert.equal(f.service.store.runs.length, 1);
  assert.match(
    readFileSync(f.report, 'utf8'),
    /state: verify/,
    'retry never marks verification stage accepted by itself'
  );
});
test('branch updates retain implementation, reject moved refs and verify the combined commit against original base', async (t) => {
  const f = fixture(t);
  await failVerification(f);
  f.git('checkout', '-b', 'outside-fix');
  writeFileSync(join(f.root, 'fix.js'), 'outside repair\n');
  f.git('add', '.');
  f.git('commit', '-qm', 'outside fix');
  const revision = f.git('rev-parse', 'HEAD');
  f.git('checkout', 'target');
  const request = { ...input(f), branch: 'refs/heads/outside-fix', branchRevision: '0'.repeat(40) };
  assert.throws(() => f.service.retryVerification(request), /selected branch changed/);
  let checkedBase;
  f.service.check = async (checkout, base) => {
    checkedBase = base;
    assert.equal(readFileSync(join(checkout, 'fix.js'), 'utf8'), 'outside repair\n');
    assert.equal(readFileSync(join(checkout, 'feature.js'), 'utf8'), 'implemented\n');
    return { head: f.git('-C', checkout, 'rev-parse', 'HEAD'), summaries: [] };
  };
  f.service.retryVerification({ ...request, branchRevision: revision });
  await f.service.verificationTasks.get(f.run.id);
  assert.equal(f.run.verification.status, 'passed');
  assert.equal(checkedBase, f.run.base);
  assert.equal(f.git('rev-parse', 'target'), f.run.base, 'project branch was not merged');
});
test('dirty work, stale requests, concurrent retries and human guards remain explicit and recoverable', async (t) => {
  const f = fixture(t);
  await failVerification(f);
  const request = input(f);
  assert.throws(() => f.service.retryVerification({ ...request, basis: 'stale' }), /saved work changed/);
  writeFileSync(join(f.worker, 'uncommitted.js'), 'keep me');
  assert.throws(() => f.service.retryVerification(request), /uncommitted changes/);
  f.git('-C', f.worker, 'add', '.');
  f.git('-C', f.worker, 'commit', '-qm', 'manual correction');
  f.service.guard = () => {
    throw Error('Human decision required');
  };
  assert.throws(() => f.service.retryVerification(input(f)), /Human decision/);
  f.service.guard = () => ({});
  let finish;
  f.service.check = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  f.service.retryVerification(input(f));
  assert.throws(() => f.service.retryVerification(input(f)), /already running/);
  finish({ head: f.git('-C', f.worker, 'rev-parse', 'HEAD'), summaries: [] });
  await f.service.verificationTasks.get(f.run.id);
});

test('a failed retry stays in Verify and can be retried again without any automatic loop', async (t) => {
  const f = fixture(t);
  await failVerification(f);
  let calls = 0;
  f.service.check = async () => {
    calls++;
    throw Error('Outside failure still present');
  };
  f.service.retryVerification(input(f));
  await f.service.verificationTasks.get(f.run.id);
  assert.equal(calls, 1);
  assert.equal(f.run.verification.status, 'failed');
  f.service.retryVerification(input(f));
  await f.service.verificationTasks.get(f.run.id);
  assert.equal(calls, 2);
  assert.match(readFileSync(f.report, 'utf8'), /state: verify/);
  assert.equal(f.service.store.runs.length, 1);
});

test('unavailable conflict resolution preserves the owned merge for an explicit retry and never changes the project branch', async (t) => {
  const f = fixture(t);
  await failVerification(f);
  writeFileSync(join(f.worker, 'code.js'), 'worker edit\n');
  f.git('-C', f.worker, 'add', '.');
  f.git('-C', f.worker, 'commit', '-qm', 'worker edit');
  f.git('checkout', '-b', 'outside-conflict');
  writeFileSync(join(f.root, 'code.js'), 'outside edit\n');
  f.git('add', '.');
  f.git('commit', '-qm', 'outside edit');
  const revision = f.git('rev-parse', 'HEAD');
  f.git('checkout', 'target');
  f.service.codex.ready = async () => {
    throw Error('Resolution unavailable');
  };
  f.service.retryVerification({ ...input(f), branch: 'refs/heads/outside-conflict', branchRevision: revision });
  await f.service.verificationTasks.get(f.run.id);
  assert.equal(f.run.verification.status, 'failed');
  assert.match(f.git('-C', f.worker, 'status', '--porcelain'), /UU/);
  assert.throws(() => f.service.retryVerification(input(f)), /merge conflicts/);
  assert.equal(f.service.store.runs.length, 1);
  assert.equal(f.git('rev-parse', 'target'), f.run.base);
});

test('verification report selection follows command output rather than an unrelated report in the shared folder', async () => {
  const { commandSummary } = await import('./factory-ui/checks.mjs');
  const root = '/project';
  assert.equal(
    commandSummary(
      root,
      'Verification summary: /fixture/nested-summary.json\nVerification summary: /project/.issues/evidence/owned-summary.json\n'
    ),
    '/project/.issues/evidence/owned-summary.json'
  );
  assert.throws(() => commandSummary(root, 'PASS old report\n'), /identify its own/);
  assert.throws(() => commandSummary(root, 'Verification summary: /unrelated/report.json\n'), /identify its own/);
});

test('Verify recovery UI names the checkout, uncertainty, branch scope and both direct actions', async () => {
  const { JSDOM } = await import('jsdom');
  const html = readFileSync('scripts/factory-ui/index.html', 'utf8');
  const source = html.slice(
    html.indexOf('      function verificationRecovery('),
    html.indexOf('      async function retryIssueVerification(')
  );
  const context = {};
  vm.runInNewContext(
    readFileSync('scripts/factory-ui/file-link-ui.js', 'utf8') + '\nglobalThis.fileLinkUI = fileLinkUI;\n',
    context
  );
  const render = new Function('esc', 'busy', 'fileLinkUI', source + ';return verificationRecovery;')(
    (v) => String(v).replaceAll('<', '&lt;'),
    false,
    context.fileLinkUI
  );
  const log = '/project/.issues/factory-ui/run/verify.log';
  const view = {
    runId: 'one',
    checkout: '/project/.issues/worker',
    branch: 'worker',
    busy: false,
    error: 'An outside check failed. See ' + log,
    defaultBranch: 'refs/heads/manual-fix',
    branches: [
      { ref: 'refs/heads/manual-fix', name: 'manual-fix', revision: 'a'.repeat(40), subject: 'Manual repair' },
      {
        ref: 'refs/remotes/origin/issue-fix',
        name: 'origin/issue-fix',
        revision: 'b'.repeat(40),
        subject: 'Other issue',
      },
    ],
  };
  const dom = new JSDOM(render({ id: 'one', verificationRecovery: view }));
  const text = dom.window.document.body.textContent;
  assert.equal(dom.window.document.querySelector('[data-open-file]').dataset.openFile, log);
  assert.match(text, /may be outside/);
  assert.match(text, /\/project\/\.issues\/worker/);
  assert.match(text, /all changes/);
  assert.equal(dom.window.document.querySelectorAll('select option').length, 3);
  assert.match(text, /fetched remote/);
  assert.equal(dom.window.document.querySelector('select').value, view.defaultBranch);
  assert.equal(
    dom.window.document.querySelector('[data-verification-update]').previousElementSibling.querySelector('select')
      .value,
    view.defaultBranch
  );
  assert.equal(dom.window.document.querySelector('[data-verification-retry]').disabled, false);
  assert.equal(dom.window.document.querySelector('[data-verification-update]').disabled, false);
  assert.match(render({ id: 'one', verificationRecovery: { ...view, busy: true } }), /Checking…/);
  dom.window.close();
});

test('candidate verification ignores a concurrent commit-hook report and retains only its own command reports', async (t) => {
  const { deliveryFixture } = await import('./factory-workflow-fixture.mjs');
  const { checkCandidate } = await import('./factory-ui/checks.mjs');
  const { realpathSync } = await import('node:fs');
  const f = deliveryFixture(t),
    root = realpathSync(f.source.root);
  writeFileSync(join(root, '.gitignore'), '.issues/\nnode_modules/\n');
  f.source.git('add', '.');
  f.source.git('commit', '-qm', 'fixture dependencies');
  mkdirSync(join(root, 'node_modules'));
  mkdirSync(join(root, '.issues/evidence'));
  mkdirSync(join(root, '.issues/tools'));
  const template = JSON.parse(readFileSync(f.input.verification[0]));
  template.base = f.source.git('rev-parse', 'HEAD');
  template.snapshot_tree = f.source.git('rev-parse', 'HEAD^{tree}');
  const tool = join(root, '.issues/tools/pnpm');
  writeFileSync(
    tool,
    `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst root=${JSON.stringify(root)};const value=${JSON.stringify(template)};const step=process.argv.includes('audit:step');value.checkpoint=step?'step':'verification';const path=root+'/.issues/evidence/'+value.checkpoint+'-owned-summary.json';const raw=path.replace('-summary.json','-fallow.log');fs.copyFileSync(value.checks.find(c=>c.name==='fallow').log,raw);value.checks.find(c=>c.name==='fallow').log=raw;fs.writeFileSync(path,JSON.stringify(value));fs.writeFileSync(root+'/.issues/evidence/unrelated-commit-summary.json',JSON.stringify({...value,checkpoint:'commit',base:'unrelated-base',passed:false}));console.log(fs.existsSync(root+'/.issues/legacy-output')?'PASS fallow: '+raw:'Verification summary: '+path);\n`,
    { mode: 0o755 }
  );
  const previous = process.env.PATH;
  process.env.PATH = join(root, '.issues/tools') + ':' + previous;
  try {
    const result = await checkCandidate(root, template.base, join(root, '.issues/check-output'));
    assert.equal(result.summaries.length, 2);
    assert.ok(result.summaries.every((p) => p.includes('-owned-summary.json')));
    assert.equal(result.head, template.base);
    writeFileSync(join(root, '.issues/legacy-output'), 'older verifier');
    const legacy = await checkCandidate(root, template.base, join(root, '.issues/legacy-check-output'));
    assert.deepEqual(legacy.summaries, result.summaries);
  } finally {
    process.env.PATH = previous;
  }
});

test('Codex resolves an owned merge in the existing chat, preserves original evidence and verifies the combined commit', async (t) => {
  const f = fixture(t);
  await failVerification(f);
  writeFileSync(join(f.worker, 'code.js'), 'worker edit\n');
  f.git('-C', f.worker, 'add', 'code.js');
  f.git('-C', f.worker, 'commit', '-qm', 'worker edit');
  f.git('checkout', '-b', 'conflict-fix');
  writeFileSync(join(f.root, 'code.js'), 'incoming edit\n');
  f.git('add', 'code.js');
  f.git('commit', '-qm', 'incoming edit');
  const revision = f.git('rev-parse', 'HEAD');
  f.git('checkout', 'target');
  const originalHead = f.git('-C', f.worker, 'rev-parse', 'HEAD');
  let turns = 0,
    checks = 0;
  f.service.codex.ready = async () => {};
  f.service.codex.resume = async (id, cwd, sandbox) => {
    assert.equal(id, 'original-chat');
    assert.equal(cwd, f.worker);
    assert.equal(sandbox, 'workspace-write');
  };
  f.service.codex.call = async () => ({ thread: { status: { type: 'idle' } } });
  f.service.codex.turn = async (id, cwd, prompt) => {
    turns++;
    assert.equal(id, 'original-chat');
    assert.match(prompt, /do not commit/);
    assert.match(prompt, /original base/);
    writeFileSync(join(cwd, 'code.js'), 'worker and incoming edit\n');
    f.git('-C', cwd, 'add', 'code.js');
    return JSON.stringify({ outcome: 'completed', summary: 'Both behaviors preserved' });
  };
  f.service.check = async (cwd, base) => {
    checks++;
    assert.equal(base, f.run.base);
    assert.equal(readFileSync(join(cwd, 'code.js'), 'utf8'), 'worker and incoming edit\n');
    assert.equal(f.git('-C', cwd, 'rev-parse', 'HEAD^1'), originalHead);
    assert.equal(f.git('-C', cwd, 'rev-parse', 'HEAD^2'), revision);
    return { head: f.git('-C', cwd, 'rev-parse', 'HEAD'), summaries: [] };
  };
  // First attempt cannot reach Codex; the next explicit click resumes exactly that merge.
  const ready = f.service.codex.ready;
  f.service.codex.ready = async () => {
    throw Error('Connection unavailable');
  };
  f.service.retryVerification({ ...input(f), branch: 'refs/heads/conflict-fix', branchRevision: revision });
  await f.service.verificationTasks.get(f.run.id);
  assert.equal(turns, 0);
  assert.equal(checks, 0);
  f.service.codex.ready = ready;
  f.service.retryVerification({ ...input(f), branch: 'refs/heads/conflict-fix', branchRevision: revision });
  await f.service.verificationTasks.get(f.run.id);
  assert.equal(f.run.verification.status, 'passed', f.run.verification.error);
  assert.equal(turns, 1);
  assert.equal(checks, 1);
  assert.equal(f.run.resultTurnId, 'implementation-turn');
  assert.equal(f.git('rev-parse', 'target'), f.run.base);
  assert.equal(f.service.store.runs.length, 1);
});

test('a foreign pending merge is never adopted by the recovery action', async (t) => {
  const f = fixture(t);
  await failVerification(f);
  writeFileSync(join(f.worker, 'code.js'), 'worker\n');
  f.git('-C', f.worker, 'commit', '-am', 'worker edit');
  f.git('checkout', '-b', 'foreign');
  writeFileSync(join(f.root, 'code.js'), 'incoming\n');
  f.git('commit', '-am', 'incoming edit');
  const revision = f.git('rev-parse', 'HEAD');
  f.git('checkout', 'target');
  assert.throws(() => f.git('-C', f.worker, 'merge', '--no-edit', revision));
  assert.throws(
    () => f.service.retryVerification({ ...input(f), branch: 'refs/heads/foreign', branchRevision: revision }),
    /uncommitted changes/
  );
});

test('worker preparation records its source branch before a later project branch switch', async (t) => {
  const f = fixture(t);
  f.service.api.attach = () => {};
  f.service.runTurn = async () => {};
  f.service.codex.start = async () => 'prepared-chat';
  f.service.codex.call = async () => ({});
  await f.service.prepareWorker(f.run, { ...f.action, basis: { head: f.run.base } }, readQueue(f.root));
  assert.equal(f.run.sourceBranch, 'refs/heads/target');
  f.git('checkout', '-b', 'later-project-branch');
  assert.equal(f.run.sourceBranch, 'refs/heads/target');
});

test('legacy workers use the current project branch without inventing a historical source', async (t) => {
  const f = fixture(t);
  await failVerification(f);
  f.service.store.update(f.run, { sourceBranch: null });
  const q = readQueue(f.root);
  assert.equal(verificationView(f.service, q, q.issues[0]).defaultBranch, 'refs/heads/target');
  assert.equal(f.run.sourceBranch, null);
});

for (const scenario of ['busy chat', 'outside-scope edit', 'human decision']) {
  test('conflict recovery stops safely for ' + scenario, async (t) => {
    const f = fixture(t);
    await failVerification(f);
    writeFileSync(join(f.worker, 'code.js'), 'worker edit\n');
    f.git('-C', f.worker, 'commit', '-am', 'worker edit');
    f.git('checkout', '-b', 'incoming');
    writeFileSync(join(f.root, 'code.js'), 'incoming edit\n');
    f.git('commit', '-am', 'incoming edit');
    const revision = f.git('rev-parse', 'HEAD');
    f.git('checkout', 'target');
    const before = f.git('-C', f.worker, 'rev-parse', 'HEAD');
    let resumed = 0,
      checked = 0,
      turns = 0;
    f.service.codex.ready = async () => {};
    f.service.codex.resume = async () => {
      resumed++;
    };
    f.service.codex.call = async () => ({ thread: { status: { type: scenario === 'busy chat' ? 'active' : 'idle' } } });
    f.service.codex.turn = async (_id, cwd) => {
      turns++;
      if (scenario === 'outside-scope edit') {
        writeFileSync(join(cwd, 'feature.js'), 'unapproved replacement\n');
        writeFileSync(join(cwd, 'code.js'), 'resolved\n');
        f.git('-C', cwd, 'add', 'code.js', 'feature.js');
      }
      return JSON.stringify({
        outcome: scenario === 'human decision' ? 'blocked' : 'completed',
        summary: 'Choose the intended behavior',
      });
    };
    f.service.check = async () => {
      checked++;
    };
    f.service.retryVerification({ ...input(f), branch: 'refs/heads/incoming', branchRevision: revision });
    await f.service.verificationTasks.get(f.run.id);
    assert.equal(f.run.verification.status, 'failed');
    assert.equal(checked, 0);
    assert.equal(f.git('-C', f.worker, 'rev-parse', 'HEAD'), before);
    if (scenario === 'busy chat') {
      assert.equal(resumed, 0);
      assert.equal(turns, 0);
    }
    assert.match(
      f.run.verification.error,
      scenario === 'busy chat'
        ? /busy/
        : scenario === 'outside-scope edit'
          ? /outside the permitted/
          : /Choose the intended behavior/
    );
  });
}
