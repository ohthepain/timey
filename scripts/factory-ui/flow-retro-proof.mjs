import { readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { conversationTimeline } from './conversation-view.mjs';
import { readQueue } from './data.mjs';
import { digest, requireThat } from './common.mjs';
import { redactValue } from './activity.mjs';

const maxArtifacts = 12;
const maxExcerpt = 1800;

export function retroProof(service, issueId) {
  const queue = readQueue(service.root, { issueId });
  const issue = queue.issues[0] || readQueue(service.root, { location: 'closed', issueId }).issues[0];
  requireThat(issue, 'Select an existing issue.');
  return collectReferences(conversationTimeline(service, queue, issue))
    .slice(0, maxArtifacts)
    .map((artifact) => verifyArtifact(service.root, artifact));
}

function collectReferences(events) {
  const references = new Map();
  events
    .flatMap((event) => (event.source?.evidence || []).map((artifact) => ({ event, artifact })))
    .filter(({ artifact }) => validReference(artifact))
    .forEach(({ event, artifact }) => addReference(references, event, artifact));
  return [...references.values()];
}

function validReference(artifact) {
  return typeof artifact?.path === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256 || '');
}

function addReference(references, event, artifact) {
  const key = `${artifact.path}\0${artifact.sha256}`;
  const origin = { eventId: event.id, kind: event.kind, runId: event.source?.runId, attemptId: artifact.attemptId };
  const reference = references.get(key);
  if (reference) reference.origins.push(origin);
  else references.set(key, { path: artifact.path, sha256: artifact.sha256, origins: [origin] });
}

function verifyArtifact(root, artifact) {
  const base = { artifact: basename(artifact.path), sha256: artifact.sha256, origins: artifact.origins };
  const result = readArtifact(root, artifact);
  return result.status === 'verified' ? { ...base, ...result } : { ...base, status: result.status };
}

function readArtifact(root, artifact) {
  try {
    const actual = realpathSync(resolve(artifact.path));
    if (!insideCheckout(root, actual)) return { status: 'rejected-outside-checkout' };
    const bytes = readFileSync(actual);
    if (digest(bytes) !== artifact.sha256) return { status: 'digest-mismatch' };
    return { status: 'verified', excerpt: redactValue(bytes.toString('utf8')).slice(0, maxExcerpt) };
  } catch {
    return { status: 'missing' };
  }
}

function insideCheckout(root, path) {
  const rel = relative(realpathSync(root), path);
  return isAbsolute(path) && rel !== '..' && !rel.startsWith('..' + sep);
}
