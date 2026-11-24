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

function browserCheck(folder, classic, flow) {
  const classicOutput = browserOutput(classic, /PASS browser scenario:/);
  const flowOutput = browserOutput(flow, /^PASS /m);
  const log = join(folder, 'ci-browser.log');
  writeFileSync(log, classicOutput + '\n' + flowOutput, { flag: 'wx' });
  return {
    ...classic,
    log,
    command: ['CI', 'classic-browser', 'flow-browser'],
    artifacts: [classic, flow].flatMap((check) => [
      { path: check.log, sha256: digest(readFileSync(check.log)) },
      ...check.artifacts,
    ]),
  };
}

export function assembleCIEvidence(directory, candidate) {
  const folder = realpathSync(directory);
  const reports = readdirSync(folder)
    .filter((name) => name.endsWith('-summary.json'))
    .map((name) => JSON.parse(readFileSync(join(folder, name), 'utf8')));
  const suites = Object.keys(ciSuites).map((suite) => verifiedSuite(reports, suite, candidate));
  const [early, nonBrowser, classic, flow] = suites.map((report) =>
    report.checks.map((check) => relocateCheck(folder, check))
  );
  const checks = [...early, ...nonBrowser, browserCheck(folder, classic[0], flow[0])];
  const { ciSuite: _ciSuite, ...summary } = suites[0];
  const path = join(folder, 'ci-verification-summary.json');
  writeFileSync(
    path,
    JSON.stringify({
      ...summary,
      checkpoint: 'verification',
      finishedAt: new Date().toISOString(),
      phases: suites.flatMap((suite) => suite.phases),
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
