import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { digest, git, requireThat, cleanEnvironment } from './common.mjs';
import { recordedDelivery } from './delivery.mjs';

export function decisionBasis(queue, issue) {
  return digest(JSON.stringify({ issue: issue.content, lifecycle: queue.lifecycle }));
}
export function recordedResult(queue, issue) {
  if (issue.delivery) return recordedDelivery(issue);
  const last = completedResult(issue);
  return {
    revision: resultRevision(queue, issue, last),
    checkout: resultCheckout(last),
    evidence: resultEvidence(last, issue),
  };
}
function completedResult(issue) {
  return (
    issue.lifecycle_history?.findLast((entry) => entry.outcome === 'completed' && entry.next === issue.state) || {}
  );
}
function resultCheckout(last) {
  return last.checkout || null;
}
function resultEvidence(last, issue) {
  return [...(last.evidence || []), ...(issue.plan_verification?.evidence || [])].filter(hasDigest);
}

function hasDigest(entry) {
  return entry && typeof entry.path === 'string' && typeof entry.sha256 === 'string';
}
function resultRevision(queue, issue, last) {
  if (last.revision) return last.revision;
  const action =
    queue.actions.findLast((entry) => entry.issues.includes(issue.id) && entry.status === 'integrated') || {};
  return action.verified_revision || proseRevision(issue);
}
function proseRevision(issue) {
  return issue.content.match(/Committed as\s+`?([a-f0-9]{40})/i)?.[1] || null;
}
function recordedBytes(queue, artifact, entry) {
  const current = matchingBytes(entry);
  if (current) return current;
  if (mutableContext(queue, entry)) return readFileSync(entry.path);
  const bytes = committedBytes(artifact, entry);
  requireThat(matchesBytes(bytes, entry), 'Supporting evidence changed or is missing: ' + entry.path);
  return bytes;
}
function matchingBytes(entry) {
  if (!existsSync(entry.path)) return null;
  const bytes = readFileSync(entry.path);
  return digest(bytes) === entry.sha256 ? bytes : null;
}
function matchesBytes(bytes, entry) {
  return bytes && digest(bytes) === entry.sha256;
}
function committedBytes(artifact, entry) {
  if (!artifact.revision) return null;
  try {
    const { root, path } = repositoryPath(entry);
    return execFileSync('git', ['-C', root, 'show', artifact.revision + ':' + path], {
      env: cleanEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}
function repositoryPath(entry) {
  const root = git(existingFolder(dirname(entry.path)), 'rev-parse', '--show-toplevel'),
    path = relative(root, entry.path);
  requireThat(!isAbsolute(path) && !path.startsWith('..'), 'Evidence is outside the recorded source.');
  return { root, path };
}
function existingFolder(folder) {
  while (!existsSync(folder)) folder = dirname(folder);
  return folder;
}
export function validateRecordedEvidence(queue, artifact) {
  artifact.evidence.forEach((entry) => recordedBytes(queue, artifact, entry));
}
export function retainAcceptedResult(service, queue, issue) {
  const artifact = recordedResult(queue, issue),
    directory = join(service.store.directory, 'accepted-' + randomUUID());
  const files = artifact.evidence.map((entry) => ({ entry, bytes: recordedBytes(queue, artifact, entry) }));
  mkdirSync(directory, { recursive: true });
  const evidence = files.map(({ entry, bytes }, index) => {
    const path = join(directory, String(index));
    writeFileSync(path, bytes, { mode: 0o600 });
    return { path, sha256: digest(bytes), source: entry.path, recorded_sha256: entry.sha256 };
  });
  return {
    revision: artifact.revision,
    checkout: artifact.checkout,
    evidence,
    verification_rerun: false,
    observed_project_revision: queue.head,
    at: new Date().toISOString(),
  };
}

function mutableContext(queue, entry) {
  if (entry.kind === 'instruction') return true;
  if (entry.path === join(queue.root, '.issues/factory.json')) return true;
  return dirname(entry.path) === join(queue.root, '.issues') && entry.path.endsWith('.md');
}
