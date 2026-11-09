import { existsSync } from 'node:fs';
import { DeliveryStore } from '../issue-delivery-store.mjs';
import { digest, requireThat } from './common.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';
import { StrategyProvider } from './strategy-provider.mjs';

// Recover merged delivery from GitHub without reopening blocked or cancelled work.
export async function recoverMergedStrategyDelivery(service, issue) {
  const record = service.lifecycleRuns[issue.id];
  if (!hasRecoverablePR(record)) return null;
  requireThat(!service.lifecycleTasks.has(issue.id), 'Wait for the current issue action to finish.');
  const tasks = recoveryTasks(service);
  const active = tasks.get(issue.id);
  if (active) return active;
  const task = verifySavedPR(service, issue, record).finally(() => tasks.delete(issue.id));
  tasks.set(issue.id, task);
  return task;
}

export const recoverCancelledStrategyDelivery = recoverMergedStrategyDelivery;

function hasRecoverablePR(record) {
  return Boolean(['blocked', 'cancelled'].includes(record?.status) && record.work?.pr);
}

function recoveryTasks(service) {
  service.strategyDeliveryRecovery ||= new Map();
  return service.strategyDeliveryRecovery;
}

async function verifySavedPR(service, issue, record) {
  const work = record.work;
  const delivery = new DeliveryStore(service.root, issue.id);
  const existing = delivery.read();
  const saved = matchingRecovery(existing, work);
  if (saved) return saved.artifact;
  preservePriorReceipt(delivery, existing);
  const observation = await inspectSavedPR(service, work);
  const evidence = retainPRObservation(delivery, issue.id, work, observation);
  const artifact = { revision: observation.head, checkout: null, evidence: [evidence] };
  delivery.save(recoveryReceipt(work, observation, evidence, artifact));
  recordRecovery(record, work, observation, evidence);
  saveLifecycle(service, record);
  return artifact;
}

function matchingRecovery(receipt, work) {
  if (receipt?.recovery?.runId !== work.runId) return null;
  const evidence = receipt.artifact?.evidence?.[0];
  return evidence?.path && existsSync(evidence.path) ? receipt : null;
}

function preservePriorReceipt(delivery, receipt) {
  if (receipt && receipt.source !== 'merged-strategy-recovery')
    delivery.retain('previous-' + digest(JSON.stringify(receipt)), receipt);
}

async function inspectSavedPR(service, work) {
  const config = work.config;
  requireThat(config?.repository && config?.target, 'The saved PR is missing its repository or target.');
  const provider = new StrategyProvider(service.root, config, service.root);
  const observation = await provider.inspectExternalDelivery(work.pr);
  requireThat(observation.branch === work.branch, 'The saved PR now points to a different branch.');
  return observation;
}

function retainPRObservation(delivery, issueId, work, observation) {
  return delivery.retain('merged-strategy-' + recoveryKey(issueId, work, observation), observation);
}

function recoveryKey(issueId, work, observation) {
  return digest(
    JSON.stringify({
      issueId,
      runId: work.runId,
      number: work.pr,
      head: observation.head,
      mergeCommit: observation.mergeCommit,
      targetRevision: observation.targetRevision,
      checks: observation.checks,
    })
  );
}

function recoveryReceipt(work, observation, evidence, artifact) {
  return {
    state: 'verified',
    source: 'merged-strategy-recovery',
    pr: work.pr,
    url: observation.url,
    target: observation.target,
    targetRevision: observation.targetRevision,
    head: observation.head,
    mergeCommit: observation.mergeCommit,
    mergedAt: observation.mergedAt,
    checks: observation.checks,
    recovery: { runId: work.runId, at: new Date().toISOString() },
    artifact,
    evidence,
  };
}

function recordRecovery(record, work, observation, evidence) {
  record.work.deliveryRecovery = { ...observation, evidence };
  record.summary = `PR #${work.pr} is merged into ${observation.target}; its checks passed. Ready for your acceptance.`;
  record.events ||= [];
  record.events.push({ at: new Date().toISOString(), message: record.summary });
}
