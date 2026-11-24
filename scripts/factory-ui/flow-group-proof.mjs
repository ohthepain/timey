import { readFileSync } from 'node:fs';
import { digest, git, requireThat } from './common.mjs';
import { latestCurrentAttempt, upstreamBlocks } from './flow-block-data.mjs';
import { issueNumberLabel, savedIssueNumbers } from './issue-numbers.mjs';
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

function groupProofAttempts(flow, tree, block, rechecked) {
  return upstreamBlocks(block, flow.blocks)
    .filter(({ kind }) => supportedBlocks.has(kind))
    .map(latestCurrentAttempt)
    .filter((attempt) => ['completed', 'failed', 'blocked'].includes(attempt?.status))
    .filter((attempt) => matchesProofTree(attempt, tree, rechecked))
    .sort((left, right) => (left.endedAt ?? '').localeCompare(right.endedAt ?? ''));
}

function groupAttemptRows(attempt, tree, root) {
  const file = attempt.artifacts?.files?.subIssueProof;
  return readProof(file, root)
    .filter(({ status }) => !tree || status !== 'passed' || attempt.status === 'completed')
    .map((entry) => [entry.id, { ...entry, file }]);
}

export function groupProofRows(flow, tree, block = {}, root, rechecked) {
  return new Map(
    groupProofAttempts(flow, tree, block, rechecked).flatMap((attempt) => groupAttemptRows(attempt, tree, root))
  );
}

export function requireGroupProof(issue, flow, candidateTree, block, root, rechecked) {
  const children = groupChildren(issue);
  if (!children.length) return [];
  const proofs = groupProofRows(flow, candidateTree, block, root, rechecked);
  const missing = children.filter(({ id }) => proofs.get(id)?.status !== 'passed');
  requireThat(
    !missing.length,
    'The current candidate needs passing proof for these sub-issues: ' +
      missingProofLabels(root, missing) +
      '. Continue on the master or detach the issues that remain open.'
  );
  return [...new Set(children.map(({ id }) => proofs.get(id).file))];
}

function matchesProofTree(attempt, tree, rechecked = () => false) {
  if (!tree) return true;
  return attempt.result?.tree === tree || rechecked(attempt);
}

function missingProofLabels(root, missing) {
  if (!missing.length) return '';
  const numbers = root
    ? savedIssueNumbers(
        root,
        missing.map(({ id }) => id)
      )
    : {};
  return missing.map((issue) => missingProofLabel(issue, numbers[issue.id])).join(', ');
}

function missingProofLabel(issue, number) {
  const title = issue.title || issue.id;
  const issueNumber = number ?? issue.issueNumber;
  if (!Number.isSafeInteger(issueNumber)) return title;
  return issueNumberLabel({ ...issue, issueNumber }) + ' ' + title;
}

function changedPaths(checkout, from, to) {
  return git(checkout, 'diff', '--name-only', '--no-renames', '-z', from, to, '--').split('\0').filter(Boolean);
}

function verifiedFocusedCommands(proof, tree, root) {
  const bytes = readFileSync(evidencePath(root, proof.path, proof.sha256));
  if (digest(bytes) !== proof.sha256) return [];
  const summary = JSON.parse(bytes);
  if (summary.checkpoint !== 'verification' || summary.snapshot_tree !== tree) return [];
  return summary.checks
    .filter(({ passed, name }) => passed && /^focused-\d+$/.test(name))
    .map(({ command }) => JSON.stringify(command));
}

function sameImplementation(checkout, result, candidate) {
  const { base, head, tree } = result;
  try {
    git(checkout, 'merge-base', '--is-ancestor', base, head);
    git(checkout, 'merge-base', '--is-ancestor', head, candidate.head);
    if (git(checkout, 'rev-parse', head + '^{tree}') !== tree) return false;
    const updated = new Set(changedPaths(checkout, head, candidate.head));
    const implementation = changedPaths(checkout, base, head).filter((path) => !path.startsWith('docs/'));
    return implementation.length > 0 && implementation.every((path) => !updated.has(path));
  } catch {
    return false;
  }
}

function hasRecheckedCommands(focused, commands) {
  return (
    Array.isArray(focused) && focused.length > 0 && focused.every((command) => commands.has(JSON.stringify(command)))
  );
}

function recheckedAttempt(attempt, commands, checkout, candidate) {
  const result = attempt.result ?? {};
  const eligible = [
    attempt.status === 'completed',
    !result.uncommitted,
    hasRecheckedCommands(result.focusedTests, commands),
  ];
  return eligible.every(Boolean) && sameImplementation(checkout, result, candidate);
}

export function recheckedGroupProof(checkout, candidate, root) {
  const summaries = candidate.verification?.proof ?? [];
  const commands = new Set(summaries.flatMap((proof) => verifiedFocusedCommands(proof, candidate.tree, root)));
  return (attempt) => recheckedAttempt(attempt, commands, checkout, candidate);
}
