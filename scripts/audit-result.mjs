// This validator is deliberately tied to the pinned CLI/report schema.
const failures = (checks) => checks.filter(([passed]) => !passed).map(([, reason]) => reason);
function parseAudit(stdout) {
  try {
    const report = JSON.parse(stdout);
    return report && typeof report === 'object' ? report : null;
  } catch {
    return null;
  }
}
function reportErrors(audit) {
  const gate = audit.attribution?.gate ?? 'unknown';
  const newOnly = gate === 'new-only' || gate === 'introduced';
  const verdictOk = audit.verdict === 'pass' || audit.verdict === 'warn';
  return failures([
    [
      audit.kind === 'audit' && audit.schema_version === 13 && audit.version === '3.35.0',
      'Unsupported Fallow report; expected pinned 3.35.0 schema 13.',
    ],
    [
      verdictOk,
      `Fallow verdict must be pass or warn; got ${audit.verdict}.`,
    ],
    [newOnly || gate === 'all', `Fallow gate must be new-only or all; got ${gate}.`],
  ]);
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
  const unmeasured = (d) =>
    ['boundaries-not-configured', 'rule-packs-not-configured'].includes(d.kind) && !d.degrades_analysis;
  return {
    reasons: diagnostics.filter((d) => !unmeasured(d)).map((d) => `${d.kind}: ${d.message}`),
    limitations: diagnostics.filter(unmeasured),
  };
}
// Warning verdicts and some warnings still exit zero; inspect evidence, too.
export function assessAudit(result) {
  const audit = parseAudit(result.stdout);
  if (!audit) return { passed: false, reasons: ['Fallow did not return a valid JSON audit object.'], limitations: [] };
  const { reasons: diagnostics, limitations } = diagnosticAssessment(audit.dead_code?.workspace_diagnostics);
  const reasons = [...processErrors(result), ...reportErrors(audit), ...diagnostics];
  return { passed: reasons.length === 0, reasons, limitations, audit };
}
