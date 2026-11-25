import { readFileSync, readlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnvironment, digest, git, requireThat } from './common.mjs';
import { execFileSync } from 'node:child_process';
import { groupChildren } from './issue-group.mjs';
import { requestData } from './flow-block-data.mjs';
import { isWorkBlock } from './flow-store.mjs';

export const groupScope = (issue) => groupChildren(issue).map(({ id }) => id);

export function childRequestSection({ id, issueNumber, title, wording, requestedProof }) {
  return `## ${issueNumber ? `#${issueNumber} ` : ''}${title}\n\nIssue ID: ${id}\n\n${wording}\n\nRequested proof:\n${requestedProof}`;
}

function selectWorkScope(attached, ids) {
  requireThat(Array.isArray(ids) && ids.length, 'Choose at least one attached sub-issue for Work.');
  const selected = attached.filter((id) => ids.includes(id));
  requireThat(selected.length === ids.length, 'Choose distinct attached sub-issues for Work.');
  return selected;
}

export function workScopeIds(issue, block, requested) {
  const attached = groupScope(issue);
  if (!isWorkBlock(block)) {
    requireThat(requested === undefined, 'Child scope is available for Work.');
    return;
  }
  if (!attached.length) {
    requireThat(requested === undefined, 'Choose an attached sub-issue for Work.');
    return;
  }
  return selectWorkScope(attached, requested ?? attached);
}

function omitChildWording(text, child) {
  const section = `\n\nIssue ID: ${child.id}\n\n${child.wording}\n\nRequested proof:\n${child.requestedProof}`;
  const start = text.indexOf(section);
  requireThat(
    start >= 0 && start === text.lastIndexOf(section),
    'The combined Request no longer identifies each child scope. Review the grouping.'
  );
  const heading = text.lastIndexOf('\n## ', start);
  const title = text.slice(heading + 4, start).replace(/^#\d+ /, '');
  requireThat(
    heading >= 0 && title === child.title,
    'The combined Request no longer identifies each child heading. Review the grouping.'
  );
  return text.slice(0, heading) + text.slice(start + section.length);
}

export function scopedRequest(issue, flow, ids) {
  const selected = new Set(ids ?? groupScope(issue));
  const children = groupChildren(issue).filter(({ id }) => selected.has(id));
  requireThat(
    children.every(({ wording }) => typeof wording === 'string'),
    'The original child scope is unavailable. Review this group.'
  );
  const excluded = issue.issue_group.children.filter(({ id, appended }) => !appended && !selected.has(id));
  const original = excluded.reduce(omitChildWording, requestData(flow).wording).trim();
  const scope = [original, ...children.filter(({ appended }) => appended).map(childRequestSection)].join('\n\n');
  const requestedProof = children
    .map(({ id, title, requestedProof }) => `${title} (${id})\n${requestedProof}`)
    .join('\n\n');
  return {
    scope,
    fields: {
      type: requestData(flow).fields?.type ?? flow.routeType,
      goal: scope,
      requestedProof,
      knownFacts: children
        .map(({ fields }) => fields?.knownFacts)
        .filter(Boolean)
        .join('\n\n'),
      constraints: children
        .map(({ fields }) => fields?.constraints)
        .filter(Boolean)
        .join('\n\n'),
    },
  };
}

export function activeGroupRequest(issue, flow, ids) {
  const request = requestData(flow);
  if (
    !issue?.issue_group?.children.some(({ detachedAt, appended }) => detachedAt || appended) &&
    (!ids || ids.length === groupScope(issue).length)
  )
    return request;
  const { scope, fields } = scopedRequest(issue, flow, ids);
  return { wording: scope, fields };
}

function rawGit(checkout, ...args) {
  return execFileSync('git', ['-C', checkout, ...args], {
    env: { ...cleanEnvironment(), GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 5000,
  });
}

function untracked(checkout) {
  return rawGit(checkout, 'ls-files', '--others', '--exclude-standard', '-z')
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((name) => {
      const path = join(checkout, name);
      const stats = lstatSync(path);
      requireThat(stats.isFile() || stats.isSymbolicLink(), 'The checkout contains an unclassified change.');
      return [name, stats.mode, digest(stats.isSymbolicLink() ? readlinkSync(path) : readFileSync(path))];
    });
}

export function sourceObservation(workspace) {
  const { checkout, base, branch } = workspace;
  requireThat(git(checkout, 'rev-parse', '--show-toplevel') === checkout, 'The master checkout needs reconciliation.');
  requireThat(git(checkout, 'branch', '--show-current') === branch, 'The master checkout branch changed.');
  const head = git(checkout, 'rev-parse', 'HEAD');
  const history = git(checkout, 'reflog', '--format=%H', 'HEAD').split('\n').filter(Boolean);
  const index = rawGit(checkout, 'diff', '--no-ext-diff', '--no-textconv', '--cached', '--binary', 'HEAD', '--');
  const tree = rawGit(checkout, 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--');
  const files = untracked(checkout);
  return {
    checkout,
    head,
    identity: digest(JSON.stringify([head, history, digest(index), digest(tree), files])),
    pristine: [head, ...history].every((entry) => entry === base) && ![index, tree, files].some(({ length }) => length),
  };
}

const nonWriters = new Set([
  'request',
  'refine',
  'sharpen',
  'understand',
  'retro',
  'advice',
  'playbook',
  'sol',
  'close',
  'publish',
  'delete-worktree',
]);
function sourceAttempts(flow) {
  return [...flow.blocks, ...(flow.retiredBlocks ?? [])]
    .filter(
      ({ kind, operation }) =>
        !nonWriters.has(kind) && !['detach-blocked-child', 'reattach-child', 'attach-child'].includes(operation)
    )
    .flatMap(({ attempts }) => attempts)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function followsObservation(before, after) {
  return before ? after.identity === before.identity : after.pristine;
}

function requireSourceChain(target, previous, attempt) {
  const { workSource, workIssueIds } = attempt;
  requireThat(
    workIssueIds && !workIssueIds.includes(target),
    'Work may contain changes for this child or changes with unknown attribution. Review the group.'
  );
  requireThat(workSource?.before, 'The master Work log has unknown attribution.');
  requireThat(
    followsObservation(previous, workSource.before),
    'The master checkout contains changes outside the attributed Work log.'
  );
  return workSource;
}

function requireHistoricalSources(attempts, target) {
  return attempts.reduce((previous, attempt) => {
    const { after } = requireSourceChain(target, previous, attempt);
    requireThat(after, 'The master Work log has an unconfirmed checkout state.');
    return after;
  }, undefined);
}

function requireCheckoutHistory(workspace, previous) {
  if (!workspace) {
    requireThat(!previous, 'The master checkout is unavailable for attribution.');
    return;
  }
  requireThat(
    followsObservation(previous, sourceObservation(workspace)),
    'The master checkout contains changes outside the attributed Work log.'
  );
}

function requireActiveSource(attempt, workspace, target, previous) {
  if (!attempt?.workSource) return requireCheckoutHistory(workspace, previous);
  const { before } = requireSourceChain(target, previous, attempt);
  requireThat(workspace?.checkout === before.checkout, 'The master checkout changed during Work.');
  sourceObservation(workspace);
}

export function requireDetachableSource(flow, workspace, target, active) {
  const attempts = sourceAttempts(flow);
  const attempt = attempts.find(({ id }) => id === active?.attemptId);
  const previous = requireHistoricalSources(
    attempts.filter((entry) => entry !== attempt),
    target
  );
  requireActiveSource(attempt, workspace, target, previous);
}
