import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { git, readJson } from './common.mjs';
import { factory } from '../factory-ledger.mjs';
import { closedIssueState, readQueue } from './data.mjs';
import { flowTarget } from './flow-observer.mjs';
import { FlowStore } from './flow-store.mjs';
import { listStoredIssues } from './issue-report-storage.mjs';
import { loadLifecycles } from './lifecycle-store.mjs';
import { DeliveryStore } from '../issue-delivery-store.mjs';

export const heads = 'refs/heads/';

export function worktrees(root) {
  return git(root, 'worktree', 'list', '--porcelain', '-z')
    .split('\0\0')
    .filter(Boolean)
    .map((record) => {
      const fields = new Map(
        record
          .split('\0')
          .filter(Boolean)
          .map((field) => {
            const space = field.indexOf(' ');
            return space < 0 ? [field, ''] : [field.slice(0, space), field.slice(space + 1)];
          })
      );
      return {
        path: fields.get('worktree'),
        branch: fields.get('branch') || null,
        head: fields.get('HEAD') || null,
        prunable: fields.has('prunable'),
        locked: fields.has('locked'),
      };
    });
}

export function refs(root) {
  return new Map(
    git(root, 'for-each-ref', '--format=%(refname)%09%(objectname)%09%(symref)', 'refs/heads/', 'refs/remotes/')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .filter(([, , symbolic]) => !symbolic)
      .map(([ref, revision]) => [ref, revision])
  );
}

export function isMissing(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

export function isAncestor(root, tip, base) {
  if (!tip || !base) return false;
  try {
    git(root, 'merge-base', '--is-ancestor', tip, base);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function protectIssue(resources, issue, workspace) {
  if (!workspace) return;
  if (workspace.branch) resources.set(heads + workspace.branch, issue);
  if (workspace.checkout) resources.set(workspace.checkout, issue);
}

function protectFlowBranches(resources, label, flow) {
  const startingRef = flow?.startingPoint?.ref;
  if (startingRef?.startsWith(heads)) resources.set(startingRef, label);
  for (const target of [flow?.target, flow?.destination]) {
    if (target?.branch) resources.set(heads + target.branch, label);
  }
}

function issueBranchNames(issue) {
  return [issue.id, issue.issueNumber].filter(Boolean).flatMap((key) => [`codex/issue-${key}`, `factory/issue-${key}`]);
}

function issueResourceKeys(root, issue) {
  return [
    join(root, '.issues/issue-deliveries', issue.id, 'checkout'),
    join(root, '.issues/issue-work', issue.id),
    ...issueBranchNames(issue).map((name) => heads + name),
  ];
}

export function archivedIssueBranches(service, issues) {
  const { root } = service;
  const runs = loadLifecycles(root);
  const flows = new FlowStore(root);
  const target = flowTarget(root);
  return new Map(
    issues.map((issue) => {
      const { id } = issue;
      const flow = isMissing(flows.path(id)) ? null : flows.read(issue, target);
      const delivery = new DeliveryStore(root, id).read();
      const branches = new Set(
        [...issueBranchNames(issue), flow?.workspace?.branch, runs[id]?.work?.branch, delivery?.source].filter(Boolean)
      );
      return [id, branches];
    })
  );
}

function protectSavedBranches(resources, label, record) {
  if (!record || typeof record !== 'object') return;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'object') protectSavedBranches(resources, label, value);
    if (typeof value !== 'string') continue;
    if (value.startsWith(heads)) resources.set(value, label);
    else if (
      /^(?:branch|ref|source|target|headRefName|baseRefName|startingBranch|startingRef|resolvedBranch|deliveryBranch|source_branch|target_branch|starting_branch)$/i.test(
        key
      )
    )
      resources.set(heads + value, label);
  }
}

function protectReportBranches(resources, label, content, localRefs) {
  for (const token of content.split(/[\s`'"<>()[\]{},;:]+/)) {
    const ref = token.startsWith(heads) ? token : heads + token;
    if (localRefs.has(ref)) resources.set(ref, label);
    else if (localRefs.has(ref.replace(/\.$/, ''))) resources.set(ref.slice(0, -1), label);
  }
}

function unarchivedIssueRecords(root) {
  const locations = ['open', 'closed'];
  if (!locations.some((location) => listStoredIssues(root, location).length)) return { issues: [], actions: [] };
  const { reports, actions } = factory(root).issueRecords(locations);
  const numbersPath = join(root, '.issues/issue-numbers.json');
  const numbers = isMissing(numbersPath) ? {} : readJson(numbersPath).issues;
  const issues = reports.map(({ metadata, content }) => ({
    ...metadata,
    content,
    issueNumber: numbers[metadata.id],
  }));
  return { issues, actions };
}

export function issueBranchResources(service, localRefs = null) {
  const { root } = service;
  const resources = new Map();
  if (!localRefs && isMissing(join(root, '.issues/triage-labels.md'))) return resources;
  const { issues, actions } = localRefs ? unarchivedIssueRecords(root) : readQueue(root);
  const saved = loadLifecycles(root);
  const store = new FlowStore(root);
  const target = flowTarget(root);
  const closed = closedIssueState(root);
  const runs = service.store?.runs || [];
  for (const issue of issues.filter(({ state }) => localRefs || state !== closed)) {
    const title = issue.title || issue.id;
    const label = issue.issueNumber ? `#${issue.issueNumber} ${title}` : title;
    const run = saved[issue.id];
    const flow = isMissing(store.path(issue.id)) ? null : store.read(issue, target);
    const delivery = new DeliveryStore(root, issue.id).read();
    const ledgerRuns = runs.filter((entry) => entry.issueId === issue.id);
    for (const workspace of [run?.work, run?.chatCheckout, flow?.workspace, ...ledgerRuns])
      protectIssue(resources, label, workspace);
    protectFlowBranches(resources, label, flow);
    protectIssue(resources, label, { branch: delivery?.source, checkout: delivery?.checkout });
    for (const key of issueResourceKeys(root, issue)) resources.set(key, label);
    if (localRefs) {
      const assignments = actions.filter((action) => action.issues?.includes(issue.id));
      for (const record of [issue, run, flow, delivery, ...ledgerRuns, ...assignments])
        protectSavedBranches(resources, label, record);
      protectReportBranches(resources, label, issue.content, localRefs);
    }
  }
  return resources;
}

export function defaultComparison(root, branches) {
  if (isMissing(join(root, '.issues/issue-delivery-config.json'))) return null;
  const { remote, branch } = flowTarget(root);
  return [`refs/remotes/${remote}/${branch}`, heads + branch].find((ref) => branches.has(ref)) || null;
}
