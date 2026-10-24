import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { progressBasis } from './next-action.mjs';
import { stageOutcome } from './lifecycle.mjs';
import { appendReview, reviewEvidence } from './review-result.mjs';
import { git, requireThat, writeJson } from './common.mjs';

export function beginCommit(service, queue, issue) {
  const lock = join(service.root, '.issues/factory-progress.lock');
  requireThat(
    !existsSync(join(service.root, '.issues/factory-integration.lock')),
    'An integration is still in progress. Wait for it to finish before recording the commit.'
  );
  mkdirSync(lock);
  const run = service.store.add({ id: 'record-commit' }, 'commit', queue.head);
  service.store.update(run, { issueId: issue.id, issueState: issue.state, summary: 'Recording the verified commit.' });
  writeJson(join(lock, 'owner.json'), { runId: run.id, pid: process.pid });
  service.perform(run, async () => {
    try {
      recordCommit(service, queue, issue, run);
    } finally {
      rmSync(lock, { recursive: true });
    }
  });
  return { runId: run.id };
}
function recordCommit(service, queue, issue, run) {
  const { stage, next, checked } = commitContext(queue, issue);
  service.guard(service.root, { issues: [issue.id] }, 'commit', queue.head);
  service.guard(service.root, { issues: [issue.id] }, 'advance', queue.head, { target_state: stage.next });
  const path = join(service.store.directory, run.id + '-commit.json');
  writeJson(path, {
    revision: queue.head,
    tree: git(service.root, 'rev-parse', 'HEAD^{tree}'),
    branch: git(service.root, 'branch', '--show-current'),
    subject: git(service.root, 'log', '-1', '--format=%s'),
    verified: checked.at,
  });
  const result = {
    outcome: 'completed',
    summary:
      'The verified changes are already committed. The existing commit is recorded; this issue can continue to ' +
      next.name +
      '.',
    notes: 'Recorded commit ' + queue.head + '. No new commit, behavior review, worker or integration was needed.',
    evidence: [path],
    remaining: ['Continue to ' + next.name + '. Human acceptance remains separate.'],
    next_state: stage.next,
    stage_records: [
      { state: issue.state, outcome: 'completed', reason: 'Recorded the existing verified commit ' + queue.head + '.' },
    ],
  };
  const evidence = reviewEvidence(service.root, { cwd: service.root }, result);
  requireThat(
    progressBasis(readQueue(service.root)) === progressBasis(queue),
    'The project changed while recording the commit. Refresh and try again.'
  );
  appendReview(service.root, issue, result, run, evidence, stage.next);
  service.store.update(run, { status: 'completed', summary: result.summary, result, evidence });
}

function commitContext(queue, issue) {
  requireThat(
    queue.sourceClean,
    'The project has uncommitted changes. Keep them separate from the verified commit before continuing. No changes were staged or committed.'
  );
  const stage = queue.lifecycle.find((s) => s.state === issue.state);
  const next = queue.lifecycle.find((s) => s.state === stage.next);
  requireThat(
    stage.role === 'ready-for-commit',
    'Commit must follow the configured next stage and cannot close the issue.'
  );
  requireThat(next, 'Commit needs a configured next stage.');
  requireThat(next.role !== 'closed', 'Commit cannot close the issue.');
  const verify = queue.lifecycle.find((s) => s.role === 'ready-to-verify');
  requireThat(verify, 'The configured Verify stage is missing.');
  const checked = stageOutcome(issue, verify.state);
  requireThat(checked?.outcome === 'completed', 'Verify must be recorded complete before Commit.');
  requireThat(
    checked.revision === queue.head,
    'The current commit differs from the commit recorded by Verify. Return to Verify to check the changed work.'
  );
  return { stage, next, checked };
}
