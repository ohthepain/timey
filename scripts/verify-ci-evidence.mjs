import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, posix, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ciSuites } from './verify-ci-suites.mjs';

const digest = (body) => createHash('sha256').update(body).digest('hex');

function requireEvidence(condition, message) {
  if (!condition) throw Error(message);
}

function retainedFile(folder, originalRoot, original) {
  const name = posix.relative(originalRoot, original);
  const path = resolve(folder, name);
  requireEvidence(path.startsWith(folder + sep), 'A suite evidence path escapes its artifact directory.');
  requireEvidence(
    lstatSync(path).isFile() && realpathSync(path) === path,
    'A suite evidence file is missing or is not a regular file.'
  );
  return path;
}

function relocateCheck(folder, check) {
  const originalRoot = posix.dirname(check.log);
  return {
    ...check,
    log: retainedFile(folder, originalRoot, check.log),
    ...(check.artifacts && {
      artifacts: check.artifacts.map((file) => {
        const path = retainedFile(folder, originalRoot, file.path);
        requireEvidence(digest(readFileSync(path)) === file.sha256, 'A suite browser artifact changed.');
        return { ...file, path };
      }),
    }),
  };
}

function requireSuiteCandidate(report, candidate) {
  const message = 'CI suite ' + report.ciSuite + ' did not pass for the exact candidate.';
  requireEvidence(report.checkpoint === 'ci-suite' && report.passed, message);
  requireEvidence(
    report.revision === candidate.revision && report.base === candidate.base && report.snapshot_tree === candidate.tree,
    message
  );
}

function verifiedSuite(reports, suite, candidate) {
  const matching = reports.filter((report) => report.ciSuite === suite);
  requireEvidence(matching.length === 1, 'Expected one report for CI suite ' + suite + '.');
  const [report] = matching;
  requireSuiteCandidate(report, candidate);
  const expected = [...ciSuites[suite].checks];
  if (suite === 'early' && report.changed_files.length) expected.unshift('format-changed');
  requireEvidence(
    JSON.stringify(report.checks.map(({ name }) => name)) === JSON.stringify(expected) &&
      report.checks.every((check) => check.passed && check.exit === 0 && !check.skipped),
    'CI suite ' + suite + ' is missing passing check evidence.'
  );
  return report;
}

function browserOutput(check, scenario) {
  const output = readFileSync(check.log, 'utf8');
  requireEvidence(scenario.test(output), check.name + ' must record actual scenario execution.');
  requireEvidence(check.artifacts?.length, check.name + ' must retain browser artifacts.');
  return output;
}

const browserSuites = Object.keys(ciSuites).filter((id) => ciSuites[id].flowPart);

function browserCheck(folder, flow) {
  const flowOutput = flow.map((check) => browserOutput(check, /^PASS /m));
  const log = join(folder, 'ci-browser.log');
  writeFileSync(log, flowOutput.join('\n'), { flag: 'wx' });
  return {
    ...flow[0],
    name: 'browser',
    log,
    command: ['CI', ...browserSuites],
    artifacts: flow.flatMap((check) => [
      { path: check.log, sha256: digest(readFileSync(check.log)) },
      ...check.artifacts,
    ]),
  };
}

function factoryCheck(folder, shards) {
  const output = shards.map(({ log }) => readFileSync(log, 'utf8'));
  requireEvidence(
    output.every((text) => /(?:ℹ|#) tests [1-9]\d*/.test(text)),
    'Both Factory shards must run tests.'
  );
  const log = join(folder, 'ci-factory.log');
  writeFileSync(log, output.join('\n'), { flag: 'wx' });
  return { ...shards[0], log, command: ['CI', 'non-browser-1', 'non-browser-2'] };
}

export function assembleCIEvidence(directory, candidate) {
  const folder = realpathSync(directory);
  const reports = readdirSync(folder)
    .filter((name) => name.endsWith('-summary.json'))
    .map((name) => JSON.parse(readFileSync(join(folder, name), 'utf8')));
  const suites = Object.fromEntries(
    Object.keys(ciSuites).map((suite) => [suite, verifiedSuite(reports, suite, candidate)])
  );
  const evidence = Object.fromEntries(
    Object.entries(suites).map(([suite, report]) => [suite, report.checks.map((check) => relocateCheck(folder, check))])
  );
  const browser = browserCheck(
    folder,
    browserSuites.flatMap((id) => evidence[id])
  );
  const factory = factoryCheck(folder, [...evidence['non-browser-1'], ...evidence['non-browser-2']]);
  const checks = [...evidence.early, factory, ...evidence['non-browser-app'], browser];
  const { ciSuite: _ciSuite, ...summary } = suites.early;
  const path = join(folder, 'ci-verification-summary.json');
  writeFileSync(
    path,
    JSON.stringify({
      ...summary,
      checkpoint: 'verification',
      finishedAt: new Date().toISOString(),
      phases: Object.values(suites).flatMap((suite) => suite.phases),
      checks,
    }),
    { flag: 'wx' }
  );
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const base = process.argv[2];
  requireEvidence(base, 'The early CI suite did not record its comparison base.');
  const revision = git('rev-parse', 'HEAD');
  requireEvidence(revision === process.env.GITHUB_SHA, 'The aggregate checkout differs from the Actions candidate.');
  const path = assembleCIEvidence('.issues/evidence', { revision, base, tree: git('rev-parse', 'HEAD^{tree}') });
  console.log('Verification summary: ' + basename(path));
}
