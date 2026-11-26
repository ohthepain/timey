import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { redactValue } from './activity.mjs';
import { digest, git, requireThat, writeJson } from './common.mjs';
import { deliveryTarget } from './flow-block-data.mjs';
import { groupChildren } from './issue-group.mjs';
import { evidencePath } from './stores/evidence.mjs';
import { retainFlowEvidence } from './stores/flow-evidence.mjs';

const checkText = z.string().trim().min(1).max(2000);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const identity = z.object({ head: oid, tree: oid }).strict();
const scopeSchema = z
  .object({
    repository: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .max(200),
    branch: z.string().min(1).max(255),
    target: z.string().min(1).max(255),
  })
  .strict();
const authorizationSchema = z
  .object({
    childId: z.string(),
    check: checkText,
    candidate: identity,
    scope: scopeSchema,
    confirmed: z.literal(true),
  })
  .strict();
const attachmentSchema = z
  .object({
    authorizationId: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.literal('live-github'),
    status: z.enum(['passed', 'failed']),
    pr: scopeSchema.extend({ number: z.number().int().positive(), head: oid }),
    observations: z
      .array(z.object({ at: z.iso.datetime(), observed: checkText }).strict())
      .min(1)
      .max(20),
    logs: z
      .array(
        z
          .object({
            name: z.string().regex(/^[\w.-]{1,100}$/),
            text: z
              .string()
              .min(1)
              .max(48000)
              .refine((value) => Boolean(value.trim()), 'Enter the actual command output.'),
          })
          .strict()
      )
      .min(1)
      .max(10),
    confirmed: z.literal(true),
  })
  .strict();
const declarationsSchema = z.array(z.object({ id: z.string(), check: checkText }).strict());

const requirementHash = (child) => digest(JSON.stringify([child.id, child.wording, child.requestedProof]));
const matchesCandidate = (a, b) => a.head === b.head && a.tree === b.tree;

export function reportedLiveProofRequirements(ctx, manifest, ids = ctx.attempt.groupIssueIds) {
  const parsed = declarationsSchema.safeParse(manifest?.liveProofRequirements ?? []);
  requireThat(parsed.success, 'Report each requested live check with its attached child ID and check description.');
  const children = groupChildren(ctx.issue).filter(({ id }) => !ids || ids.includes(id));
  return parsed.data.map(({ id, check }) => {
    const child = children.find((entry) => entry.id === id);
    requireThat(child, 'Report live proof only for the attached sub-issues in this assignment.');
    return { id, check, requirementHash: requirementHash(child) };
  });
}

function reportedChecks(flow) {
  return [...flow.blocks, ...(flow.retiredBlocks ?? [])]
    .flatMap(({ attempts }) => attempts)
    .flatMap(({ result }) => result?.liveProofRequirements ?? []);
}

function requiredCheck(child, reports, authorizations) {
  const hash = requirementHash(child);
  return (
    authorizations.findLast((record) => record.childId === child.id && record.requirementHash === hash)?.check ??
    reports.find((report) => report.id === child.id && report.requirementHash === hash)?.check
  );
}

function attachmentIntact(root, evidence) {
  return evidence.every(({ path, sha256 }) => {
    try {
      return digest(readFileSync(evidencePath(root, path, sha256))) === sha256;
    } catch {
      return false;
    }
  });
}

function passingAttachment(root, { status, evidence }) {
  return status === 'passed' && attachmentIntact(root, evidence);
}

function missingAuthorization(history) {
  return history.length ? 'the saved Requested proof or check has changed' : 'no bounded authorization is recorded';
}

function retainedGap(saved) {
  return saved.some(({ status }) => status === 'passed')
    ? 'retained observations or logs are missing or changed'
    : 'the attached live check failed';
}

function liveGap(current, saved, last, history) {
  if (saved.length) return retainedGap(saved);
  if (current.length) return 'no live observations are attached';
  return last
    ? `the authorized head ${last.candidate.head} and tree ${last.candidate.tree} differ from this candidate`
    : missingAuthorization(history);
}

function liveStatus(child, candidate, authorizations, attachments, reports, root) {
  const check = requiredCheck(child, reports, authorizations);
  const history = authorizations.filter(({ childId }) => childId === child.id);
  if (!check && !history.length) return null;
  const hash = requirementHash(child);
  const applicable = history.filter((record) => record.requirementHash === hash);
  const current = applicable.filter((record) => matchesCandidate(record.candidate, candidate));
  const saved = attachments.filter((item) => current.some(({ id }) => item.authorizationId === id));
  const usable = saved.findLast((record) => passingAttachment(root, record));
  const description = check ?? history.at(-1).check;
  return { child, check: description, usable, reason: liveGap(current, saved, applicable.at(-1), history) };
}

