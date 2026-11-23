import { readFileSync } from 'node:fs';
import { digest, requireThat } from './common.mjs';
import { latestCurrentAttempt, upstreamBlocks } from './flow-block-data.mjs';
import { groupChildren } from './issue-group.mjs';
import { evidencePath } from './stores/evidence.mjs';

const supportedBlocks = new Set(['work', 'understand', 'advice', 'playbook']);
const proofArtifact = { key: 'subIssueProof', kind: 'file', label: 'Sub-issue proof', type: 'file' };

export function withGroupProof(ctx) {
  if (!groupChildren(ctx.issue).length || !supportedBlocks.has(ctx.block.kind)) return ctx;
  const artifacts = ctx.definition.artifacts.filter((artifact) => artifact.key !== proofArtifact.key);
  return { ...ctx, definition: { ...ctx.definition, artifacts: [...artifacts, proofArtifact] } };
}

export function groupProofRequest(issue) {
  if (!issue.issue_group?.children?.length) return null;
  return {
    task: 'Only the currently attached sub-issues are in scope. Check each one against its requested proof. Write a JSON array to the subIssueProof artifact with one entry per checked issue: {"id": "full issue id", "status": "passed" or "failed", "observation": "command or validation performed and its actual outcome", "nextAction": "optional specific action for a failure"}. Report only checks you actually performed. Include relevant supporting output in the normal evidence. If any check fails, also report the issue under the flow-result failure field.',
    attached: groupChildren(issue).map(({ id, title, requestedProof }) => ({ id, title, requestedProof })),
    detached: issue.issue_group.children.filter((child) => child.detachedAt).map(({ id, title }) => ({ id, title })),
  };
}

function readProof(file, root) {
  if (!file?.sha256) return [];
  try {
    const bytes = readFileSync(evidencePath(root, file.path, file.sha256));
    if (digest(bytes) !== file.sha256) return [];
    const entries = JSON.parse(bytes);
    if (!Array.isArray(entries) || new Set(entries.map((row) => row.id)).size !== entries.length) return [];
    return entries.filter(
      (row) =>
        typeof row.id === 'string' &&
        ['passed', 'failed'].includes(row.status) &&
        typeof row.observation === 'string' &&
        row.observation.trim() &&
        (row.nextAction === undefined || typeof row.nextAction === 'string')
    );
  } catch {
    return [];
  }
}

function groupProofAttempts(flow, tree, block) {
  return upstreamBlocks(block, flow.blocks)
    .filter(({ kind }) => supportedBlocks.has(kind))
    .map(latestCurrentAttempt)
    .filter((attempt) => ['completed', 'failed', 'blocked'].includes(attempt?.status))
    .filter((attempt) => !tree || attempt.result?.tree === tree)
    .sort((left, right) => (left.endedAt ?? '').localeCompare(right.endedAt ?? ''));
}

function groupAttemptRows(attempt, tree, root) {
  const file = attempt.artifacts?.files?.subIssueProof;
  return readProof(file, root)
    .filter(({ status }) => !tree || status !== 'passed' || attempt.status === 'completed')
    .map((entry) => [entry.id, { ...entry, file }]);
}

export function groupProofRows(flow, tree, block = {}, root) {
  return new Map(groupProofAttempts(flow, tree, block).flatMap((attempt) => groupAttemptRows(attempt, tree, root)));
}

export function requireGroupProof(issue, flow, candidateTree, block, root) {
  const children = groupChildren(issue);
  if (!children.length) return [];
  const proofs = groupProofRows(flow, candidateTree, block, root);
  const missing = children.filter(({ id }) => proofs.get(id)?.status !== 'passed');
  requireThat(
    !missing.length,
    'The current candidate needs passing proof for these sub-issues: ' +
      missing.map(({ title, id }) => title || id).join(', ') +
      '. Continue on the master or detach the issues that remain open.'
  );
  return [...new Set(children.map(({ id }) => proofs.get(id).file))];
}
