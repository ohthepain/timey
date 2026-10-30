import { scopeBinding } from './factory-assignment-scope.mjs';
import { verificationStart } from './issue-verification-start.mjs';
import { historicalIntegration } from './factory-legacy-integration.mjs';
import { assembledContribution, verifiedIssueDelivery, validateAssembledStart } from './issue-delivery-records.mjs';
import { issueInputs } from './factory-inputs.mjs';
import { readProgress, completionBasis } from './factory-progress.mjs';
import { recordStatusSummary } from './factory-status.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const active = new Set(['reserved', 'setup', 'running', 'blocked', 'completed']);
const kinds = new Set(['investigate', 'prototype', 'implement', 'verify', 'review', 'integrate', 'retro']);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => {
  if (!condition) throw Error(message);
};

function validateRecoveredCode(action) {
  if (!['implement', 'integrate'].includes(action.kind)) return;
  assert(action.merge !== 'none', 'Code actions need an automatic or human-first integration policy.');
  if (action.status === 'completed') {
    assert(
      typeof action.worker_revision === 'string' && /^[0-9a-f]{40}$/.test(action.worker_revision),
      'Completed code recovery needs its exact worker commit; recover as blocked if unknown.'
    );
  }
}

function validateRecoveredReference(action) {
  if (action.status === 'running') {
    assert(
      typeof action.threadId === 'string' && typeof action.hostId === 'string',
      'Running recovery needs a ready chat.'
    );
  }
  if (action.status === 'setup')
    assert(typeof action.clientThreadId === 'string', 'Pending recovery needs its setup ID.');
}

function validateRecoveredWorker(action, known) {
  assert(action && typeof action.id === 'string', 'Recovery needs original action IDs.');
  assert(
    kinds.has(action.kind) && ['setup', 'running', 'blocked', 'completed'].includes(action.status),
    'Invalid recovered worker kind/status.'
  );
  validateRecoveredIssues(action.issues, known);
  assert(
    typeof action.recovery_evidence === 'string' && action.recovery_evidence.trim(),
    'Link actual chat discovery evidence.'
  );
  assert(['automatic', 'human-first', 'none'].includes(action.merge), 'Recover the actual merge policy.');
  validateRecoveredCode(action);
  validateRecoveredReference(action);
  return action.id;
}

function validateRecoveredIssues(issues, known) {
  assert(
    Array.isArray(issues) && issues.length > 0 && issues.every((id) => known.includes(id)),
    'Recovered worker must link known local issues.'
  );
}

function validateHumanCheck(check, identities, name) {
  assert(check && typeof check.id === 'string' && !identities.has(check.id), `Invalid/duplicate human check: ${name}`);
  identities.add(check.id);
  validateHumanCheckClassification(check, name);
  validateHumanCheckEvidence(check, name);
}

function validateHumanCheckClassification(check, name) {
  assert(
    ['evidence', 'judgment'].includes(check.kind) &&
      ['pending', 'passed', 'failed'].includes(check.status) &&
      ['dependent-work', 'closure'].includes(check.blocks),
    `Invalid human check classification: ${name}`
  );
}

const hasText = (value) => typeof value === 'string' && value.trim();

function validateHumanCheckEvidence(check, name) {
  assert(hasText(check.instructions), `Missing human instructions: ${name}`);
  if (check.status !== 'passed') return;
  assert(hasText(check.revision) && hasText(check.result), `Human pass needs revision and actual result: ${name}`);
}

function validateReport(content, name) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert(match, `Missing report YAML: ${name}`);
  const metadata = parse(match[1]);
  assert(metadata && typeof metadata.id === 'string' && typeof metadata.state === 'string', `Invalid report: ${name}`);
  if (metadata.human_checks !== undefined) {
    assert(Array.isArray(metadata.human_checks), `human_checks must be a list: ${name}`);
    const identities = new Set();
    metadata.human_checks.forEach((check) => validateHumanCheck(check, identities, name));
  }
  return metadata;
}

function validateProposalText(proposal) {
  for (const key of ['title', 'scope', 'reason', 'verification', 'worker_prompt']) {
    assert(typeof proposal[key] === 'string' && proposal[key].trim(), `Missing ${key}.`);
  }
}

