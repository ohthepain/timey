import { join } from 'node:path';
import { digest, git, writeJson } from './common.mjs';
import { lifecycleEvent, saveLifecycle } from './lifecycle-store.mjs';
import { candidateInput } from './candidate-cache.mjs';

export const blockerRepairPolicy = Object.freeze({ version: 1, attempts: 3, infrastructureRetries: 3 });

export function repairableBlocker(code, message, evidence = []) {
  return Object.assign(Error(message), { code, repairable: true, evidence });
}

export function infrastructureFailure(error) {
  if (terminalInfrastructure(error)) return false;
  return (
    error.transient === true ||
    /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|HTTP (429|500|502|503|504)|error connecting to api.github.com|connection (reset|timed out)|temporary failure|could not resolve host|failed to connect|operation timed out/i.test(
      [error.code, error.message, error.stderr].filter(Boolean).join(' ')
    )
  );
}

function terminalInfrastructure(error) {
  return [
    permissionFailure(error),
    /invalid protocol/i.test(error.message),
    permanentAuthenticationFailure(error),
  ].some(Boolean);
}

function permanentAuthenticationFailure(error) {
  return /authentication/i.test(error.message) && error.transient !== true;
}

export function permissionFailure(error) {
  return /EACCES|EPERM|permission denied|access denied|not permitted|HTTP (401|403)/i.test(
    [error.code, error.message, error.stderr].filter(Boolean).join(' ')
  );
}

function assertRepairActive(record) {
  if (record.stopRequested || record.pauseRequested)
    throw Error('Stopped by you. Saved work and repair evidence are retained.');
}

export async function strategyDelay(service, record, milliseconds) {
  const end = Date.now() + milliseconds;
  do {
    assertRepairActive(record);
    if (service.strategyDelay) return service.strategyDelay(milliseconds);
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, end - Date.now())));
  } while (Date.now() < end);
  assertRepairActive(record);
}

// Retry only observations/idempotent work. A merge caller must reconcile its PR
// before another merge request; chat creation and unknown writer state never retry.
export async function retryInfrastructure(service, record, operation) {
  for (let retry = 0; ; retry++) {
    assertRepairActive(record);
    try {
      return await operation();
    } catch (error) {
      if (!mayRetryInfrastructure(error, retry)) throw error;
      lifecycleEvent(service, record, `Temporary infrastructure failure; retry ${retry + 1}/3: ${error.message}`);
      await strategyDelay(service, record, 1000 * 2 ** retry);
    }
  }
}

function mayRetryInfrastructure(error, retry) {
  return infrastructureFailure(error) && retry < blockerRepairPolicy.infrastructureRetries;
}

function blockerKey(error) {
  const stable = (error.blockerKey || error.message)
    .replace(/\b[a-f0-9]{7,64}\b/gi, '<revision>')
    .replace(/(?:\/(?:[^\s:]+\/)*[^\s:]+)|\b\d+\b/g, '<location>');
  return digest(error.code + ':' + stable);
}

function saveRepairs(service, record, run) {
  const path = join(service.store.directory, run.id, 'repairs.json');
  writeJson(path, record.work.repairs);
  service.store.update(run, { repairEvidence: path });
  saveLifecycle(service, record);
}

function reserveAttempt(service, record, run, error) {
  const key = blockerKey(error);
  const ledger = repairLedger(record.work);
  let blocker = ledger.find((entry) => entry.runId === run.id && entry.key === key);
  if (!blocker) {
    blocker = newBlocker(run, error, key);
    ledger.push(blocker);
  }
  if (blocker.attempts.length >= blockerRepairPolicy.attempts)
    throw Error(
      `Stopped after three repair approaches to the same blocker. ${error.message} Repair evidence: ${run.repairEvidence}`
    );
  const attempt = {
    before: git(record.work.checkout, 'rev-parse', 'HEAD'),
    beforeTree: git(record.work.checkout, 'rev-parse', 'HEAD^{tree}'),
    beforeInputs: repairInputs(record.work),
    at: new Date().toISOString(),
    status: 'started',
  };
  blocker.attempts.push(attempt);
  saveRepairs(service, record, run);
  return { blocker, attempt };
}

