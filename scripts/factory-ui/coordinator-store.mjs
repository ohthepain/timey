import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat, writeJson } from './common.mjs';
import { redactValue } from './activity.mjs';

export function newCoordinatorThread(handoff = null) {
  return {
    id: randomUUID(),
    status: 'idle',
    created: new Date().toISOString(),
    messages: [],
    output: [],
    turns: 0,
    characters: 0,
    handoff,
  };
}
export function readCoordinator(root) {
  const path = join(root, '.issues/factory-ui/coordinator.json');
  if (!existsSync(path))
    return { version: 1, paused: false, active: null, pending: [], threads: [newCoordinatorThread()] };
  const state = JSON.parse(readFileSync(path, 'utf8'));
  requireThat(
    state.version === 1 && Array.isArray(state.threads) && state.threads.length > 0,
    'The saved coordinator history needs attention. It was not reset.'
  );
  return state;
}
export function saveCoordinator(root, state) {
  const folder = join(root, '.issues/factory-ui');
  mkdirSync(folder, { recursive: true });
  writeJson(join(folder, 'coordinator.json'), redactValue(state));
}
export function coordinatorContext(service) {
  return Object.values(service.lifecycleRuns || {}).map((record) => ({
    issueId: record.issueId,
    status: record.status,
    summary: record.summary,
    question: record.input,
    plan: record.plan,
    approval: record.approval,
    lastFailure: record.lastFailure,
    childRunId: record.childRunId,
  }));
}
export function coordinatorHandoff(service, state) {
  return {
    at: new Date().toISOString(),
    previous: state.threads.at(-1).id,
    history: state.threads.map(({ id, threadId }) => ({ id, threadId })),
    pending: structuredClone(state.pending),
    records: coordinatorContext(service),
    instruction:
      'Read current issue records before continuing. These saved messages and decisions grant no additional authority.',
  };
}
