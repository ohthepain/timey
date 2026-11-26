import { listenerPreflight, dependencyPreflight, workspacePackages } from './verify-preflight.mjs';
import { formatArgs, formattingFiles } from './format-files.mjs';
import { fallowAuditScope } from './verify-scope.mjs';
import { runVerificationProcess } from './verify-process.mjs';
import { retainBrowserEvidence } from './verify-browser-evidence.mjs';
import { ciSuites } from './verify-ci-suites.mjs';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assessAudit } from './audit-result.mjs';

// Analyze an exported snapshot: unstaged edits cannot mask a staged audit finding,
// and the pre-pilot recorder tests cannot write CSV files into the user's checkout.
const args = process.argv.slice(2);
const timeoutMs = 15 * 60 * 1000;
const staged = args.includes('--staged');
const auditOnly = args.includes('--audit-only');
const workChecks = args.includes('--work-checks');
const writeFormat = workChecks && args.includes('--write-format');
const step = args.includes('--step');
const baseIndex = args.indexOf('--base');
const ciIndex = args.indexOf('--ci-suite');
const ciSuite = ciIndex < 0 ? null : args[ciIndex + 1];
if (ciIndex >= 0 && (!Object.hasOwn(ciSuites, ciSuite) || staged || auditOnly || workChecks || step))
  throw Error('Run exactly one recognized CI suite using --ci-suite.');