function repairLedger(work) {
  if (!work.repairs) work.repairs = [];
  return work.repairs;
}

function newBlocker(run, error, key) {
  return { runId: run.id, key, code: error.code, problem: error.message, evidence: error.evidence || [], attempts: [] };
}

function retainApproach(blocker, attempt, result) {
  const approach = result?.repair?.approach?.trim();
  if (!approach)
    throw Error('The repair did not describe its approach. Saved work is retained; no blind retry was started.');
  const normalized = approach.toLowerCase().replace(/\s+/g, ' ');
  if (
    blocker.attempts.some(
      (entry) => entry !== attempt && entry.approach?.toLowerCase().replace(/\s+/g, ' ') === normalized
    )
  )
    throw Error(
      'The agent repeated an earlier repair approach. Saved work is retained; another approach needs explicit continuation.'
    );
  Object.assign(attempt, { approach, reportedEvidence: result.repair.evidence || [] });
}

async function attemptRepair(service, record, run, error, repair) {
  const { blocker, attempt } = reserveAttempt(service, record, run, error);
  lifecycleEvent(service, record, `Repairing ${error.code}: approach ${blocker.attempts.length}/3.`);
  try {
    const result = await repair(error, blocker);
    retainApproach(blocker, attempt, result);
    attempt.after = git(record.work.checkout, 'rev-parse', 'HEAD');
    attempt.afterTree = git(record.work.checkout, 'rev-parse', 'HEAD^{tree}');
    attempt.afterInputs = repairInputs(record.work);
    requireChangedCandidate(attempt, error);
    attempt.status = 'candidate-updated';
  } catch (failure) {
    if (failure.repairResult) retainApproach(blocker, attempt, failure.repairResult);
    Object.assign(attempt, { status: 'failed', failure: failure.message });
    throw failure;
  } finally {
    saveRepairs(service, record, run);
  }
}

function requireChangedCandidate(attempt, error) {
  if (error.candidateUpdated) return;
  if (attempt.afterTree !== attempt.beforeTree) return;
  if (attempt.afterInputs !== attempt.beforeInputs) return;
  throw Error(
    `The repair made no committed source change or verification-input change. Unchanged checks were not repeated. ${error.message}`
  );
}

function repairInputs(work) {
  return candidateInput(work.checkout, work.base, 'strategy-repair-v1');
}

export async function runRepairableStrategy(service, record, run, execute, repair) {
  let pending;
  for (;;) {
    assertRepairActive(record);
    try {
      return await executeAfterRepair(service, record, run, pending, execute, repair);
    } catch (error) {
      assertRepairActive(record);
      if (!canRepair(error)) throw error;
      pending = error;
    }
  }
}

function canRepair(error) {
  return [error.repairable, !permissionFailure(error), !infrastructureFailure(error)].every(Boolean);
}

async function executeAfterRepair(service, record, run, pending, execute, repair) {
  if (pending) await attemptRepair(service, record, run, pending, repair);
  return execute();
}

export function repairInstruction(error, blocker) {
  return `Required repair attempt: ${blocker.attempts.length}/3 for this blocker. Continue in this SAME owning chat and checkout. Fix the actual blocker, including inherited defects outside the original feature when necessary. Preserve intended behavior; do not weaken tests, Fallow thresholds, exclusions or merge safeguards. Read the actual failure evidence before editing. Problem: ${error.message}\nEvidence: ${JSON.stringify(error.evidence || [])}\nEarlier attempts: ${JSON.stringify(blocker.attempts.slice(0, -1))}\nUse a materially different approach. Commit the repair separately, publish the issue branch and return repair {approach, evidence} describing the change and actual evidence paths. If a new product decision or external permission is required, return blocker.kind human or permission instead of guessing. Do not rerun the aggregate verifier; the server verifies the changed candidate.`;
}
