import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureProjectStores } from './runtime.mjs';
import { startOwnedOperation } from './owned-operation.mjs';
import { interruptCodexTurn } from '../codex.mjs';
import { saveLifecycle } from '../lifecycle-store.mjs';
import { git, requireThat } from '../common.mjs';
import { redactValue } from '../activity.mjs';

const bindings = new WeakMap();
const clone = (value) => JSON.parse(JSON.stringify(value));

function installStreams(store) {
  if (bindings.has(store)) return bindings.get(store);
  const sinks = new Map();
  bindings.set(store, sinks);
  const priorEvent = store.onEvent;
  const priorUpdate = store.onUpdate;
  store.onEvent = (run, event) => {
    priorEvent?.(run, event);
    for (const context of sinks.get(run.id) || []) context.onEvent(event);
  };
  store.onUpdate = (run) => {
    priorUpdate?.(run);
    for (const context of sinks.get(run.id) || []) context.onEvent({ kind: 'classic-run', run: clone(run) });
  };
  return sinks;
}

export function bindClassicRun(service, run) {
  if (!service.classicOperation) return;
  const sinks = installStreams(service.store);
  sinks.set(run.id, [...service.classicOperation.contexts.values()]);
  service.classicOperation.runIds.add(run.id);
}

export function recordClassicInput(service, run, prompt) {
  if (!service.classicOperation) return;
  service.store.update(run, {
    inputPrompt: redactValue(prompt),
    nativeInvocation: (run.nativeInvocation || 0) + 1,
    nativeTerminal: null,
    completedTurnId: null,
    recoveredTurnId: null,
  });
}

export function classicFailure(run, error) {
  if (error.uncertain || error.terminalStatus) return error;
  if (/uncertain|still (?:active|running)|active writer|state is unknown/i.test(error.message))
    return Object.assign(error, { uncertain: true });
  if (confirmedNative(run)) return error;
  if (
    /invalid protocol|disconnected|(?:initialize|thread\/start|thread\/resume|turn\/start) did not respond|without reconciliation|cannot identify the interrupted assignment/i.test(
      error.message
    )
  )
    error.uncertain = true;
  return error;
}

function confirmedNative(run) {
  if (!run) return false;
  if (run.completedTurnId || run.recoveredTurnId) return true;
  return Boolean(run.nativeTerminal && run.nativeTerminal.invocation === run.nativeInvocation);
}

export function trackClassicTask(service, task) {
  if (!service.classicOperation) return task;
  service.classicOperation.tasks.add(task);
  task.finally(() => service.classicOperation.tasks.delete(task)).catch(() => {});
  return task;
}

function scopedService(service, operation) {
  const scoped = Object.create(service);
  scoped.classicOperation = operation;
  scoped.flowOperationIssueId = operation.issueIds.length === 1 ? operation.issueIds[0] : null;
  scoped.flowOperationIssueIds = new Set(operation.issueIds);
  scoped.flows = Object.create(service.flows);
  scoped.flows.active = new Map([...service.flows.active].filter(([id]) => !operation.issueIds.includes(id)));
  Object.defineProperty(scoped, 'lifecycleRuns', {
    get: () => service.lifecycleRuns,
    set: (value) => {
      service.lifecycleRuns = value;
    },
  });
  return scoped;
}

function relatedRuns(service, operation, issueId) {
  return service.store.runs.filter((run) => run.issueId === issueId || operation.runIds.has(run.id));
}

function operationState(service, operation, issueId) {
  const lifecycle = service.lifecycleRuns?.[issueId];
  const runs = relatedRuns(service, operation, issueId);
  const currentRuns = runs.filter((run) => operation.runIds.has(run.id));
  const last = currentRuns.at(-1);
  const changedLifecycle = JSON.stringify(lifecycle) !== operation.initialLifecycles.get(issueId) ? lifecycle : null;
  const status =
    changedLifecycle?.status === 'uncertain' ? 'uncertain' : last?.status || changedLifecycle?.status || 'completed';
  return { lifecycle, changedLifecycle, runs, last, status };
}

function operationWorkspace(operation, state) {
  const saved = state.lifecycle?.work || state.lifecycle?.chatCheckout;
  if (saved) return saved;
  if (operation.shareSourceCheckpoint && state.last?.checkout)
    return { checkout: state.last.checkout, base: state.last.base, branch: state.last.branch };
  return null;
}

