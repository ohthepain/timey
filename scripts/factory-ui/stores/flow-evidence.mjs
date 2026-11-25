import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isWorkBlock } from '../flow-store.mjs';
import { createSourceCheckpoint } from './source-checkpoints.mjs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { git } from '../common.mjs';
import { collectEvidence } from './evidence.mjs';
import { inputDigest } from './coordination.mjs';

function unique(values, identity) {
  return [...new Map(values.map((value) => [identity(value), value])).values()];
}

async function retainAttemptEvidence(stores, owner, attempt) {
  const incoming = await collectEvidence({
    root: stores.root,
    flow: { evidence: attempt.evidence, result: attempt.result, artifacts: attempt.artifacts },
    artifacts: await stores.issueArtifacts(owner.issueId),
    originId: owner.issueId,
    allowedRoots: [join(stores.root, '.issues')],
  });
  const key = 'evidence/' + owner.issueId;
  const previous = await stores.coordination.get(key);
  const retained = previous?.value ?? {};
  const { files = [], gaps = [] } = retained;
  const manifest = {
    ...retained,
    ...incoming,
    files: unique([...files, ...incoming.files], (file) => file.path + '\0' + file.sha256),
    gaps: unique([...gaps, ...incoming.gaps], (gap) => JSON.stringify(gap)),
  };
  if (previous && inputDigest(previous.value) === inputDigest(manifest)) return incoming.gaps;
  const claim = await stores.coordination.owned(owner);
  await stores.coordination.commit(
    'evidence-' + owner.attemptId + '-' + inputDigest(manifest),
    [
      { key, revision: previous?.revision ?? null },
      { key: claim.key, revision: claim.revision },
    ],
    [{ key, value: manifest }]
  );
  return incoming.gaps;
}

export async function prepareAttemptCommit(flows, issue, owner, outcome, block) {
  const stores = flows.service.projectStores;
  const receipt = flows.active.get(issue.id)?.mergedReceipt;
  if (receipt)
    flows.changeAttempt(issue, block.id, owner.attemptId, (_, flow) => {
      flow.merged = receipt;
    });
  const journal = stores.openJournal(owner);
  if (existsSync(journal.path)) {
    const sha256 = createHash('sha256').update(readFileSync(journal.path)).digest('hex');
    outcome.evidence = [
      ...(outcome.evidence || []).filter((entry) => entry.path !== journal.path),
      { path: journal.path, sha256, label: 'Full shared attempt log' },
    ];
    flows.changeAttempt(issue, block.id, owner.attemptId, (attempt) => {
      attempt.evidence = outcome.evidence;
    });
  }
  await shareCommittedSource(flows, issue, owner, outcome, block);
  const gaps = await retainAttemptEvidence(stores, owner, outcome);
  if (gaps.length) {
    outcome.evidenceGaps = gaps;
    if (block.kind !== 'merge' && outcome.status === 'completed' && outcome.result?.verification?.status === 'passed') {
      outcome.status = 'blocked';
      outcome.summary = 'Required proof files could not be retained. Inspect the evidence gaps before continuing.';
    }
    flows.changeAttempt(issue, block.id, owner.attemptId, (attempt) => Object.assign(attempt, outcome));
  }
}

function managedCheckout(flows, checkout) {
  if (!checkout || !existsSync(checkout)) return false;
  const child = relative(realpathSync(join(flows.service.root, '.issues')), realpathSync(checkout));
  return child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child);
}

async function shareCommittedSource(flows, issue, owner, outcome, block) {
  const classic = outcome.result?.classic;
  if (classic?.sourceUnavailable) {
    flows.changeAttempt(issue, block.id, owner.attemptId, (_, flow) => {
      flow.sourceUnavailable = classic.sourceUnavailable;
      flow.sourceUnavailableRunnerId = classic.originRunnerId || owner.runnerId;
    });
    return;
  }
  if (!isWorkBlock(block) && !block.shareSourceCheckpoint) return;
  const workspace = flows.read(issue).workspace;
  if (!managedCheckout(flows, workspace?.checkout)) return;
  if (git(workspace.checkout, 'status', '--porcelain', '--untracked-files=all')) {
    const unavailable = 'Uncommitted source remains local to its owning runner.';
    if (classic) classic.sourceUnavailable = unavailable;
    flows.changeAttempt(issue, block.id, owner.attemptId, (_, flow) => {
      flow.sourceUnavailable = unavailable;
      flow.sourceUnavailableRunnerId = owner.runnerId;
    });
    return;
  }
  if (outcome.status !== 'completed') return;
  const checkpoint = await createSourceCheckpoint({
    checkout: workspace.checkout,
    artifacts: await flows.service.projectStores.issueArtifacts(owner.issueId),
    projectId: flows.service.projectStores.projectId,
    base: workspace.base,
  });
  if (classic) classic.sourceCheckpoint = checkpoint;
  flows.changeAttempt(issue, block.id, owner.attemptId, (_, flow) => {
    flow.sourceCheckpoint = checkpoint;
    flow.workspaceRunnerId = owner.runnerId;
    delete flow.sourceUnavailable;
    delete flow.sourceUnavailableRunnerId;
  });
}
