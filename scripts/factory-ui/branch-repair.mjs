import { runOwnedOperation } from './stores/owned-operation.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, git, requireThat, writeJson } from './common.mjs';
import { redactValue } from './activity.mjs';
import { workVerificationScript } from './flow-verification.mjs';
import { flowWorkspace } from './flow-observer.mjs';
import { latestCurrentAttempt } from './flow-block-data.mjs';
import {
  branchRepairSource,
  sameRepairSource,
  prepareBranchRepair,
  branchRepairPatch,
  applyBranchRepair,
} from './branch-repair-workspace.mjs';
import { runBranchRepair, reconcileBranchRepair } from './branch-repair-runner.mjs';

const running = new Set(['running', 'stopping']);
const unreconciled = new Set([...running, 'uncertain']);

function mergeConflictFailure(merge, busy) {
  if (!merge || !merge.conflicts.length || busy) return null;
  return {
    kind: 'merge-conflict',
    summary: 'Automatic branch update could not resolve conflicts in ' + merge.conflicts.join(', ') + '.',
    evidence: [],
  };
}

function mergeFailureView(view, failure) {
  if (!failure || unreconciled.has(view.status)) return view;
  return { ...view, status: 'broken', failure, step: failure.summary, error: null };
}

export function branchCheckFailure(flow) {
  for (const block of flow.blocks.toReversed()) {
    const attempt = latestCurrentAttempt(block);
    if (!['failed', 'blocked'].includes(attempt?.status)) continue;
    const checks = (attempt.evidence || []).filter(({ label }) =>
      /Fallow|formatting|verification|failed command/i.test(label || '')
    );
    if (checks.length)
      return { summary: attempt.error || attempt.summary || 'A required branch check failed.', evidence: checks };
    // Older Work responses retain their check diagnostic in the structured failure.
    const failure = /```flow-result\s*\n([\s\S]*?)```/.exec(attempt.output || '');
    if (!failure) continue;
    try {
      const reason = JSON.parse(failure[1]).failure;
      if (typeof reason === 'string' && /Fallow|formatting|dependency|typecheck/i.test(reason))
        return { summary: reason, evidence: [] };
    } catch {
      /* An incomplete model response is not check evidence. */
    }
  }
  return null;
}