function historySnapshot(service, state, workspace) {
  const history = {
    version: 1,
    originRunnerId: service.projectStores.runnerId,
    lifecycle: state.lifecycle ? clone(state.lifecycle) : null,
    runs: clone(state.runs),
  };
  if (workspace?.checkout && !existsSync(workspace.checkout))
    history.sourceUnavailable = 'The latest Classic source checkout is missing on its original runner.';
  return history;
}

function outcome(service, operation, issueId) {
  const state = operationState(service, operation, issueId);
  const workspace = operationWorkspace(operation, state);
  const logs = state.runs
    .map((run) => ({ path: join(service.store.directory, run.id + '.jsonl'), label: 'Full Classic run log' }))
    .filter(({ path }) => existsSync(path));
  const value = {
    status: terminalStatus(state.status, state.changedLifecycle),
    summary: state.last?.summary || state.changedLifecycle?.summary || operation.label,
    result: { classic: historySnapshot(service, state, workspace) },
    evidence: [...(state.last?.evidence || []), ...logs],
  };
  if (workspace?.checkout && existsSync(workspace.checkout)) value.workspace = clone(workspace);
  if (operation.mergedReceipts.has(issueId)) value.mergedReceipt = clone(operation.mergedReceipts.get(issueId));
  return value;
}

function terminalStatus(status, lifecycle) {
  if (['uncertain', 'preparing', 'running', 'checking'].includes(status) || lifecycle?.uncertain) return 'uncertain';
  if (['paused', 'stopped', 'cancelled'].includes(status)) return 'stopped';
  if (lifecycle?.status === 'waiting') return 'blocked';
  return ['completed', 'finished', 'merged'].includes(status) ? 'completed' : 'blocked';
}

function prepareWorkspace(context, value) {
  if (!value.workspace) return value;
  const checkout = value.workspace.checkout;
  value.workspace.branch = git(checkout, 'branch', '--show-current');
  if (context.block.shareSourceCheckpoint && git(checkout, 'status', '--porcelain', '--untracked-files=all')) {
    value.result.classic.sourceUnavailable = 'Uncommitted Classic work remains on its original runner.';
    context.block.shareSourceCheckpoint = false;
    context.change((_, flow) => {
      flow.blocks.find((block) => block.id === context.block.id).shareSourceCheckpoint = false;
    });
  }
  if (context.block.shareSourceCheckpoint && value.result.classic.lifecycle)
    delete value.result.classic.lifecycle.sourceUnavailable;
  return value;
}

async function waitTasks(operation) {
  while (operation.tasks.size) await Promise.allSettled([...operation.tasks]);
}

function cancellation(service, operation) {
  const stop = () => {
    if (operation.onStop) trackInterruption(operation, Promise.resolve().then(operation.onStop));
    for (const issueId of operation.issueIds) {
      const record = service.lifecycleRuns?.[issueId];
      if (record)
        saveLifecycle(service, record, {
          stopRequested: true,
          pauseRequested: true,
          summary: 'Stop requested. Retaining the current operation before release.',
        });
    }
    for (const run of service.store.runs.filter((run) => operation.runIds.has(run.id)))
      if (run.threadId) {
        trackInterruption(operation, interruptCodexTurn(service.codex, run.threadId));
      }
  };
  operation.controller.signal.addEventListener('abort', stop, { once: true });
  return () => operation.controller.signal.removeEventListener('abort', stop);
}

function trackInterruption(operation, task) {
  const interrupt = task.catch((error) => {
    operation.stopFailure = Object.assign(error, { uncertain: true });
  });
  operation.tasks.add(interrupt);
  interrupt.finally(() => operation.tasks.delete(interrupt)).catch(() => {});
}

