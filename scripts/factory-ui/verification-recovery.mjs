import { realpathSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { appendCompletion } from '../factory-completion.mjs';
import { readQueue, currentAction } from './data.mjs';
import { digest, git, requireThat, writeJson } from './common.mjs';
import { pendingBranchMerge, updateVerificationBranch } from './verification-merge.mjs';

export function failedVerification(service, run, action, result, error) {
  const head = git(run.checkout, 'rev-parse', 'HEAD');
  service.store.update(run, {
    result,
    verification: { status: 'failed', head, at: new Date().toISOString(), error: error.message },
    summary: 'Implementation is finished. Verification failed; fix the check separately, then retry in Verify.',
  });
  const path = join(service.store.directory, run.id + '-implementation.json');
  writeJson(path, { runId: run.id, actionId: action.id, head, result, verification: run.verification });
  const queue = readQueue(service.root);
  for (const id of action.issues) {
    const issue = queue.issues.find((i) => i.id === id);
    const stage = queue.lifecycle.find((s) => s.state === issue?.state);
    const next = queue.lifecycle.find((s) => s.state === stage?.next);
    if (stage?.role !== 'ready-to-fix' || next?.role !== 'ready-to-verify') continue;
    requireThat(
      !git(run.checkout, 'status', '--porcelain'),
      'Preserve the unfinished checkout before recording implementation.'
    );
    service.guard(service.root, action, 'advance', queue.head, { target_state: next.state });
    appendCompletion(
      service.root,
      issue,
      {
        outcome: 'completed',
        summary: 'Implementation finished; verification still needs attention.',
        notes:
          'The worker returned its completed implementation. Wider verification failed: ' +
          error.message +
          '\nThis is not a passed check or permission to commit, integrate or close. No outside repair has been assigned to this worker.',
        remaining: [
          'Fix the failing check separately, then retry verification or update from a selected branch and retry.',
        ],
        skipped_steps: [],
      },
      { ...run, base: head },
      [{ path, sha256: digest(readFileSync(path)) }],
      next.state
    );
  }
}
function recoveryRun(service, queue, issue) {
  const ids = new Set(
    queue.actions
      .filter((a) => a.issues.includes(issue.id) && !['integrated', 'superseded'].includes(a.status))
      .map((a) => a.id)
  );
  return service.store.runs.findLast(
    (r) =>
      ids.has(r.actionId) && r.verification && r.result?.outcome === 'completed' && r.verification.status !== 'passed'
  );
}
export function verificationView(service, queue, issue) {
  if (!['ready-to-fix', 'ready-to-verify'].includes(queue.lifecycle.find((s) => s.state === issue.state)?.role))
    return null;
  const run = recoveryRun(service, queue, issue);
  if (!run) return null;
  const head = git(run.checkout, 'rev-parse', 'HEAD');
  return {
    runId: run.id,
    checkout: run.checkout,
    branch: git(run.checkout, 'branch', '--show-current'),
    defaultBranch: run.sourceBranch || git(service.root, 'rev-parse', '--symbolic-full-name', 'HEAD'),
    status: run.verification.status,
    error: run.verification.error,
    head,
    busy: service.store.connected.has(run.id),
    basis: digest(JSON.stringify([issue.content, run.id, run.verification, head])),
    branches: branches(run.checkout),
  };
}
function branches(checkout) {
  return git(
    checkout,
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(subject)%00%(symref)',
    'refs/heads',
    'refs/remotes'
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, revision, subject, symbolic] = line.split('\0');
      return { ref, revision, subject, symbolic, name: ref.replace(/^refs\/(heads|remotes)\//, '') };
    })
    .filter((b) => !b.symbolic);
}
export function retryVerification(service, input, after) {
  service.ownServer();
  const queue = readQueue(service.root),
    issue = queue.issues.find((i) => i.id === input.issueId);
  requireThat(issue, 'This issue no longer exists.');
  requireThat(
    ['ready-to-fix', 'ready-to-verify'].includes(queue.lifecycle.find((s) => s.state === issue.state)?.role),
    'Retry from Verify after implementation has finished.'
  );
  const view = verificationView(service, queue, issue);
  requireThat(
    view && view.runId === input.runId && view.basis === input.basis,
    'The saved work changed. Refresh before retrying.'
  );
  const run = service.store.runs.find((r) => r.id === view.runId);
  const action = queue.actions.find((a) => a.id === run.actionId);
  requireThat(!service.store.connected.has(run.id), 'Verification is already running.');
  requireThat(!service.lifecycleTasks.has(issue.id), 'Wait for the current issue action to finish before retrying.');
  requireThat(
    !service.store.runs.some(
      (r) => service.store.connected.has(r.id) && (r.issueId === issue.id || r.actionId === run.actionId)
    ),
    'Another action is using this issue.'
  );
  requireThat(
    realpathSync(run.checkout) !== realpathSync(service.root),
    'Use the isolated worker checkout, not the project branch.'
  );
  requireThat(
    !git(run.checkout, 'status', '--porcelain') || Boolean(input.branch && pendingBranchMerge(service, run, input)),
    'This branch has uncommitted changes or merge conflicts. Resolve and commit them in ' +
      run.checkout +
      ', then retry.'
  );
  requireThat(
    realpathSync(git(run.checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir')) ===
      realpathSync(git(service.root, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
    'This checkout belongs to another repository.'
  );
  const branch = input.branch
    ? view.branches.find((b) => b.ref === input.branch && b.revision === input.branchRevision)
    : null;
  requireThat(!input.branch || branch, 'The selected branch changed or is unavailable. Refresh the branch selector.');
  service.guard(service.root, action, 'verify', queue.head);
  if (queue.lifecycle.find((s) => s.state === issue.state)?.role === 'ready-to-fix')
    failedVerification(service, run, action, run.result, Error(run.verification.error));
  const lock = join(service.store.directory, 'verification-' + run.id + '.lock');
  mkdirSync(lock);
  service.store.connected.add(run.id);
  service.store.update(run, {
    status: 'checking',
    verification: { ...run.verification, status: 'running' },
    summary: branch
      ? 'Updating from ' + branch.name + ', then checking the combined changes.'
      : 'Retrying verification of the existing implementation.',
  });
  const task = executeRetry(service, run, action, branch)
    .finally(() => {
      service.store.connected.delete(run.id);
      rmSync(lock, { recursive: true });
    })
    .then(() => {
      if (run.status === 'completed' && !service.lifecycleRuns[issue.id]?.input) after?.(issue.id);
    });
  service.verificationTasks ||= new Map();
  service.verificationTasks.set(run.id, task);
  void task.then(
    () => service.verificationTasks.delete(run.id),
    (error) => {
      service.verificationTasks.delete(run.id);
      service.store.update(run, { status: 'blocked', summary: error.message });
    }
  );
  return { runId: run.id };
}
async function executeRetry(service, run, action, branch) {
  try {
    if (branch) {
      await updateVerificationBranch(service, run, action, branch);
      service.store.update(run, {
        verification: { ...run.verification, merged: { ref: branch.ref, revision: branch.revision } },
      });
    }
    const current = currentAction(service.root, action.id).action;
    requireThat(JSON.stringify(current) === JSON.stringify(action), 'The assignment changed. Refresh before retrying.');
    if (current.status === 'blocked')
      service.api.record(action.id, {
        status: 'running',
        authorization: run.authorization,
        evidence: 'Explicit verification retry of the existing implementation; no worker restarted.',
      });
    await service.finishWorker(run, current, run.result, { retryFailed: true });
    service.store.update(run, {
      verification: {
        ...run.verification,
        status: 'passed',
        head: git(run.checkout, 'rev-parse', 'HEAD'),
        at: new Date().toISOString(),
        error: null,
      },
    });
  } catch (error) {
    const current = currentAction(service.root, action.id).action;
    if (current.status === 'running')
      service.api.record(action.id, {
        status: 'blocked',
        evidence: 'Verification retry failed; implementation is preserved. ' + error.message,
      });
    service.store.update(run, {
      status: 'blocked',
      summary: 'Verification needs attention. Retry remains available in Verify.',
      verification: { ...run.verification, status: 'failed', at: new Date().toISOString(), error: error.message },
    });
  }
}
