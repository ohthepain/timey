import { readProgress, writeProgress } from '../factory-progress.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeJson, digest } from './common.mjs';
import { readFileSync } from 'node:fs';

export const loadLifecycles = readProgress;
export function saveLifecycle(service, record, changes = {}) {
  Object.assign(record, changes, { updated: new Date().toISOString() });
  service.lifecycleRuns[record.issueId] = record;
  writeProgress(service.root, record);
}
export function lifecycleEvent(service, record, message, values = {}) {
  record.events.push({ at: new Date().toISOString(), message, ...values });
  saveLifecycle(service, record, { summary: message });
}
export function lifecycleView(service, issue) {
  const record = service.lifecycleRuns[issue.id];
  if (!record) return null;
  const legacy = legacyStoppedView(record);
  if (legacy) return legacy;
  return interruptedView(service, issue, record);
}
function interruptedView(service, issue, record) {
  if (record.status === 'running' && !service.lifecycleTasks.has(issue.id))
    return {
      ...record,
      status: 'paused',
      summary: 'Progress was interrupted. Resume will check the saved work before continuing.',
    };
  return record;
}

export function retainAnswer(service, record, value) {
  const path = join(service.store.directory, `answer-${randomUUID()}.json`);
  writeJson(path, { issueId: record.issueId, actor: 'human', at: new Date().toISOString(), ...value });
  saveLifecycle(service, record, { latestAnswer: { path, sha256: digest(readFileSync(path)) } });
  return path;
}

export function approvedLifecyclePlan(service, issueId) {
  const record = service.lifecycleRuns[issueId];
  return record?.approval ? record.plan : null;
}

function legacyStoppedView(record) {
  if (record.input?.type !== 'retry') return null;
  return { ...record, status: 'blocked', input: null, legacyRetry: true };
}