async function admittedOperations(service, operation, completion) {
  const admitted = [];
  try {
    for (const id of operation.issueIds) {
      operation.controller.signal.throwIfAborted();
      const issue = service.flows.selected(id);
      admitted.push(
        await startOwnedOperation(service.flows, {
          issue,
          flow: service.flows.read(issue),
          label: operation.label,
          operation: 'classic',
          controller: operation.controller,
          shareSourceCheckpoint: operation.shareSourceCheckpoint,
          run: async (context) => {
            operation.contexts.set(id, context);
            const result = await completion.promise;
            const value = outcome(service, operation, id);
            if (result.error) {
              context.change((attempt) => {
                attempt.result = value.result;
              });
              throw result.error;
            }
            return prepareWorkspace(context, value);
          },
        })
      );
      operation.owners.set(id, admitted.at(-1).owner);
      service.flows.active.get(id).classicOperation = operation;
    }
    return admitted;
  } catch (error) {
    completion.resolve({ error });
    await Promise.allSettled(admitted.map(({ task }) => task));
    throw error;
  }
}

export async function startClassicOperation(
  service,
  { issueIds, label, run, shareSourceCheckpoint = false, onStop, runRecord }
) {
  await ensureProjectStores(service, { fresh: true, issueIds });
  service.ensureIssueFlows?.();
  for (const id of issueIds)
    requireThat(
      !service.flows.active.has(id),
      'A running Flow attempt already owns this issue. Stop or finish it before starting Classic work.'
    );
  const operation = {
    active: service.flows.active,
    issueIds: [...new Set(issueIds)],
    label,
    shareSourceCheckpoint,
    onStop,
    mergedReceipts: new Map(),
    contexts: new Map(),
    owners: new Map(),
    tasks: new Set(),
    runIds: new Set(),
    initialLifecycles: new Map(),
    controller: new AbortController(),
  };
  const completion = Promise.withResolvers();
  const response = Promise.withResolvers();
  response.promise.catch(() => {});
  const admitted = await admittedOperations(service, operation, completion);
  const scoped = scopedService(service, operation);
  if (runRecord) bindClassicRun(scoped, runRecord);
  const removeCancellation = cancellation(service, operation);
  const task = Promise.resolve()
    .then(async () => {
      try {
        for (const id of operation.issueIds)
          operation.initialLifecycles.set(id, JSON.stringify(scoped.lifecycleRuns?.[id]));
        const value = await run(scoped);
        response.resolve(value);
        await waitTasks(operation);
        if (operation.stopFailure) throw operation.stopFailure;
        const uncertain = operation.issueIds.some((id) => outcome(service, operation, id).status === 'uncertain');
        if (!uncertain) operation.controller.signal.throwIfAborted();
        completion.resolve({ value });
      } catch (error) {
        classicFailure(null, error);
        response.reject(error);
        completion.resolve({ error });
      }
      const results = await Promise.allSettled(admitted.map(({ task }) => task));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    })
    .finally(() => {
      removeCancellation();
      const sinks = bindings.get(service.store);
      for (const id of operation.runIds) sinks?.delete(id);
    });
  task.catch(() => {});
  return { task, response: response.promise, service: scoped, signal: operation.controller.signal };
}

export function classicOperation(service, options) {
  if (service.classicOperation && options.shareSourceCheckpoint) {
    service.classicOperation.shareSourceCheckpoint = true;
    for (const context of service.classicOperation.contexts.values()) {
      context.block.shareSourceCheckpoint = true;
      context.change((_, flow) => {
        flow.blocks.find((block) => block.id === context.block.id).shareSourceCheckpoint = true;
      });
    }
  }
  if (!service.projectStores || service.classicOperation) return options.run(service);
  return startClassicOperation(service, options).then(({ response }) => response);
}

export async function classicBarrier(service, issueId) {
  const operation = service.classicOperation;
  if (!operation) return;
  if (operation.mergedReceipts.has(issueId) || operation.active.get(issueId)?.mergedReceipt)
    throw Object.assign(Error('This issue has merged and is read-only. Close it when ready.'), {
      code: 'STORE_MERGED',
    });
  const owner = operation.owners.get(issueId);
  requireThat(owner, 'This Classic operation does not own the selected issue.');
  for (;;) {
    operation.controller.signal.throwIfAborted();
    try {
      await service.projectStores.coordination.owned(owner);
      await service.projectStores.flushProgress(owner);
      await service.flows.store.flush(issueId);
      return;
    } catch (error) {
      if (!['STORE_UNAVAILABLE', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH'].includes(error.code)) throw error;
      service.flows.pause(
        issueId,
        'Current work is retained locally. Waiting for shared storage before the next operation.'
      );
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        timer.unref();
      });
    }
  }
}