const suite = ciSuites[ciSuite];
const isBrowserCheck = (name) => ['browser', 'flow-browser', 'timey-browser'].includes(name);
// Preserve the source index (including an alternate hook index), but never leak
// repository-local Git variables into the disposable clone or child checks.
const sourceEnv = { ...process.env };
const isolatedEnv = { ...sourceEnv };
delete isolatedEnv.TIMEY_FACTORY_TEST_SHARD;
const localVariables = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split('\n');
for (const key of localVariables) delete isolatedEnv[key];
for (const key of Object.keys(isolatedEnv)) if (/^GIT_CONFIG_(KEY|VALUE)_/.test(key)) delete isolatedEnv[key];
const sourceGit = (...command) => execFileSync('git', command, { encoding: 'utf8', env: sourceEnv });
const root = sourceGit('rev-parse', '--show-toplevel').trim();
const git = (cwd, ...command) =>
  execFileSync('git', ['-C', cwd, ...command], {
    encoding: 'utf8',
    env: cwd === root ? sourceEnv : isolatedEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
const head = git(root, 'rev-parse', 'HEAD').trim();
const snapshot = mkdtempSync(join(tmpdir(), 'timey-verify-'));
const reportDir = join(root, '.issues', 'evidence');
mkdirSync(reportDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID();
const browserOutput = join(snapshot, '.issues/evidence', stamp + '-browser');
const report = {
  revision: head,
  checkpoint: ciSuite ? 'ci-suite' : workChecks ? 'work' : staged ? 'commit' : step ? 'step' : 'verification',
  snapshot: staged ? 'index' : 'working-tree',
  startedAt: new Date().toISOString(),
  phases: [],
  checks: [],
  ...(ciSuite ? { ciSuite } : {}),
};
let failure = false;
const cancellation = new AbortController();
const cancel = () => cancellation.abort();
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
function fallowEnforced(env = isolatedEnv) {
  const value = env.TIMEY_FALLOW_ENFORCE;
  return workChecks || value === '1' || value === 'true';
}
function checkAssessment(name, result) {
  if (name === 'fallow')
    return assessAudit(result, report.changed_files, {
      warningsAsErrors: workChecks || isolatedEnv.TIMEY_FALLOW_WARNINGS === 'error',
    });
  return { passed: result.status === 0 && !result.error };
}
function recordSkippedFallow() {
  const startedAt = new Date().toISOString();
  report.phases.push({ name: 'fallow', startedAt });
  const log = join(reportDir, `${stamp}-fallow.log`);
  writeFileSync(log, 'Fallow audit skipped. Set TIMEY_FALLOW_ENFORCE=1 to enforce at commit, push, and verify.\n');
  report.checks.push({
    name: 'fallow',
    passed: true,
    skipped: true,
    command: ['skipped'],
    cwd: snapshot,
    log,
    reasons: ['Fallow enforcement is disabled unless TIMEY_FALLOW_ENFORCE=1.'],
  });
  Object.assign(report.phases.at(-1), {
    finishedAt: new Date().toISOString(),
    passed: true,
    skipped: true,
  });
  console.log(`SKIP fallow: ${log}`);
}
function recordCheck(name, command, result) {
  const log = join(reportDir, `${stamp}-${name}.log`);
  const output = [result.stdout, result.stderr, result.error].filter(Boolean).join('');
  writeFileSync(log, output);
  const { audit, ...details } = checkAssessment(name, result);
  if (audit) writeFileSync(log + '.json', JSON.stringify(audit, null, 2) + '\n');
  failure ||= !details.passed;
  report.checks.push({
    name,
    ...details,
    exit: result.status,
    command,
    cwd: snapshot,
    log,
    ...(isBrowserCheck(name)
      ? { artifacts: retainBrowserEvidence(browserOutput, join(reportDir, stamp + '-browser')) }
      : {}),
    pid: result.pid,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    timedOut: result.timedOut,
  });
  console.log(`${details.passed ? 'PASS' : 'FAIL'} ${name}: ${log}`);
  if (!details.passed) {
    // Node's spec reporter repeats failures with their assertions and source locations
    // at the end. Keep that complete section, rather than only matching headlines.
    const marker = '✖ failing tests:';
    const detailStart = output.indexOf(marker);
    const details = detailStart < 0 ? output : output.slice(detailStart);
    console.error(`::group::${name} failure details`);
    console.error(details.trim() || `No diagnostic output was returned. See ${log}`);
    console.error('::endgroup::');
  }
  if (!details.passed && details.reasons?.length) {
    console.error(`${name}:`);
    for (const reason of details.reasons) console.error(`  - ${reason}`);
  }
}
async function run(name, command, commandArgs) {
  if (cancellation.signal.aborted) throw Error('Verification cancelled. No remaining checks were started.');
  const startedAt = new Date().toISOString();
  report.phases.push({ name, startedAt });
  console.log(`START ${name}: ${[command, ...commandArgs].join(' ')}`);
  const result = await runVerificationProcess(
    command,
    commandArgs,
    {
      cwd: snapshot,
      signal: cancellation.signal,
      streamOutput: true,
      timeoutMs,
      encoding: 'utf8',
      env: isBrowserCheck(name)
        ? {
            ...isolatedEnv,
            TIMEY_BROWSER_OUTPUT: browserOutput,
            TIMEY_FLOW_BROWSER_OUTPUT: join(browserOutput, 'flow'),
            TIMEY_RETURN_BROWSER_OUTPUT: join(browserOutput, 'timey'),
          }
        : isolatedEnv,
    },
    join(reportDir, `${stamp}-${name}.log`)
  );
  recordCheck(name, [command, ...commandArgs], result);
  Object.assign(report.phases.at(-1), {
    finishedAt: new Date().toISOString(),
    passed: report.checks.at(-1).passed,
  });
  if (result.timedOut)
    throw Error(
      `${name} timed out after 15 minutes: ${[command, ...commandArgs].join(' ')}. See its verification log.`
    );
}

function copySourceFile(name) {
  const source = join(root, name),
    destination = join(snapshot, name);
  const entry = lstatSync(source, { throwIfNoEntry: false });
  if (!entry) return;
  mkdirSync(dirname(destination), { recursive: true });
  if (entry.isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
  else cpSync(source, destination, { recursive: true, dereference: false });
}

const bin = (name) => join(root, 'node_modules', '.bin', name);

function factoryVerificationCommand() {
  const factory = ['pnpm', 'run', 'test:factory'];
  return suite?.factoryShard ? ['env', 'TIMEY_FACTORY_TEST_SHARD=' + suite.factoryShard, ...factory] : factory;
}

function flowVerificationCommand() {
  const flow = [process.execPath, 'scripts/flow-browser.mjs'];
  if (suite?.flowPart) flow.push('--ci-part=' + suite.flowPart);
  return flow;
}

function verificationCommands() {
  const commands = {
    browser: ciSuite ? [process.execPath, 'scripts/factory-browser.mjs'] : ['pnpm', 'run', 'test:browser'],
    'flow-browser': flowVerificationCommand(),
    'timey-browser': [process.execPath, '--test', 'scripts/timey-factory-return.check.mjs'],
    factory: factoryVerificationCommand(),
    typecheck: [bin('tsc'), '--noEmit'],
    tests: [bin('vp'), 'test', 'run'],
    build: ['pnpm', 'run', 'build'],
  };
  const names = ciSuite
    ? suite.checks.filter((name) => name !== 'fallow')
    : ['browser', 'factory', 'typecheck', 'tests', 'build'];
  return names.map((name) => [name, ...commands[name]]);
}

async function checkExecutionPreflight() {
  const preflight = { name: 'execution-preflight', startedAt: new Date().toISOString(), passed: false };
  report.phases.push(preflight);
  await listenerPreflight();
  Object.assign(preflight, { finishedAt: new Date().toISOString(), passed: true });
}

async function runVerificationChecks() {
  if (ciSuite !== 'early') await checkExecutionPreflight();
  for (const [name, command, ...args] of verificationCommands()) await run(name, command, args);
}

async function checkFormatting(base) {
  const names = git(snapshot, 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', base)
    .split('\0')
    .filter(Boolean);
  const files = formattingFiles(snapshot, names);
  if (files.length) await run('format-changed', bin('vp'), ['fmt', '--check', ...formatArgs(files)]);
  else if (report.changed_files.length)
    await run('format-changed', process.execPath, [
      '-e',
      'console.log("No changed regular files require formatting.")',
    ]);
}

try {
  if (step && baseIndex < 0) throw Error('Step completion requires --base REF naming the start of the step.');
  const base = git(root, 'rev-parse', '--verify', `${baseIndex >= 0 ? args[baseIndex + 1] : 'HEAD'}^{commit}`).trim();
  report.base = base;
  if (writeFormat) {
    const changed = git(root, 'diff', '--name-only', '--diff-filter=ACMR', '-z', base);
    const untracked = git(root, 'ls-files', '--others', '--exclude-standard', '-z');
    const files = formattingFiles(root, (changed + untracked).split('\0').filter(Boolean));
    if (files.length) execFileSync(bin('vp'), ['fmt', ...formatArgs(files)], { cwd: root, stdio: 'inherit' });
  }
  report.phases.push({ name: 'snapshot', startedAt: new Date().toISOString() });
  execFileSync('git', ['clone', '--shared', '--no-checkout', '--quiet', root, snapshot], { env: isolatedEnv });
  git(snapshot, 'reset', '--mixed', head);
  if (staged) {
    git(root, 'checkout-index', '--all', `--prefix=${snapshot}/`);
  } else {
    for (const name of git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z')
      .split('\0')
      .filter(Boolean)) {
      copySourceFile(name);
    }
  }
  const lockfile = 'pnpm-lock.yaml';
  const installedLock = join(root, lockfile);
  const snapshotLock = join(snapshot, lockfile);
  if (!existsSync(installedLock)) {
    throw Error(`Missing ${lockfile} in the checkout. Run pnpm install before verification.`);
  }
  if (!existsSync(snapshotLock)) {
    throw Error(`${lockfile} is not staged. Stage ${lockfile} so this commit matches the installed dependencies.`);
  }
  if (readFileSync(snapshotLock, 'utf8') !== readFileSync(installedLock, 'utf8')) {
    throw Error(
      'Snapshot lockfile differs from installed checkout. Install matching dependencies before verification.'
    );
  }
  const workspaces = workspacePackages(snapshot);
  dependencyPreflight(root, snapshot, workspaces);
  symlinkSync(join(root, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
  // Workspace-local dependency versions must follow the exported source too.
  for (const workspace of workspaces) {
    const installed = join(root, workspace, 'node_modules');
    if (existsSync(installed)) symlinkSync(installed, join(snapshot, workspace, 'node_modules'), 'dir');
  }
  git(snapshot, 'add', '--all');
  report.snapshot_tree = git(snapshot, 'write-tree').trim();
  report.changed_files = git(snapshot, 'diff', '--cached', '--name-only', '-z', base).split('\0').filter(Boolean);
  git(snapshot, 'cat-file', '-e', base + '^{commit}');
  git(snapshot, 'cat-file', '-e', report.snapshot_tree + '^{tree}');
  Object.assign(report.phases.at(-1), { finishedAt: new Date().toISOString(), passed: true });
  if (!auditOnly && (!ciSuite || ciSuite === 'early')) await checkFormatting(base);
  if (failure) throw Error('Fix changed-file formatting before continuing verification.');
  // Tests may substitute the pinned binary without changing node_modules.
  const fallowCommand = isolatedEnv.TIMEY_FALLOW_COMMAND || bin('fallow');
  const fallowArgs = ['audit', '--base', base, '--format', 'json'];
  // Each checkpoint uses a disposable export root; avoid stale cross-root
  // incremental cache warnings while retaining the full configured audit.
  if (fallowEnforced()) fallowArgs.push('--no-cache');
  if (report.changed_files.length === 0) fallowArgs.push('--gate', 'all');
  else fallowArgs.push(fallowAuditScope(report.changed_files));
  if (!ciSuite || ciSuite === 'early') {
    if (fallowEnforced()) await run('fallow', fallowCommand, fallowArgs);
    else recordSkippedFallow();
  }
  if (!auditOnly && !workChecks && !failure) await runVerificationChecks();
} catch (error) {
  failure = true;
  report.error = error.message;
  report.errorCode = error.code || 'VERIFICATION_FAILED';
  console.error(error.message);
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
  report.finishedAt = new Date().toISOString();
  report.passed = !failure;
  writeFileSync(join(reportDir, `${stamp}-summary.json`), JSON.stringify(report, null, 2) + '\n');
  console.log('Verification summary: ' + join(reportDir, `${stamp}-summary.json`));
  rmSync(snapshot, { recursive: true, force: true });
}
process.exitCode = failure ? 1 : 0;
