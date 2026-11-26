import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { z } from 'zod';
import { digest, requireThat, writeJson } from './common.mjs';
import { redactValue } from './activity.mjs';
import { evidencePath } from './stores/evidence.mjs';

function readEvidence(root, file) {
  if (!file) return;
  try {
    const bytes = readFileSync(evidencePath(root, file.path, file.sha256));
    if (digest(bytes) === file.sha256) return JSON.parse(bytes);
  } catch {
    // Historical records may be unavailable on this runner.
  }
}

const repairBrowserObservation = z.object({
  sourceCommit: z.string(),
  sourceTree: z.string().optional(),
  sourceDiff: z.literal(''),
  sourceClean: z.literal(true).optional(),
  sourceEnvironment: z.record(z.string(), z.string()).optional(),
  fixture: z.string().min(1),
  scenarios: z.array(z.object({ result: z.object({ head: z.string().min(1), revision: z.string().min(1) }) })).min(1),
});

export function repairBrowserProof(file, { commit, tree }, { attemptId, round }) {
  const parsed = repairBrowserObservation.safeParse(readEvidence(null, file));
  if (!parsed.success) return;
  const { sourceCommit, sourceTree = tree, sourceEnvironment, fixture } = parsed.data;
  if (sourceCommit === commit && sourceTree === tree)
    return { attemptId, round, sourceCommit, sourceTree, environment: { ...sourceEnvironment, fixture }, file };
}

function matchingRepairBrowserProof(root, { sourceCommit, sourceTree, file } = {}, { commit, tree }) {
  return sourceCommit === commit && sourceTree === tree && readEvidence(root, file);
}

export function priorRepairBrowserProof(root, attempts, candidate) {
  return (attempts ?? [])
    .flatMap(({ evidence = [] }) => evidence.filter(({ label }) => label === 'Merge repair index'))
    .flatMap((index) => readEvidence(root, index)?.attempts ?? [])
    .findLast(({ browserProof }) => matchingRepairBrowserProof(root, browserProof, candidate))?.browserProof;
}

export function receiptRepairBrowserProof(root, receipt, candidate) {
  const proof = readEvidence(root, receipt)?.repairBrowserProof;
  if (matchingRepairBrowserProof(root, proof, candidate)) return proof;
}

export function mergeRepairHistory(folder, attemptId, log) {
  const attempts = [];
  const attachments = new Map();
  let delivery;
  const index = join(folder, 'repair-index.json');
  const save = () => writeJson(index, { attemptId, attempts, delivery });
  function validate(file) {
    requireThat(
      lstatSync(file.path, { throwIfNoEntry: false })?.isFile() && digest(readFileSync(file.path)) === file.sha256,
      'Merge repair evidence is missing or has changed: ' + file.path
    );
  }
  function validateAttachments() {
    for (const file of attachments.values()) validate(file);
  }
  function retainAttachments(record, outcome) {
    const files = [record.log, record.result, ...(outcome.failureEvidence ?? []), ...(outcome.evidence ?? [])];
    for (const file of files.filter(Boolean)) attachments.set(file.path, file);
  }
  return {
    start(round, revision, error) {
      const directory = join(folder, 'repair-' + round);
      mkdirSync(directory, { mode: 0o700 });
      const record = {
        round,
        failedHead: revision.commit,
        startedAt: new Date().toISOString(),
        failure: { message: error.message, revision, ciRuns: error.githubRuns ?? [] },
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
          record.failure.checks = outcome.failedChecks;
          record.candidate = outcome.candidate;
          record.repairedRevision = outcome.repairedRevision;
          record.browserProof = outcome.browserProof;
          record.result = retainRepairFile(
            directory,
            'result.json',
            JSON.stringify({ ...outcome, conversation: record.conversation }, null, 2) + '\n'
          );
          retainAttachments(record, outcome);
          save();
        },
      };
    },
    complete(result) {
      validateAttachments();
      delivery = result;
      save();
    },
    get hasRepairs() {
      return attempts.length > 0;
    },
    browserProof(candidate) {
      return attempts
        .map(({ browserProof }) => browserProof)
        .findLast((proof) => matchingRepairBrowserProof(null, proof, candidate));
    },
    validateAttachments,
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
    const bytes = readFileSync(original);
    requireThat(!file.sha256 || digest(bytes) === file.sha256, 'Merge repair source evidence changed: ' + file.path);
    const text = redactValue(bytes.toString('utf8'));
    const name = `evidence-${retained.size}.txt`;
    const path = join(folder, name);
    writeFileSync(path, text, { mode: 0o600 });
    const copy = retainRepairFile(directory, name, text);
    const saved = { ...file, ...copy, originalPath: file.path };
    copies.push(saved);
    const result = { worker: { ...saved, path }, copy: saved };
    retained.set(file.path, result);
    return result;
  }
  const { reports, evidence } = verificationRecords(error);
  for (const file of evidence) retain(file);
  const failedChecks = failedCheckRecords(reports, retain);
  return {
    evidence: [...retained.values()].map(({ worker }) => worker),
    failedChecks: failedChecks.map((check) => ({ ...check, log: check.log?.worker.path })),
    recordedChecks: failedChecks.map((check) => ({ ...check, log: check.log?.copy })),
    copies,
  };
}

function verificationRecords(error) {
  const reports = error.verificationFailure?.summaries ?? [];
  const evidence = [...(error.evidence ?? []), ...reports.map((path) => ({ path, label: 'Verification summary' }))];
  return { reports, evidence };
}

function failedCheckRecords(reports, retain) {
  return reports.flatMap((path) => {
    const report = JSON.parse(readFileSync(retain({ path }).worker.path, 'utf8'));
    return (report.checks ?? [])
      .filter((check) => !check.passed)
      .map((check) => ({
        name: check.name,
        command: check.command,
        exit: check.exit,
        reasons: check.reasons,
        log: check.log && retain({ path: check.log, label: `Failed ${check.name} check` }),
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
