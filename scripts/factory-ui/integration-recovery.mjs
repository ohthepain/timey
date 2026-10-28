import { integrationReservation } from './integration-reservation.mjs';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { appendCompletion } from '../factory-completion.mjs';
import { readQueue } from './data.mjs';
import { completeDeliveryRun } from './delivery-integration.mjs';
import { validateSummary } from './checks.mjs';
import { digest, git, requireThat } from './common.mjs';
import { saveLifecycle, lifecycleEvent } from './lifecycle-store.mjs';

function context(service, record) {
  const queue = readQueue(service.root);
  const reservation = integrationReservation(service, record.issueId, queue);
  if (!reservation) return null;
  const { owner, run, action } = reservation;
  const logs = ['verify.log', 'audit-step.log'].map((name) => join(service.store.directory, run.id, name));
  const inputs = logs.map((path) => {
    if (!existsSync(path)) return [path, null];
    const text = readFileSync(path, 'utf8');
    return [path, digest(text), summaryPaths(text).map((p) => proofDigest(service.root, p))];
  });
  const basis = digest(
    JSON.stringify([queue.head, queue.snapshot.worktree, owner, action, run.base, run.candidate, inputs])
  );
  return { owner, run, action, queue, logs, basis };
}
function summaryPaths(text) {
  const reported = [...text.matchAll(/^Verification summary: (.+)$/gm)].map((m) => m[1]);
  if (reported.length) return reported.slice(-1);
  // Older verifier commands printed their own raw-log path rather than a summary marker.
  return [...text.matchAll(/^PASS fallow: (.+)-fallow\.log$/gm)].map((m) => m[1] + '-summary.json');
}
function localProof(root, path) {
  const rel = relative(realpathSync(join(root, '.issues')), realpathSync(path));
  requireThat(
    !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'),
    'Integration evidence is outside the project records: ' + path
  );
  return path;
}
function proofDigest(root, path) {
  try {
    localProof(root, path);
    const bytes = readFileSync(path),
      value = JSON.parse(bytes);
    return [
      path,
      digest(bytes),
      (value.checks || []).map((c) => [c.log, digest(readFileSync(localProof(root, c.log)))]),
    ];
  } catch {
    return [path, 'missing-or-invalid'];
  }
}
function checkedResult(service, c) {
  const tree = git(service.root, 'rev-parse', 'HEAD^{tree}');
  const summaries = c.logs.map((path, index) => {
    requireThat(existsSync(path), 'The saved verification log is missing: ' + path);
    const output = readFileSync(path, 'utf8');
    const candidates = summaryPaths(output).filter((p) => {
      try {
        localProof(service.root, p);
        const s = JSON.parse(readFileSync(p));
        return s.checkpoint === (index === 0 ? 'verification' : 'step');
      } catch {
        return false;
      }
    });
    requireThat(candidates.length === 1, 'The saved command does not identify one verification report: ' + path);
    const report = candidates[0],
      summary = JSON.parse(readFileSync(report));
    for (const check of summary.checks) {
      localProof(service.root, check.log);
      requireThat(
        output.includes(check.log),
        'This check was not reported by the saved verification command: ' + check.log
      );
    }
    validateSummary(summary, c.run.base, tree);
    return report;
  });
  return { head: c.queue.head, tree, summaries };
}
function requireMerged(service, c) {
  requireThat(c.queue.sourceClean, 'The project has uncommitted changes. Preserve them before retrying completion.');
  requireThat(
    c.owner.actionId === c.action.id && c.owner.candidate === c.run.candidate && c.owner.base === c.run.base,
    'The saved integration lock does not match this candidate and starting revision.'
  );
  requireThat(
    ['completed', 'integrated'].includes(c.action.status) && c.action.worker_revision === c.run.candidate,
    'The saved implementation candidate changed. Review that candidate before retrying.'
  );
  requireThat(
    ['direct-user', 'approved-plan'].includes(c.run.authorization?.kind),
    'The original integration authorization is missing. Review it before retrying.'
  );
  git(service.root, 'merge-base', '--is-ancestor', c.run.base, c.queue.head);
  try {
    git(service.root, 'merge-base', '--is-ancestor', c.run.candidate, c.queue.head);
  } catch {
    throw Error('The saved candidate is not in the project branch. Recovery will not repeat or create a merge.');
  }
  service.requireLock(c.run);
}
function finish(service, record, c, checked) {
  requireThat(
    git(service.root, 'rev-parse', 'HEAD') === checked.head && !git(service.root, 'status', '--porcelain'),
    'The project changed during recovery. Retry against the current revision.'
  );
  service.guard(service.root, c.action, 'record-integration', checked.head);
  const result = {
    outcome: 'completed',
    summary: 'Finished recording the existing integration. Implementation and the merge were not repeated.',
    notes:
      'The saved candidate is already in the project. Its command-owned full verification and step audit match the current tree and original starting revision.',
    remaining: [
      'Continue the configured review stages. Required human checks and explicit acceptance remain separate.',
    ],
    skipped_steps: [],
  };
  service.store.update(c.run, { deliveryCheck: checked, deliveryResult: result });
  if (c.action.status !== 'integrated') service.api.reconcileHistoricalIntegration(c.action.id, c.run.id, checked);
  for (const id of c.action.issues) {
    const q = readQueue(service.root),
      issue = q.issues.find((i) => i.id === id);
    const stage = q.lifecycle.find((s) => s.state === issue?.state),
      next = q.lifecycle.find((s) => s.state === stage?.next);
    if (stage?.role !== 'ready-to-fix' || next?.role !== 'ready-to-verify') continue;
    service.guard(service.root, c.action, 'advance', q.head, { target_state: next.state });
    const evidence = checked.summaries.map((path) => ({ path, sha256: digest(readFileSync(path)) }));
    appendCompletion(service.root, issue, result, { ...c.run, base: checked.head }, evidence, next.state);
  }
  completeDeliveryRun(service, c.run, result, checked.head);
  saveLifecycle(service, record, { integrationRecovery: null });
  lifecycleEvent(service, record, result.summary, { runId: c.run.id, result: 'completed', recovery: true });
}
export async function recoverPendingIntegration(service, record, explicit = false) {
  const c = context(service, record);
  if (!c) return null;
  if (!explicit && record.integrationRecovery?.basis === c.basis) {
    saveLifecycle(service, record, { status: 'blocked' });
    return 'blocked';
  }
  try {
    requireMerged(service, c);
    let checked;
    try {
      checked = checkedResult(service, c);
    } catch (error) {
      if (!explicit) throw error;
      service.guard(service.root, c.action, 'verify', c.queue.head);
      service.store.connected.add(c.run.id);
      service.store.update(c.run, {
        status: 'checking',
        summary: 'Checking the existing merged result. No implementation or merge is running.',
      });
      try {
        checked = await service.check(service.root, c.run.base, join(service.store.directory, c.run.id));
      } finally {
        service.store.connected.delete(c.run.id);
      }
    }
    finish(service, record, c, checked);
    return 'recovered';
  } catch (error) {
    const reason = error.message;
    service.store.update(c.run, { status: 'blocked', summary: reason });
    saveLifecycle(service, record, {
      status: record.input ? 'waiting' : 'blocked',
      summary: 'The changes are kept, but recording integration needs attention. ' + reason,
      integrationRecovery: { runId: c.run.id, basis: c.basis, reason },
    });
    return 'blocked';
  }
}
export function retryIntegrationRecovery(service, input, after) {
  service.ownServer();
  const record = service.lifecycleRuns[input.issueId];
  requireThat(
    record?.integrationRecovery && record.updated === input.updated,
    'This recovery request changed. Refresh before retrying.'
  );
  requireThat(!record.input, 'Answer the pending question before retrying completion.');
  requireThat(!service.lifecycleTasks.has(input.issueId), 'Wait for the current issue action.');
  service.integrationRecoveries ||= new Set();
  requireThat(!service.integrationRecoveries.has(input.issueId), 'Integration recovery is already running.');
  service.integrationRecoveries.add(input.issueId);
  saveLifecycle(service, record, {
    status: 'running',
    summary: 'Finishing the saved integration; checking existing evidence first.',
  });
  void recoverPendingIntegration(service, record, true)
    .then((result) => {
      if (result === 'recovered') {
        const paused =
          record.pauseRequested || (service.serverControl && service.serverControl.status().phase !== 'idle');
        saveLifecycle(service, record, { status: paused ? 'paused' : 'blocked' });
        if (!paused) after(input.issueId);
      } else if (!result)
        saveLifecycle(service, record, {
          status: 'blocked',
          integrationRecovery: null,
          summary: 'The saved integration changed. Continue to inspect the current result.',
        });
    })
    .catch((error) => saveLifecycle(service, record, { status: 'blocked', summary: error.message }))
    .finally(() => service.integrationRecoveries.delete(input.issueId));
  return { issueId: input.issueId };
}