function validateProposalIssues(issues, current) {
  assert(Array.isArray(issues) && issues.length > 0, 'Link at least one local issue.');
  assert(new Set(issues).size === issues.length, 'Duplicate issue IDs.');
  for (const id of issues) {
    assert(current.filter((report) => report.metadata.id === id).length === 1, `Missing or ambiguous issue: ${id}`);
  }
}

const inspectsResult = (action, prior) =>
  ['review', 'verify', 'integrate'].includes(action.kind) && prior.status === 'completed';

function validateDependencies(action, data, find) {
  for (const dependency of action.dependencies) {
    const prior = find(data, dependency);
    assert(
      ['integrated', 'reconciled'].includes(prior.status) ||
        inspectsResult(action, prior) ||
        (prior.status === 'assembled' && action.start),
      `Dependency not reconciled/integrated: ${dependency}`
    );
  }
}

function claimsIssue(entry, action) {
  if (inspectsResult(action, entry) && action.dependencies.includes(entry.id)) return false;
  return active.has(entry.status) && entry.issues.some((issue) => action.issues.includes(issue));
}

function validateDispatchableReport(report, action, closed) {
  assert(
    report.state !== closed && !report.grill_later && !report.kind?.startsWith('wayfinder-'),
    'Closed, deferred or planning-only report is not dispatchable.'
  );
  if (!['implement', 'integrate'].includes(action.kind)) return;
  assert(
    !report.human_checks?.some((check) => check.blocks === 'dependent-work' && check.status !== 'passed'),
    'A required human check blocks this work.'
  );
}

function validateChatReference(reference) {
  assert(
    (typeof reference.threadId === 'string' && typeof reference.hostId === 'string') ||
      typeof reference.clientThreadId === 'string',
    'Need ready threadId/hostId or pending clientThreadId.'
  );
  assert(!(reference.threadId && reference.clientThreadId), 'Pending setup ID is not a ready thread ID.');
}

function copyChatReference(action, reference) {
  for (const key of ['threadId', 'hostId', 'clientThreadId']) {
    if (reference[key]) action[key] = reference[key];
  }
}

function validateIntegration(action, update, root) {
  for (const issueId of action.issues) {
    const delivery = verifiedIssueDelivery(root, issueId);
    assert(
      delivery.contributions.some((c) => c.actionId === action.id),
      'The verified PR does not contain this action.'
    );
    assert(
      update.verified_revision === delivery.merge.revision,
      'Record the independently verified remote merge revision.'
    );
  }
}

function recordCodeCompletion(action, update) {
  if (!['implement', 'integrate'].includes(action.kind)) return;
  assert(
    typeof update.worker_revision === 'string' && /^[0-9a-f]{40}$/.test(update.worker_revision),
    'Completed code work needs its exact worker commit.'
  );
  action.worker_revision = update.worker_revision;
}

function validateResultStatus(action, update, git, root) {
  const validators = new Map([
    ['integrated', () => validateIntegration(action, update, root)],
    ['assembled', () => assembledContribution(root, action)],
    ['completed', () => recordCodeCompletion(action, update)],
    [
      'reconciled',
      () =>
        assert(!['implement', 'integrate'].includes(action.kind), 'Code actions require integrated revision evidence.'),
    ],
    [
      'running',
      () => assert(typeof action.threadId === 'string', 'Reconcile a ready worker ID before marking running.'),
    ],
  ]);
  validators.get(update.status)?.();
}

export function readFactoryRegistry(project) {
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' });
  const root = git('rev-parse', '--show-toplevel').trim();
  const ledger = join(root, '.issues/factory.json');
  if (!existsSync(ledger)) return null;
  const data = JSON.parse(readFileSync(ledger, 'utf8'));
  assert(data.version === 1 && Array.isArray(data.actions), 'Unsupported or damaged registry.');
  return data;
}

