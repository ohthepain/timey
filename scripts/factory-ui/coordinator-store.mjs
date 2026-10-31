import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat, writeJson } from './common.mjs';
import { readQueue } from './data.mjs';
import { notesPath, currentNotes } from './coordinator-notes.mjs';
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
    contextVersion: 2,
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
// Source references replace repeated snapshots of all plans and approvals.
export function coordinatorContext(service, issueId = null) {
  const root = service.root,
    directory = join(root, '.issues/factory-ui');
  mkdirSync(directory, { recursive: true });
  const index = join(directory, 'coordinator-index.json');
  const reports = existsSync(join(root, '.git'))
    ? readQueue(root).issues.map(({ id, title, state }) => ({ issueId: id, title, state }))
    : Object.values(service.lifecycleRuns || {}).map(({ issueId, status }) => ({ issueId, status }));
  writeJson(index, { issues: reports });
  return {
    root,
    selectedIssue: issueId
      ? {
          id: issueId,
          report: join(root, '.issues', issueId + '.md'),
          url: '#/issue/' + issueId,
          progressSelector: 'issues[' + JSON.stringify(issueId) + ']',
        }
      : null,
    queueIndex: index,
    issueReports: join(root, '.issues'),
    progress: join(directory, 'lifecycle.json'),
    assignments: join(root, '.issues/factory.json'),
    results: join(directory, 'runs.json'),
    workingNotes: notesPath(root),
    policy: join(root, 'docs/agents/operating.md'),
  };
}
export function coordinatorHandoff(service, state) {
  return {
    at: new Date().toISOString(),
    previous: state.threads.at(-1).id,
    workingNotes: notesPath(service.root),
    instruction:
      'Read current source records and validated working notes. Archived chats are audit history, not decision input.',
  };
}
export function coordinatorBootstrap(service, issueId) {
  return {
    sources: coordinatorContext(service, issueId),
    findings: currentNotes(service.root, issueId || undefined).slice(-8),
  };
}
