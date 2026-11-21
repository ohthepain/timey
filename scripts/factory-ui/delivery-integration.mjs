import { join } from 'node:path';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { digest, writeJson, requireThat, git } from './common.mjs';
import { readQueue } from './data.mjs';
import { finalizeDelivery } from './delivery.mjs';

function recordIntegratedIssues(service, action, run, checked, result) {
  const authorization = join(service.store.directory, run.id + '-delivery-authorization.json');
  writeJson(authorization, {
    actionId: action.id,
    authorization: run.authorization,
    humanApproved: run.humanApproved,
    candidate: run.candidate,
    base: run.base,
    result,
  });
  for (const id of action.issues) {
    const queue = readQueue(service.root),
      issue = queue.issues.find((i) => i.id === id);
    const role = integrationRole(queue, issue);
    // Earlier/custom stages still need their own exit review. Integration is retained on the action.
    if (!['ready-to-verify', 'ready-for-commit', 'ready-to-close'].includes(role)) continue;
    const manifest = join(service.store.directory, run.id + '-' + id + '-delivery.json');
    if (!existsSync(manifest))
      writeJson(manifest, {
        operationId: run.id + '-' + id,
        integrationRunId: run.id,
        issueId: id,
        expectedState: issue.state,
        reportDigest: digest(issue.content),
        checkout: service.root,
        revision: checked.head,
        base: run.base,
        verification: checked.summaries,
        requirements: [
          {
            description: result.summary,
            evidence: checked.summaries.map((path) => ({ path, sha256: digest(readFileSync(path)) })),
          },
        ],
        authorization: { path: authorization, sha256: digest(readFileSync(authorization)) },
      });
    finalizeDelivery(service.root, JSON.parse(readFileSync(manifest, 'utf8')), service.guard);
  }
}

function integrationRole(queue, issue) {
  return queue.lifecycle.find((s) => s.state === issue?.state)?.role;
}

export function completeDeliveryRun(service, run, result, revision) {
  const lock = join(service.root, '.issues/factory-integration.lock');
  requireThat(
    JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).runId === run.id,
    'Integration lock ownership changed.'
  );
  service.store.update(run, { status: 'completed', summary: result.summary, result, verifiedRevision: revision });
  rmSync(lock, { recursive: true });
}
export function resumeDelivery(service, run, action) {
  service.requireLock(run);
  requireThat(run.deliveryCheck && run.deliveryResult, 'Integration evidence is missing; reconcile the saved result.');
  requireThat(
    git(service.root, 'rev-parse', 'HEAD') === run.deliveryCheck.head,
    'The integrated source changed before bookkeeping resumed.'
  );
  service.store.connected.add(run.id);
  service.perform(run, async () => {
    recordIntegratedIssues(service, action, run, run.deliveryCheck, run.deliveryResult);
    completeDeliveryRun(service, run, run.deliveryResult, run.deliveryCheck.head);
  });
  return { runId: run.id };
}