export function factory(project) {
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' });
  const root = git('rev-parse', '--show-toplevel').trim();
  const queue = join(root, '.issues');
  const ledger = join(queue, 'factory.json');
  const lock = join(queue, 'factory.lock');
  assert(existsSync(join(queue, 'triage-labels.md')), 'Initialize the local queue first.');
  const readLedger = () => {
    assert(existsSync(ledger), 'Registry missing: reconcile existing worker chats, then explicitly initialize it.');
    const data = JSON.parse(readFileSync(ledger, 'utf8'));
    assert(data.version === 1 && Array.isArray(data.actions), 'Unsupported or damaged registry.');
    return data;
  };
  const reports = () =>
    readdirSync(queue)
      .filter((name) => /^\d.*\.md$/.test(name))
      .sort()
      .map((name) => {
        const content = readFileSync(join(queue, name), 'utf8');
        return {
          path: join(queue, name),
          metadata: validateReport(content, name),
          content,
          report_sha256: digest(content),
        };
      });
  const recommendationFresh = (action, data) =>
    action.scope_basis
      ? action.scope_basis === scopeBasis(action, data)
      : JSON.stringify(action.basis) === JSON.stringify(snapshot());
  const scopeBasis = (action, data) =>
    issueInputs(
      root,
      snapshot(),
      reports().map((r) => ({ id: r.metadata.id, content: r.content })),
      data.actions.filter(
        (a) => a.id !== action.id && (a.status !== 'recommended' || action.dependencies.includes(a.id))
      ),
      action.issues,
      action.dependencies
    );
  const snapshot = () => ({
    head: git('rev-parse', 'HEAD').trim(),
    // Include ignored queue configuration but never store its contents or Git diffs in the registry.
    queue: digest(
      readdirSync(queue)
        .filter((name) => name.endsWith('.md') || name === 'preferences.json')
        .sort()
        .map((name) => name + '\0' + readFileSync(join(queue, name), 'utf8'))
        .join('\0')
    ),
    worktree: digest(
      git('diff', 'HEAD', '--binary') +
        git('ls-files', '--others', '--exclude-standard', '-z')
          .split('\0')
          .filter(Boolean)
          .sort()
          .map(
            (name) =>
              name +
              '\0' +
              (lstatSync(join(root, name)).isSymbolicLink()
                ? readlinkSync(join(root, name))
                : digest(readFileSync(join(root, name))))
          )
          .join('\0')
    ),
  });
  const mutate = (fn) => {
    try {
      mkdirSync(lock);
    } catch (error) {
      if (error.code === 'EEXIST')
        throw Error('Coordinator lock exists. Reconcile its owner; do not automatically remove it.');
      throw error;
    }
    try {
      const data = readLedger();
      const result = fn(data);
      const tmp = `${ledger}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      renameSync(tmp, ledger);
      return result;
    } finally {
      rmSync(lock, { recursive: true });
    }
  };
  const find = (data, id) => {
    const action = data.actions.find((entry) => entry.id === id);
    assert(action, `Unknown action: ${id}`);
    return action;
  };
  return {
    init() {
      // Exclusive create: init cannot erase active dispatch records.
      writeFileSync(ledger, JSON.stringify({ version: 1, actions: [] }, null, 2) + '\n', { flag: 'wx' });
      return { initialized: ledger, instruction: 'Evaluation and action launches remain manual.' };
    },
    recover(records) {
      assert(!existsSync(ledger), 'Registry exists; reconcile it rather than replacing it.');
      assert(
        Array.isArray(records) && records.length > 0,
        'Recover known workers; use init only after confirming none exist.'
      );
      const known = reports().map((report) => report.metadata.id);
      const identities = records.map((action) => validateRecoveredWorker(action, known));
      assert(new Set(identities).size === identities.length, 'Recovery needs unique original action IDs.');
      try {
        mkdirSync(lock);
      } catch {
        throw Error('Coordinator lock exists; reconcile before recovery.');
      }
      try {
        writeFileSync(ledger, JSON.stringify({ version: 1, actions: records }, null, 2) + '\n', { flag: 'wx' });
      } finally {
        rmSync(lock, { recursive: true });
      }
      return {
        recovered: records.map((action) => action.id),
        instruction: 'Known claims restored; no chats were launched.',
      };
    },
    inspect() {
      const inspection = {
        project: root,
        snapshot: snapshot(),
        reports: reports(),
        progress: readProgress(root),
        registry: existsSync(ledger) ? readLedger() : null,
      };
      return { ...inspection, completion_basis: completionBasis(inspection.snapshot, inspection.registry) };
    },
    recommend(proposals) {
      assert(Array.isArray(proposals) && proposals.length > 0, 'Supply a ranked, nonempty action array.');
      return mutate((data) => {
        const current = reports();
        const basis = snapshot();
        const batch = proposals.map((proposal) => {
          assert(kinds.has(proposal.kind), 'Unknown action kind.');
          validateProposalText(proposal);
          assert(['automatic', 'human-first', 'none'].includes(proposal.merge), 'Choose an explicit merge policy.');
          assert(
            !['implement', 'integrate'].includes(proposal.kind) || proposal.merge !== 'none',
            'Code actions need an automatic or human-first integration policy.'
          );
          validateProposalIssues(proposal.issues, current);
          assert(
            Array.isArray(proposal.dependencies) && proposal.dependencies.every((id) => typeof id === 'string'),
            'Declare dependency action IDs (or []).'
          );
          return {
            ...proposal,
            id: randomUUID(),
            basis,
            scope_basis: scopeBasis(proposal, data),
            status: 'recommended',
            created: new Date().toISOString(),
          };
        });
        data.actions.push(...batch);
        return batch;
      });
    },
    refreshRecommendation(id, expected, authorization) {
      return mutate((data) => {
        const action = find(data, id);
        assert(digest(JSON.stringify(action)) === expected && action.status === 'recommended' &&
          !action.threadId && !action.clientThreadId, 'The recommendation changed or already started.');
        assert(action.issues.length === 1, 'Refresh belongs to one approved issue.');
        const record = readProgress(root)[action.issues[0]];
        const binding = scopeBinding({ root }, record, action);
        assert(record.approvedAssignments?.includes(binding), 'Review this assignment against its approved scope before refresh.');
        assert(authorization.kind === 'approved-plan' && authorization.plan_sha256 === record.approval.sha256 &&
          authorization.issue_id === record.issueId, 'Refresh requires the original issue approval.');
        assert(!data.actions.some((entry) => claimsIssue(entry, action)), 'Issue already claimed by another action.');
        assert(!git('status', '--porcelain', '--untracked-files=all').trim(), 'Preserve source before refreshing.');
        validateDependencies(action, data, find);
        action.recommendationHistory = [...(action.recommendationHistory || []),
          { basis: action.basis, scope_basis: action.scope_basis, at: new Date().toISOString() }];
        action.basis = snapshot();
        action.scope_basis = scopeBasis(action, data);
        action.updated = new Date().toISOString();
        recordOperation(action, 'refresh-recommendation', authorization);
        return action;
      });
    },
    bindVerification(id, expectedRevision, authorization = { kind: 'coordinator', operation: 'bind-verification' }) {
      return mutate((data) => {
        const action = find(data, id);
        assert(action.status === 'recommended', 'Only a pending verification task can receive a handoff.');
        assert(recommendationFresh(action, data), 'The verification task changed. Review its current inputs.');
        assert(!data.actions.some((entry) => claimsIssue(entry, action)), 'This issue already has active work.');
        const start = verificationStart(root, action, data, expectedRevision);
        if (JSON.stringify(action.start) === JSON.stringify(start)) return action;
        action.start = start;
        action.scope_basis = scopeBasis(action, data);
        action.updated = new Date().toISOString();
        recordOperation(action, 'bind-verification', authorization);
        return action;
      });
    },
    reserve(id, authorization = { kind: 'coordinator', operation: 'launch' }) {
      return mutate((data) => {
        const action = find(data, id);
        assert(action.status === 'recommended', `Action is already ${action.status}; never dispatch it twice.`);
        assert(!data.actions.some((entry) => claimsIssue(entry, action)), 'Issue already claimed by another action.');
        assert(recommendationFresh(action, data), 'Stale recommendation: manually reevaluate.');
        assert(
          !git('status', '--porcelain', '--untracked-files=all').trim(),
          'Commit or isolate source changes before starting a worktree from HEAD.'
        );
        validateDependencies(action, data, find);
        if (
          action.start?.purpose === 'approved-plan-repair' ||
          action.dependencies.some((id) => find(data, id).status === 'assembled')
        )
          validateAssembledStart(root, action, data);
        const conflict = data.actions.find((entry) => claimsIssue(entry, action));
        assert(!conflict, `Issue already claimed by action ${conflict?.id}.`);
        const current = reports();
        const closed = readFileSync(join(queue, 'triage-labels.md'), 'utf8')
          .split('\n')
          .map((line) => line.split('|').map((cell) => cell.replaceAll('`', '').trim()))
          .find((cells) => cells[1] === 'closed')?.[2];
        assert(closed, 'Lifecycle has no closed-role mapping.');
        for (const id of action.issues) {
          const report = current.find((entry) => entry.metadata.id === id).metadata;
          validateDispatchableReport(report, action, closed);
        }
        action.status = 'reserved';
        action.authorization = authorization;
        recordOperation(action, 'reserve', authorization);
        action.reserved = new Date().toISOString();
        return action;
      });
    },
    attach(id, reference) {
      return mutate((data) => {
        const action = find(data, id);
        assert(
          ['reserved', 'setup', 'blocked'].includes(action.status),
          'Only an unbound reservation/setup can attach a chat.'
        );
        assert(!action.threadId, 'Chat already bound.');
        validateChatReference(reference);
        copyChatReference(action, reference);
        if (reference.threadId) delete action.clientThreadId;
        action.status = reference.threadId ? 'running' : 'setup';
        return action;
      });
    },
    reconcileHistoricalIntegration(id, runId, checked) {
      return mutate((data) => {
        const action = find(data, id);
        assert(action.status === 'completed', 'Historical reconciliation requires the saved completed candidate.');
        const receipt = historicalIntegration(root, action, runId, checked);
        action.status = 'integrated';
        action.verified_revision = checked.head;
        action.legacy_integration = receipt;
        action.evidence =
          'Reconciled an already merged historical integration without another merge. ' + JSON.stringify(receipt);
        action.updated = new Date().toISOString();
        recordOperation(action, 'reconcile-historical-integration', receipt.authorization);
        return action;
      });
    },
    record(id, update) {
      return mutate((data) => {
        const action = find(data, id);
        if (update.expected_recommendation) {
          assert(
            update.status === 'cancelled' &&
              action.status === 'recommended' &&
              action.issues.length === 1 &&
              !action.threadId &&
              !action.clientThreadId &&
              digest(JSON.stringify(action)) === update.expected_recommendation &&
              !recommendationFresh(action, data),
            'The unused stale recommendation changed. Refresh before retiring it.'
          );
        }
        const transitions = {
          reserved: ['blocked', 'failed', 'cancelled'],
          setup: ['blocked', 'failed', 'cancelled'],
          running: ['completed', 'blocked', 'failed'],
          blocked: ['running', 'completed', 'failed', 'cancelled'],
          completed: ['assembled', 'reconciled', 'blocked'],
          assembled: ['integrated', 'blocked'],
          failed: ['cancelled'],
          recommended: ['cancelled'],
        };
        assert(
          transitions[action.status]?.includes(update.status),
          `Invalid action transition: ${action.status} -> ${update.status}`
        );
        assert(
          typeof update.evidence === 'string' && update.evidence.trim(),
          'Record an evidence pointer or specific failure reason.'
        );
        validateResultStatus(action, update, git, root);
        recordStatusSummary(action, update);
        recordOperation(
          action,
          'record-' + update.status,
          update.authorization || { kind: 'coordinator', operation: 'record' }
        );
        Object.assign(action, { status: update.status, evidence: update.evidence, updated: new Date().toISOString() });
        if (update.status === 'assembled') action.assembly = update.assembly;
        if (update.status === 'integrated') action.verified_revision = update.verified_revision;
        return action;
      });
    },
  };
}

function recordOperation(action, operation, authorization) {
  const operations = action.operations || [];
  assert(Array.isArray(operations), 'The action history is invalid. Preserve it for reconciliation.');
  operations.push({ operation, authorization, at: new Date().toISOString() });
  action.operations = operations;
}
