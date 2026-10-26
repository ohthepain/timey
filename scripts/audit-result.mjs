// This validator is deliberately tied to the pinned CLI/report schema.
const failures = (checks) => checks.filter(([passed]) => !passed).map(([, reason]) => reason);
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function parseAudit(stdout) {
  try {
    const report = JSON.parse(stdout);
    return isRecord(report) ? report : null;
  } catch {
    return null;
  }
}
function validIdentity(audit) {
  return audit.kind === 'audit' && audit.schema_version === 13 && audit.version === '3.35.0';
}
function validGateOutcomes(outcomes) {
  if (outcomes === undefined) return true;
  if (!isRecord(outcomes)) return false;
  return Object.keys(outcomes).length > 0 && Object.values(outcomes).every((outcome) => outcome?.status === 'pass');
}
function summaryErrors(summary) {
  const counts = ['dead_code_issues', 'complexity_findings', 'duplication_clone_groups'];
  return failures(counts.map((key) => [summary?.[key] === 0, `${key}: ${summary?.[key]}.`]));
}
function hasFindings(section, key) {
  if (section === undefined) return false;
  if (!isRecord(section)) return true;
  return !Array.isArray(section[key]) || section[key].length !== 0;
}
function analysisErrors(audit) {
  return failures([
    [(audit.dead_code?.total_issues ?? 0) === 0, 'Fallow reported dead-code findings.'],
    [!hasFindings(audit.complexity, 'findings'), 'Fallow reported invalid or nonempty complexity findings.'],
    [!hasFindings(audit.duplication, 'clone_groups'), 'Fallow reported invalid or nonempty duplication findings.'],
  ]);
}
function reportErrors(audit) {
  return failures([
    [validIdentity(audit), 'Unsupported Fallow report; expected pinned 3.35.0 schema 13.'],
    [(audit.command ?? 'audit') === 'audit', 'Fallow did not return an audit command result.'],
    [audit.verdict === 'pass', `Fallow verdict: ${audit.verdict}.`],
    [audit.attribution?.gate === 'all', 'Fallow did not enforce all findings in changed files.'],
    [audit.summary?.dead_code_has_errors !== true, 'Fallow reported dead-code analysis errors.'],
    [validGateOutcomes(audit.gate_outcomes), 'Fallow reported an invalid or unsuccessful gate outcome.'],
  ]).concat(summaryErrors(audit.summary), analysisErrors(audit));
}
function processErrors(result) {
  return failures([
    [result.status === 0, `Fallow exited ${result.status}.`],
    [!result.error, 'Fallow could not run.'],
    [!/\bwarn(?:ing)?\b/i.test(result.stderr ?? ''), 'Fallow emitted a warning; inspect the raw log.'],
  ]);
}
function diagnosticAssessment(diagnostics) {
  if (!Array.isArray(diagnostics)) return { reasons: ['Missing analysis diagnostics.'], limitations: [] };
  if (diagnostics.some((entry) => !entry || typeof entry !== 'object' || typeof entry.kind !== 'string'))
    return { reasons: ['Malformed analysis diagnostics.'], limitations: [] };
  const unmeasured = (d) =>
    ['boundaries-not-configured', 'rule-packs-not-configured'].includes(d.kind) && !d.degrades_analysis;
  return {
    reasons: diagnostics.filter((d) => !unmeasured(d)).map((d) => `${d.kind}: ${d.message}`),
    limitations: diagnostics.filter(unmeasured),
  };
}
function sourceScope(changedFiles) {
  if (!Array.isArray(changedFiles)) return 'unverified';
  return changedFiles.length === 0 ? 'empty' : 'changed-files';
}
function compactEmpty(audit, scope) {
  return scope === 'empty' && audit.changed_files_count === 0 && audit.dead_code === undefined;
}
function scopedDiagnostics(audit, scope) {
  if (compactEmpty(audit, scope)) return { reasons: [], limitations: [] };
  return diagnosticAssessment(audit.dead_code?.workspace_diagnostics);
}
function scopeAssessment(audit, scope) {
  if (scope !== 'empty') return { reasons: [], limitations: [] };
  return {
    reasons: failures([[audit.changed_files_count === 0, 'Fallow scope disagrees with the empty exported Git diff.']]),
    limitations: [{ kind: 'empty-source-diff', message: 'No changed source; unrelated analysis was not measured.' }],
  };
}
// Warning verdicts and some warnings still exit zero; inspect evidence, too.
export function assessAudit(result, changedFiles) {
  // Only the caller's exported/indexed Git diff can establish empty scope.
  // A zero count in the tool's report is never sufficient evidence.
  const scope = sourceScope(changedFiles);
  const audit = parseAudit(result.stdout);
  if (!audit)
    return { passed: false, reasons: ['Fallow did not return a valid JSON audit object.'], limitations: [], scope };
  const diagnostics = scopedDiagnostics(audit, scope),
    scopeResult = scopeAssessment(audit, scope);
  const reasons = [...processErrors(result), ...reportErrors(audit), ...diagnostics.reasons, ...scopeResult.reasons];
  return {
    passed: reasons.length === 0,
    reasons,
    limitations: [...diagnostics.limitations, ...scopeResult.limitations],
    scope,
    audit,
  };
}