export function groupLiveProof(issue, flow, candidate, root) {
  const { authorizations = [], attachments = [] } = flow.liveProof ?? {};
  const reports = reportedChecks(flow);
  const statuses = groupChildren(issue)
    .map((child) => liveStatus(child, candidate, authorizations, attachments, reports, root))
    .filter(Boolean);
  const gaps = statuses.filter(({ usable }) => !usable);
  if (gaps.length) {
    const instructions = gaps.map(
      ({ child, check, reason }) => `${child.title || child.id} (${child.id}), ${check}: ${reason}.`
    );
    throw Object.assign(
      Error(
        `Live proof is required for head ${candidate.head} and tree ${candidate.tree}. ${instructions.join(' ')} ` +
          'Use Factory live-proof to authorize or reconcile the disposable GitHub check, attach the observed PR and logs, then retry Merge.'
      ),
      { code: 'GROUP_LIVE_PROOF_REQUIRED' }
    );
  }
  return {
    rows: statuses.map(({ child, check, usable }) => ({
      id: child.id,
      status: 'passed',
      observation: `${check} on ${usable.pr.url}\n${usable.observations.map(({ at, observed }) => `${at} ${observed}`).join('\n')}`,
      source: 'live-github',
      pr: usable.pr,
      file: usable.evidence[0],
    })),
    evidence: statuses.flatMap(({ usable }) => usable.evidence),
  };
}

function parseRequest(schema, input) {
  const parsed = schema.safeParse(input);
  requireThat(
    parsed.success,
    parsed.error?.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join(' ')
  );
  return parsed.data;
}

function requireDisposableScope(root, flow, workspace, scope) {
  const { repository } = JSON.parse(readFileSync(join(root, '.issues/issue-delivery-config.json'), 'utf8'));
  [scope.branch, scope.target].forEach((ref) => requireBranch(workspace, ref));
  requireThat(scope.branch !== scope.target, 'Choose distinct disposable source and target branches.');
  if (scope.repository.toLowerCase() !== repository.toLowerCase()) return;
  const reserved = [workspace.branch, deliveryTarget(flow).branch];
  requireThat(
    ![scope.branch, scope.target].some((ref) => reserved.includes(ref)),
    'Use disposable branches outside the production PR source and target.'
  );
}

function requireBranch(workspace, ref) {
  requireThat(
    !ref.startsWith('-') && git(workspace.checkout, 'check-ref-format', '--branch', ref) === ref,
    'Choose explicit disposable branches.'
  );
}

function authorize(root, issue, flow, workspace, candidate, input, authorizations) {
  const { childId, check, candidate: expected, scope } = parseRequest(authorizationSchema, input);
  const child = groupChildren(issue).find(({ id }) => id === childId);
  requireThat(child, 'Select an attached sub-issue.');
  requireThat(
    matchesCandidate(candidate, expected),
    'The candidate changed. Review the current head and tree before authorizing live proof.'
  );
  const savedCheck = requiredCheck(child, reportedChecks(flow), authorizations);
  requireThat(!savedCheck || check === savedCheck, `Authorize the saved live check exactly: ${savedCheck}`);
  requireDisposableScope(root, flow, workspace, scope);
  return recordAuthorization(authorizations, {
    childId,
    check,
    requirementHash: requirementHash(child),
    candidate,
    scope,
  });
}

function recordAuthorization(authorizations, details) {
  const id = digest(JSON.stringify(details));
  const existing = authorizations.find((record) => record.id === id);
  if (existing) return { record: existing, retained: true };
  const record = { id, ...details, authorizedAt: new Date().toISOString() };
  authorizations.push(record);
  return { record };
}

function requireAuthorizedCandidate(issue, candidate, authorization) {
  const child = groupChildren(issue).find(({ id }) => id === authorization?.childId);
  requireThat(
    child && requirementHash(child) === authorization.requirementHash,
    'Authorize the current requested proof before attaching the live result.'
  );
  requireThat(
    matchesCandidate(authorization.candidate, candidate),
    'The authorized candidate changed. Authorize and rerun the live check on the current head and tree.'
  );
}

