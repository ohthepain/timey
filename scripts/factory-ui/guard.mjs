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
      runHumanInputHelper(helper, 'capabilities', ['capabilities'], {
        encoding: 'utf8',
        env: cleanEnvironment(),
        stdio: ['ignore', 'pipe', 'ignore'],
      })
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
    const output = readHumanInput(helper, root, path, operation);
    return { helper, context, result: JSON.parse(output) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function readHumanInput(helper, root, path, operation) {
  const args = ['read', '--project', root, '--context', path];
  const options = {
    encoding: 'utf8',
    env: cleanEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  try {
    return runHumanInputHelper(helper, 'read', args, options);
  } catch (error) {
    return retainViewDiagnosticsOrThrow(error, operation);
  }
}

function retainViewDiagnosticsOrThrow(error, operation) {
  // View diagnostics describe unavailable input; they do not waive dispatch checks.
  if (operation === 'view' && error.status === 4 && error.helperOutput) return error.helperOutput;
  throw error;
}

function runHumanInputHelper(helper, operation, args, options) {
  try {
    return execFileSync(process.execPath, [helper, ...args], options);
  } catch (error) {
    const helperOutput = outputText(error.stdout);
    const reason = subprocessFailureReason(error);
    const explanation = structuredExplanation(helperOutput);
    const failure = new Error(
      `Human-input helper ${operation} failed (${reason}). ${explanation || 'No structured helper diagnostics were returned.'}`
    );
    failure.status = error.status;
    failure.signal = error.signal;
    failure.helperOutput = helperOutput;
    throw failure;
  }
}

function subprocessFailureReason(error) {
  if (Number.isInteger(error.status)) return `exit status ${error.status}`;
  if (error.signal) return `signal ${safeToken(error.signal)}`;
  if (error.code) return `spawn error ${safeToken(error.code)}`;
  return 'unknown subprocess failure';
}

function outputText(value) {
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

function structuredExplanation(output) {
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    return '';
  }
  return helperDiagnosticEntries(result).slice(0, 8).map(formatDiagnostic).join('; ').slice(0, 1200);
}

function helperDiagnosticEntries(result) {
  const envelope = result && typeof result === 'object' ? result : {};
  return asArray(envelope.diagnostics).concat(asArray(envelope.issues).flatMap(issueDiagnosticEntries));
}

function issueDiagnosticEntries(issue) {
  const value = issue && typeof issue === 'object' ? issue : {};
  return asArray(value.diagnostics).concat(asArray(value.blockers));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatDiagnostic(entry) {
  const value = entry && typeof entry === 'object' ? entry : {};
  return [diagnosticCode(value.code), diagnosticMessage(value.message)].filter(Boolean).join(': ');
}

function diagnosticCode(value) {
  return /^[A-Z0-9_]{1,64}$/.test(value) ? value : 'HELPER_DIAGNOSTIC';
}

function diagnosticMessage(value) {
  return typeof value === 'string' ? safeDiagnostic(value) : '';
}

function safeDiagnostic(value) {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/)[^\s,;)]*/g, '[path]')
    .slice(0, 240);
}

function safeToken(value) {
  return (
    String(value)
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 40) || 'unknown'
  );
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
