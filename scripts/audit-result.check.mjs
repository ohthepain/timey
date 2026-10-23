import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessAudit } from './audit-result.mjs';
const clean = () => ({
  kind: 'audit',
  schema_version: 13,
  version: '3.35.0',
  verdict: 'pass',
  attribution: { gate: 'all' },
  summary: { dead_code_issues: 0, complexity_findings: 0, duplication_clone_groups: 0 },
  dead_code: { workspace_diagnostics: [] },
});
const result = (audit = clean(), stderr = '') => ({ status: 0, stdout: JSON.stringify(audit), stderr });
test('zero-exit warnings and findings are failures, not successful checkpoints', () => {
  assert.equal(assessAudit(result()).passed, true);
  const warn = clean();
  warn.verdict = 'warn';
  assert.equal(assessAudit(result(warn)).passed, false);
  assert.equal(assessAudit(result(clean(), 'WARN skipped entry point\n')).passed, false);
  const findings = clean();
  findings.summary.dead_code_issues = 1;
  assert.equal(assessAudit(result(findings)).passed, false);
});
test('invalid reports, new-only gates, failed processes and degraded analysis fail closed', () => {
  assert.equal(assessAudit({ status: 0, stdout: 'not JSON' }).passed, false);
  const unsupported = clean();
  unsupported.schema_version = 14;
  assert.equal(assessAudit(result(unsupported)).passed, false);
  const waiver = clean();
  waiver.attribution.gate = 'new-only';
  assert.equal(assessAudit(result(waiver)).passed, false);
  assert.equal(assessAudit({ ...result(), status: 1 }).passed, false);
  const degraded = clean();
  degraded.dead_code.workspace_diagnostics.push({ kind: 'source-parse-degraded', degrades_analysis: true });
  assert.equal(assessAudit(result(degraded)).passed, false);
});
test('unconfigured optional detectors are explicit unmeasured coverage, not clean findings', () => {
  const audit = clean();
  audit.dead_code.workspace_diagnostics.push({ kind: 'boundaries-not-configured', message: 'Not measured' });
  const assessment = assessAudit(result(audit));
  assert.equal(assessment.passed, true);
  assert.equal(assessment.limitations.length, 1);
});
