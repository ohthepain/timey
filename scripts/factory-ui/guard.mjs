import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnvironment, digest, requireThat } from './common.mjs';

// Project policy, never supplied or weakened by the browser.
const policy = {
  id: 'timey-factory-ui',
  version: 1,
  human_checks: {
    'dependent-work': ['implement', 'verify', 'commit', 'merge', 'record-integration', 'accept', 'close'],
    closure: ['accept', 'close'],
  },
  check_scope_default: '*',
  require_explicit_acceptance: true,
  manual_checks_before_commit: false,
  acceptance_role: 'ready-to-close',
  closed_role: 'closed',
};
export function inspectHumanInput(root, action, operation, head, transition = {}, adapterFacts = []) {
  const helper = join(root, '.agents/skills/issues/scripts/human-input.mjs');
  const manifest = JSON.parse(
    readFileSync(join(root, '.agents/skills/issues/scripts/human-input-version.json'), 'utf8')
  );
  requireThat(manifest.protocol === 'local-issues-human-input/1', 'Install a compatible human-input helper first.');
  requireThat(
    manifest.bundle_sha256 === `sha256:${digest(readFileSync(helper))}`,
    'Human-input helper integrity check failed.'
  );
  const temp = mkdtempSync(join(tmpdir(), 'timey-ui-guard-'));
  try {
    const capabilities = JSON.parse(
      execFileSync(process.execPath, [helper, 'capabilities'], { encoding: 'utf8', env: cleanEnvironment() })
    );
    requireThat(
      capabilities.capabilities.includes('read') && capabilities.capabilities.includes('guards'),
      'Human-input guards are unavailable.'
    );
    const context = {
      protocol: manifest.protocol,
      operation,
      ...transition,
      issue_ids: action.issues,
      scope_ids: ['*'],
      policy,
      adapter_facts: adapterFacts,
      semantic_reviews: [],
    };
    if (['merge', 'record-integration'].includes(operation))
      context.candidate = {
        repository_root: root,
        action_id: action.id,
        revision: action.worker_revision,
        target_revision: head,
      };
    const path = join(temp, 'context.json');
    writeFileSync(path, JSON.stringify(context));
    let output;
    try {
      output = execFileSync(process.execPath, [helper, 'read', '--project', root, '--context', path], {
        encoding: 'utf8',
        env: cleanEnvironment(),
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      // View diagnostics describe unavailable input; they do not waive dispatch checks.
      if (operation !== 'view' || error.status !== 4 || !error.stdout) throw error;
      output = error.stdout;
    }
    return { helper, context, result: JSON.parse(output) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function validateHumanResult(result, action, operation) {
  requireThat(
    !result.diagnostics?.length && result.issues.length === action.issues.length,
    'Human-input review returned diagnostics. Reconcile in the coordinator chat.'
  );
  for (const issue of result.issues) validateIssueGuard(issue, operation);
}
function validateIssueGuard(issue, operation) {
  requireThat(
    issue.structurally_eligible && !issue.diagnostics?.length,
    `Human input blocks ${operation} for ${issue.id}.`
  );
}

export function humanGuard(root, action, operation, head, transition = {}) {
  const { result } = inspectHumanInput(root, action, operation, head, transition);
  validateHumanResult(result, action, operation);
  return result.issues.map((issue) => ({
    id: issue.id,
    digest: issue.report_digest,
    requests: issue.requests,
    semanticReviewRequired: issue.semantic_review_required,
  }));
}
