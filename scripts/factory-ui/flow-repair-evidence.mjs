import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { digest, requireThat, writeJson } from './common.mjs';
import { redactValue } from './activity.mjs';

export function mergeRepairHistory(folder, attemptId, log) {
  const attempts = [];
  const index = join(folder, 'repair-index.json');
  const save = () => writeJson(index, { attemptId, attempts });
  return {
    start(round, failedHead, message) {
      const directory = join(folder, 'repair-' + round);
      mkdirSync(directory, { mode: 0o700 });
      const record = {
        round,
        failedHead,
        startedAt: new Date().toISOString(),
        failure: { message },
        log: existsSync(log) ? retainRepairFile(directory, 'merge.log', readFileSync(log)) : null,
        conversation: {},
      };
      attempts.push(record);
      save();
      return {
        folder: directory,
        conversation: record.conversation,
        finish(outcome) {
          record.finishedAt = new Date().toISOString();
          record.failure.evidence = outcome.failureEvidence;
          record.candidate = outcome.candidate;
          record.result = retainRepairFile(
            directory,
            'result.json',
            JSON.stringify({ ...outcome, conversation: record.conversation }, null, 2) + '\n'
          );
          save();
        },
      };
    },
    evidence() {
      return attempts.length ? [{ path: index, label: 'Merge repair index', sha256: digest(readFileSync(index)) }] : [];
    },
  };
}

function retainRepairFile(folder, name, bytes) {
  const path = join(folder, name);
  writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  return { path, sha256: digest(bytes) };
}

export function retainMergeRepairEvidence(root, checkout, attemptId, error, round, directory) {
  const folder = join(checkout, '.issues/evidence', `merge-repair-${attemptId}-${round}`);
  mkdirSync(folder, { recursive: true });
  const roots = [root, checkout].map((path) => realpathSync(join(path, '.issues')) + sep);
  const retained = new Map();
  const copies = [];
  function retain(file) {
    if (retained.has(file.path)) return retained.get(file.path);
    const original = realpathSync(file.path);
    requireThat(
      roots.some((base) => original.startsWith(base)),
      'Merge repair evidence is outside retained issue records.'
    );
    const text = redactValue(readFileSync(original, 'utf8'));
    const name = `evidence-${retained.size}.txt`;
    const path = join(folder, name);
    writeFileSync(path, text, { mode: 0o600 });
    const copy = retainRepairFile(directory, name, text);
    copies.push({ ...file, ...copy, originalPath: file.path });
    const result = { ...file, path, originalPath: file.path, sha256: copy.sha256 };
    retained.set(file.path, result);
    return result;
  }
  const { reports, evidence } = verificationRecords(error);
  for (const file of evidence) retain(file);
  const failedChecks = failedCheckRecords(reports, retain);
  return { evidence: [...retained.values()], failedChecks, copies };
}

function verificationRecords(error) {
  const reports = error.verificationFailure?.summaries ?? [];
  const evidence = [...(error.evidence ?? []), ...reports.map((path) => ({ path, label: 'Verification summary' }))];
  return { reports, evidence };
}

function failedCheckRecords(reports, retain) {
  return reports.flatMap((path) => {
    const report = JSON.parse(readFileSync(retain({ path }).path, 'utf8'));
    return (report.checks ?? [])
      .filter((check) => !check.passed)
      .map((check) => ({
        name: check.name,
        command: check.command,
        exit: check.exit,
        reasons: check.reasons,
        log: check.log && retain({ path: check.log, label: `Failed ${check.name} check` }).path,
      }));
  });
}

function checkFailureSignature(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  return report.checks
    .filter((check) => !check.passed)
    .map((check) => {
      const log = check.log ? readFileSync(check.log, 'utf8') : '';
      const failures = log
        .split('\n')
        .filter((line) => /^(?:not ok |✖ |AssertionError|Error:|locator\.\w+:|\s*- waiting for locator)/.test(line));
      return { name: check.name, reasons: check.reasons, failures };
    });
}

export function verificationFailureKey(error) {
  const reports = error.verificationFailure?.summaries;
  return reports?.length ? JSON.stringify(reports.flatMap(checkFailureSignature)) : error.blockerKey;
}

export function verificationFailureMessage(error) {
  if (!error.verificationFailure) return error.message;
  const names = failedVerificationNames(error.verificationFailure);
  return 'Tests or verification checks failed' + (names.length ? ` (${names.join(', ')})` : '') + '. ' + error.message;
}

function failedVerificationNames(failure) {
  const names = (failure.summaries ?? []).flatMap((path) =>
    JSON.parse(readFileSync(path, 'utf8'))
      .checks.filter((check) => !check.passed)
      .map((check) => check.name)
  );
  return [...new Set(names)];
}
