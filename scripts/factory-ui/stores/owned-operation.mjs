import { prepareAttemptCommit } from './flow-evidence.mjs';
import { makeBlock } from '../flow-store.mjs';
import { redactValue } from '../activity.mjs';

function metadataOperation(flows, run) {
  const records = flows.service.projectStores.records;
  return records.transaction ? records.transaction(run) : run();
}

function recordProgress(flows, issue, block, attempt, owner, value) {
  const text = redactValue(String(value));
  flows.service.projectStores.recordProgress(owner, { kind: 'output', text });
  flows.changeAttempt(issue, block.id, attempt.id, (current) => {
    current.output = (current.output + text).slice(-64000);
    current.summary = text.trim().split('\n').at(-1)?.slice(0, 500) || current.summary;
  });
}

function operationContext(flows, issue, admitted, block, attempt, controller) {
  const owner = admitted.owned.storeOwner;
  return {
    flow: admitted.flow,
    block,
    attempt,
    signal: controller.signal,
    change: (change) => flows.changeAttempt(issue, block.id, attempt.id, change),
    onProgress: (value) => recordProgress(flows, issue, block, attempt, owner, value),
    onStep: (step) => flows.changeAttemptStep(issue, block.id, attempt.id, step),
    onInputRequired: () =>
      flows.changeAttempt(issue, block.id, attempt.id, (current) => {
        current.inputRequestedAt ??= new Date().toISOString();
      }),
    onEvent: (event) =>
      flows.service.projectStores.recordProgress(owner, { kind: 'provider', event: redactValue(event) }),
  };
}

function retireOperation(flow, operationId) {
  const index = flow.blocks.findIndex((block) => block.id === operationId);
  const [retired] = flow.blocks.splice(index, 1);
  for (const block of flow.blocks)
    block.after = block.after.flatMap((id) => (id === operationId ? retired.after : [id]));
  (flow.retiredBlocks ||= []).push(retired);
}

function terminalOutcome(flows, issue, block, attempt, result, error, controller) {
  let outcome;
  flows.changeAttempt(issue, block.id, attempt.id, (current, flow) => {
    Object.assign(current, result, { endedAt: new Date().toISOString(), status: result?.status || 'completed' });
    if (result?.workspace) {
      flow.workspace = result.workspace;
      flow.workspaceRunnerId = flows.active.get(issue.id)?.storeOwner?.runnerId;
    }
    if (error)
      Object.assign(current, {
        status: error.uncertain ? 'uncertain' : controller.signal.aborted ? 'stopped' : 'blocked',
        summary: redactValue(error.message),
        evidence: error.evidence || [],
      });
    const receipt = result?.mergedReceipt || flows.active.get(issue.id)?.mergedReceipt;
    if (receipt) {
      flow.merged = receipt;
      current.mergedReceipt = receipt;
      if (current.status !== 'uncertain') {
        current.status = 'completed';
        current.summary = 'The pull request merged. No further issue work was started.';
      }
      if (error) current.postMergeNotice = redactValue(error.message);
    }
    outcome = current;
    retireOperation(flow, block.id);
  });
  return outcome;
}

async function completeOperation(flows, issue, admitted, block, outcome) {
  const owner = admitted.owned.storeOwner;
  if (outcome.status === 'uncertain') {
    await prepareAttemptCommit(flows, issue, owner, outcome, block);
    await flows.service.projectStores.flushProgress(owner);
    await flows.store.flush(issue.id);
    return;
  }
  await flows.confirmAttempt(issue, owner, outcome, block);
}

export async function startOwnedOperation(
  flows,
  {
    issue,
    flow,
    label,
    operation,
    run,
    controller = new AbortController(),
    movingStartingPoint = false,
    shareSourceCheckpoint = false,
  }
) {
  const catalog = flows.catalog.read().entries;
  const prepared = structuredClone(flow);
  const block = makeBlock('update-branch', prepared.blocks.length ? [prepared.blocks.at(-1).id] : [], false, catalog);
  Object.assign(block, { label, operation, shareSourceCheckpoint });
  prepared.blocks.push(block);
  const attempt = flows.makeAttempt(prepared, issue, block, catalog);
  let admitted;
  try {
    admitted = await metadataOperation(flows, () => flows.admitAttempt(issue, prepared, block, attempt, controller));
  } catch (error) {
    flows.active.delete(issue.id);
    throw error;
  }
  admitted.owned.movingStartingPoint = movingStartingPoint;
  const task = executeOperation(flows, { issue, admitted, block, attempt, controller, run });
  admitted.owned.task = task;
  return { task, owner: admitted.owned.storeOwner, signal: controller.signal };
}

export async function runOwnedOperation(flows, options) {
  return (await startOwnedOperation(flows, options)).task;
}

function operationCheckpoint(flows, issue, owner, controller) {
  let pending;
  const timer = setInterval(() => {
    pending ||= flows
      .synchronizeAttempt(issue, owner, controller)
      .catch((error) => flows.pause(issue.id, 'Waiting for shared storage: ' + redactValue(error.message)))
      .finally(() => {
        pending = null;
      });
  }, 5000);
  timer.unref();
  return () => {
    clearInterval(timer);
    return pending;
  };
}

async function executeOperation(flows, { issue, admitted, block, attempt, controller, run }) {
  const context = operationContext(flows, issue, admitted, block, attempt, controller);
  const checkpoint = operationCheckpoint(flows, issue, admitted.owned.storeOwner, controller);
  let result;
  let failure;
  try {
    result = await run(context);
  } catch (error) {
    failure = error;
  } finally {
    await checkpoint();
  }
  const outcome = terminalOutcome(flows, issue, block, attempt, result, failure, controller);
  await metadataOperation(flows, () => completeOperation(flows, issue, admitted, block, outcome));
  if (flows.active.get(issue.id) === admitted.owned) flows.active.delete(issue.id);
  if (failure && !(outcome.mergedReceipt && failure.code === 'STORE_MERGED')) throw failure;
  return outcome;
}