export class BranchRepairs {
  constructor(flows, options = {}) {
    this.flows = flows;
    this.root = flows.service.root;
    this.directory = join(this.root, '.issues/branch-repairs');
    this.run = options.run || runBranchRepair;
    this.reconcileWorker = options.reconcile || reconcileBranchRepair;
    this.active = new Map();
  }
  recordPath(id) {
    return join(this.directory, id, 'current.json');
  }
  read(id) {
    const path = this.recordPath(id);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  }
  save(record, changes = {}) {
    Object.assign(record, changes);
    writeJson(this.recordPath(record.issueId), record);
    writeJson(join(record.folder, 'run.json'), record);
  }
  workspace(flow) {
    const workspace = flowWorkspace(this.flows.service, flow);
    requireThat(
      workspace?.checkout && existsSync(workspace.checkout),
      'Create this issue’s worktree before fixing its branch.'
    );
    const checkout = realpathSync(workspace.checkout);
    const managed = realpathSync(join(this.root, '.issues'));
    const child = relative(managed, checkout);
    requireThat(
      child && !child.startsWith('..') && !isAbsolute(child),
      'Branch repair requires a managed issue checkout.'
    );
    requireThat(
      realpathSync(git(checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir')) ===
        realpathSync(git(this.root, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
      'The issue checkout belongs to another repository.'
    );
    requireThat(
      git(checkout, 'branch', '--show-current') === workspace.branch,
      'The issue checkout changed branches. Refresh before repairing.'
    );
    return { ...workspace, checkout };
  }
  definition() {
    const definition = this.flows.catalog.read().entries.find(({ id }) => id === 'fix-the-branch');
    requireThat(definition?.usable && definition.prompt, 'Fix the Branch needs a valid block definition.');
    return definition;
  }
  current(record, flow) {
    return (
      record.comparisonBase === this.workspace(flow).base &&
      record.verifierChecksum === digest(readFileSync(workVerificationScript)) &&
      record.runtimeVersion === process.version &&
      record.definitionChecksum === this.definition().checksum &&
      sameRepairSource(record.source, branchRepairSource(this.workspace(flow).checkout))
    );
  }
  view(issue, flow, merge = null) {
    const record = this.read(issue.id);
    const mergeFailure = mergeConflictFailure(merge, this.flows.active.has(issue.id));
    const failure = mergeFailure || branchCheckFailure(flow);
    if (!record) return { status: failure ? 'broken' : 'idle', failure };
    const status = this.recordStatus(record, flow);
    return mergeFailureView(
      {
        id: record.id,
        status,
        branch: record.source?.branch,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        lastActiveAt: record.lastActiveAt,
        step: record.step,
        output: record.output,
        error: record.error,
        report: record.report,
        diff: record.diff,
        candidateTree: record.candidateTree,
        checks: (record.checks || []).map(({ label }) => ({ label })),
        failure,
      },
      mergeFailure
    );
  }
  recordStatus(record, flow) {
    if (unreconciled.has(record.status)) return this.active.has(flow.issueId) ? record.status : 'interrupted';
    if (!['ready', 'passed'].includes(record.status)) return record.status;
    return this.candidateStatus(record, flow);
  }
  candidateStatus(record, flow) {
    try {
      return this.current(record, flow) && branchRepairSource(record.checkout).tree === record.candidateTree
        ? record.status
        : 'stale';
    } catch {
      return 'stale';
    }
  }

  requireIdle(issue) {
    requireThat(
      !this.flows.active.has(issue.id) &&
        !this.flows.service.lifecycleTasks?.has(issue.id) &&
        !this.flows.service.issueChats?.active?.has(issue.id),
      'Finish or stop active issue work before changing its branch.'
    );
  }
  async action(issue, flow, input) {
    if (input.action === 'branch-repair-stop') {
      const active = this.active.get(issue.id);
      requireThat(active, 'No branch repair is running.');
      const record = this.read(issue.id);
      this.save(record, { status: 'stopping', step: 'Stopping branch repair' });
      active.controller.abort();
      return;
    }
    this.requireIdle(issue);
    if (input.action === 'branch-repair-reconcile') return this.reconcile(issue);
    requireThat(!issue.closed && issue.state !== 'needs-approval', 'Choose an approved, open issue.');
    this.flows.groups.requireIndependent(issue.id);
    requireThat(input.revision === flow.revision, 'This issue changed. Refresh before fixing its branch.');
    if (input.action === 'branch-repair-approve') return this.approve(issue, flow, input);
    requireThat(!this.active.has(issue.id), 'Branch repair is already running. Open its progress.');
    const previous = this.read(issue.id);
    requireThat(
      !previous || !unreconciled.has(previous.status),
      'The previous repair was interrupted. Review it and explicitly discard its ownership before retrying.'
    );
    const workspace = this.workspace(flow);
    const source = branchRepairSource(workspace.checkout);
    const definition = this.definition();
    const id = randomUUID();
    const folder = join(this.directory, issue.id, id);
    mkdirSync(folder, { recursive: true });
    const record = {
      id,
      issueId: issue.id,
      folder,
      checkout: join(folder, 'checkout'),
      original: workspace.checkout,
      comparisonBase: workspace.base,
      source,
      definitionChecksum: definition.checksum,
      verifierChecksum: digest(readFileSync(workVerificationScript)),
      runtimeVersion: process.version,
      status: 'running',
      startedAt: new Date().toISOString(),
      step: 'Preparing isolated branch repair',
      output: '',
    };
    requireThat(/^[a-f0-9]{40}$/.test(record.comparisonBase || ''), 'The issue needs a saved comparison revision.');
    this.flows.pauseAutoplay(issue.id, 'Branch repair is running.');
    const controller = new AbortController();
    this.save(record);
    const task = this.execute(record, definition, controller);
    this.active.set(issue.id, { controller, task });
    void task
      .finally(() => this.active.delete(issue.id))
      .catch((error) => console.warn('Could not retain branch repair: ' + redactValue(error.message)));
  }
  async execute(record, definition, controller) {
    if (!this.flows.service.projectStores) return executeRepair(this, record, definition, controller);
    const issue = this.flows.selected(record.issueId);
    return runOwnedOperation(this.flows, {
      issue,
      flow: this.flows.read(issue),
      label: 'Prepare isolated branch repair',
      operation: 'prepare-branch-repair',
      controller,
      run: async ({ onProgress }) => {
        await executeRepair(this, record, definition, controller, onProgress);
        return {
          status: ['ready', 'passed'].includes(record.status)
            ? 'completed'
            : record.status === 'failed'
              ? 'blocked'
              : record.status,
          summary: record.step,
          evidence: [
            ...(record.checks || []),
            {
              path: join(record.folder, 'run.json'),
              label: 'Branch repair history',
              sha256: digest(readFileSync(join(record.folder, 'run.json'))),
            },
            ...(existsSync(join(record.folder, 'repair.patch'))
              ? [{ path: join(record.folder, 'repair.patch'), label: 'Branch repair patch', sha256: record.patchHash }]
              : []),
          ],
          result: { repairId: record.id, status: record.status, candidateTree: record.candidateTree || null },
        };
      },
    });
  }

  approve(issue, flow, input) {
    requireThat(!this.active.has(issue.id), 'Wait for branch repair to finish.');
    const record = this.read(issue.id);
    requireThat(
      record?.status === 'ready' && input.repairId === record.id && input.candidateTree === record.candidateTree,
      'Review the current branch fix before approving.'
    );
    requireThat(
      this.current(record, flow),
      'The issue checkout or check configuration changed. Recheck the branch fix before approving.'
    );
    requireThat(
      branchRepairSource(record.checkout).tree === record.candidateTree,
      'The repair candidate changed. Recheck it before approving.'
    );
    const patch = readFileSync(join(record.folder, 'repair.patch'), 'utf8');
    requireThat(digest(patch) === record.patchHash, 'The retained repair patch changed. Recheck before approving.');
    for (const check of record.checks || [])
      requireThat(
        !check.path || digest(readFileSync(check.path)) === check.sha256,
        'The retained check evidence changed. Recheck before approving.'
      );
    const apply = () => {
      requireThat(this.current(record, flow), 'The issue checkout changed before shared ownership was confirmed.');
      applyBranchRepair(record.original, patch);
      this.save(record, {
        status: 'applied',
        step: 'Branch fix applied as uncommitted changes',
        endedAt: new Date().toISOString(),
      });
      this.flows.pauseAutoplay(issue.id, 'Branch fix applied. Continue issue work explicitly.');
      return {
        summary: 'The reviewed branch repair was applied.',
        result: { repairId: record.id, candidateTree: record.candidateTree },
      };
    };
    if (this.flows.service.projectStores)
      return runOwnedOperation(this.flows, {
        issue,
        flow,
        label: 'Apply reviewed branch repair',
        operation: 'apply-branch-repair',
        run: async () => apply(),
      });
    apply();
  }
  async reconcile(issue) {
    requireThat(!this.active.has(issue.id), 'Stop the active repair before reconciling it.');
    const record = this.read(issue.id);
    requireThat(record && unreconciled.has(record.status), 'No interrupted repair needs reconciliation.');
    await this.reconcileWorker(record);
    this.save(record, {
      status: 'interrupted',
      step: 'Previous repair retained for review',
      endedAt: new Date().toISOString(),
    });
  }
  close() {
    for (const active of this.active.values()) active.controller.abort();
  }
}

async function executeRepair(repairs, record, definition, controller, onProgress) {
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(2700000)]);
  const retain = (changes) => repairs.save(record, changes);
  const progress = (value) => {
    onProgress?.(value);
    retain({
      output: (record.output + redactValue(String(value))).slice(-64000),
      lastActiveAt: new Date().toISOString(),
    });
  };
  try {
    record.snapshotBase = prepareBranchRepair(record.original, record.source, record.checkout);
    repairs.save(record);
    await repairs.run({
      root: repairs.root,
      run: record,
      definition,
      signal,
      retain,
      progress,
      step: (step) => retain({ step: redactValue(String(step)).slice(0, 500), lastActiveAt: new Date().toISOString() }),
    });
    signal.throwIfAborted();
    const candidate = branchRepairSource(record.checkout);
    const diff = branchRepairPatch(record.checkout, record.snapshotBase, candidate.tree);
    requireThat(
      diff.length <= 1024 * 1024,
      'The repair diff is too large for review. Narrow the repair before approval.'
    );
    const checks = (record.checks || []).map((check) => ({
      ...check,
      sha256: check.path ? digest(readFileSync(check.path)) : null,
    }));
    writeFileSync(join(record.folder, 'repair.patch'), diff, { mode: 0o600 });
    retain({
      candidateTree: candidate.tree,
      patchHash: digest(diff),
      diff,
      checks,
      status: diff ? 'ready' : 'passed',
      step: diff ? 'Branch fix is ready for approval' : 'Branch checks passed without repairs',
      endedAt: new Date().toISOString(),
    });
  } catch (error) {
    retain({
      status: error.uncertain ? 'uncertain' : signal.aborted ? 'stopped' : 'failed',
      error: redactValue(error.message),
      step: signal.aborted ? 'Branch repair stopped' : 'Branch repair failed',
      endedAt: new Date().toISOString(),
    });
  }
}