function requireAuthorizedPR(authorization, pr, attachments) {
  const { repository, branch, target } = authorization.scope;
  const actual = [pr.head, pr.repository, pr.branch, pr.target];
  const expected = [authorization.candidate.head, repository, branch, target];
  requireThat(
    actual.every((part, index) => part === expected[index]),
    'The test PR must match the authorized repository, source, target and head.'
  );
  const previous = attachments.find((record) => record.authorizationId === authorization.id);
  requireThat(
    !previous || previous.pr.number === pr.number,
    'This authorization is already bound to another test PR. Authorize a separate disposable source branch.'
  );
}

function attach(root, issue, candidate, input, { authorizations, attachments }) {
  const { authorizationId, source, status, pr, observations, logs } = parseRequest(attachmentSchema, input);
  const authorization = authorizations.find(({ id }) => id === authorizationId);
  requireAuthorizedCandidate(issue, candidate, authorization);
  requireAuthorizedPR(authorization, pr, attachments);
  const details = redactValue({
    authorizationId,
    source,
    status,
    pr: { ...pr, url: `https://github.com/${pr.repository}/pull/${pr.number}` },
    observations,
  });
  const retainedLogs = logs.map(({ name, text }) => ({ name, text: redactValue(text) }));
  const id = digest(JSON.stringify([details, retainedLogs]));
  const existing = attachments.find((record) => record.id === id);
  if (existing && attachmentIntact(root, existing.evidence)) return { record: existing, retained: true };
  return recordAttachment(root, attachments, existing, id, details, authorization, retainedLogs);
}

function recordAttachment(root, attachments, existing, id, details, authorization, retainedLogs) {
  const evidence = retainAttachment(root, id, details, authorization, retainedLogs);
  const record = { id, ...details, evidence };
  if (existing) Object.assign(existing, record);
  else attachments.push(record);
  return { record };
}

function retainAttachment(root, id, details, authorization, retainedLogs) {
  const directory = join(root, '.issues/factory-ui/flow-evidence', 'live-proof-' + id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const references = retainedLogs.map(({ name, text }, index) => {
    const path = join(directory, `${index + 1}-${name}.log`);
    writeFileSync(path, text, { mode: 0o600 });
    return { path, sha256: digest(text), label: name };
  });
  const path = join(directory, 'live-proof.json');
  writeJson(path, { ...details, authorization, logs: references });
  return [{ path, sha256: digest(readFileSync(path)), label: 'Live sub-issue proof' }, ...references];
}

export function liveProofSummary(issue, flow, workspace) {
  const reports = reportedChecks(flow);
  const authorizations = flow.liveProof?.authorizations ?? [];
  const requirements = groupChildren(issue).flatMap((child) => {
    const check = requiredCheck(child, reports, authorizations);
    return check ? [{ id: child.id, check }] : [];
  });
  return { candidate: workspace ? candidateIdentity(workspace) : null, requirements, ...flow.liveProof };
}

function candidateIdentity(workspace) {
  return {
    head: git(workspace.checkout, 'rev-parse', 'HEAD'),
    tree: git(workspace.checkout, 'rev-parse', 'HEAD^{tree}'),
  };
}

function currentCandidate(workspace) {
  requireThat(
    workspace?.checkout && !git(workspace.checkout, 'status', '--porcelain', '--untracked-files=all'),
    'Choose the saved clean, committed issue checkout.'
  );
  requireThat(
    git(workspace.checkout, 'branch', '--show-current') === workspace.branch,
    'The saved issue branch changed. Reconcile its checkout first.'
  );
  return candidateIdentity(workspace);
}

async function shareLiveProof(stores, issueId, record) {
  if (!stores || !record.evidence) return;
  const gaps = await retainFlowEvidence(stores, issueId, { evidence: record.evidence }, record.id);
  requireThat(!gaps.length, 'The shared Artifact store could not retain the live proof. Retry the same attachment.');
}

export async function saveLiveProof(service, issue, flow, workspace, action, input, store) {
  const candidate = currentCandidate(workspace);
  const proof = (flow.liveProof ??= { authorizations: [], attachments: [] });
  const { record, retained } =
    action === 'live-proof-authorize'
      ? authorize(service.root, issue, flow, workspace, candidate, input, proof.authorizations)
      : attach(service.root, issue, candidate, input, proof);
  if (retained) return { issueId: issue.id, revision: flow.revision, record };
  await shareLiveProof(service.projectStores, issue.id, record);
  const saved = await store.save(flow, flow.revision);
  return { issueId: issue.id, revision: saved.revision, record };
}
