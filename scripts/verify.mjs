import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assessAudit } from './audit-result.mjs';

// Analyze an exported snapshot: unstaged edits cannot mask a staged audit finding,
// and the pre-pilot recorder tests cannot write CSV files into the user's checkout.
const args = process.argv.slice(2);
const staged = args.includes('--staged');
const auditOnly = args.includes('--audit-only');
const step = args.includes('--step');
const baseIndex = args.indexOf('--base');
// Preserve the source index (including an alternate hook index), but never leak
// repository-local Git variables into the disposable clone or child checks.
const sourceEnv = { ...process.env };
const isolatedEnv = { ...sourceEnv };
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
const report = {
  revision: head,
  checkpoint: staged ? 'commit' : step ? 'step' : 'verification',
  snapshot: staged ? 'index' : 'working-tree',
  checks: [],
};
let failure = false;
function checkAssessment(name, result) {
  if (name === 'fallow') return assessAudit(result);
  return { passed: result.status === 0 && !result.error };
}
function recordCheck(name, command, result) {
  const log = join(reportDir, `${stamp}-${name}.log`);
  const output = [result.stdout, result.stderr, result.error].filter(Boolean).join('');
  writeFileSync(log, output);
  const { audit, ...details } = checkAssessment(name, result);
  if (audit) writeFileSync(log + '.json', JSON.stringify(audit, null, 2) + '\n');
  failure ||= !details.passed;
  report.checks.push({ name, ...details, exit: result.status, command, cwd: snapshot, log });
  console.log(`${details.passed ? 'PASS' : 'FAIL'} ${name}: ${log}`);
}
function run(name, command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: snapshot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: isolatedEnv,
  });
  recordCheck(name, [command, ...commandArgs], result);
}

try {
  if (step && baseIndex < 0) throw Error('Step completion requires --base REF naming the start of the step.');
  const base = git(root, 'rev-parse', '--verify', `${baseIndex >= 0 ? args[baseIndex + 1] : 'HEAD'}^{commit}`).trim();
  report.base = base;
  execFileSync('git', ['clone', '--shared', '--no-checkout', '--quiet', root, snapshot], { env: isolatedEnv });
  git(snapshot, 'reset', '--mixed', head);
  if (staged) {
    git(root, 'checkout-index', '--all', `--prefix=${snapshot}/`);
  } else {
    for (const name of git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z')
      .split('\0')
      .filter(Boolean)) {
      if (!existsSync(join(root, name))) continue;
      mkdirSync(dirname(join(snapshot, name)), { recursive: true });
      cpSync(join(root, name), join(snapshot, name), { recursive: true, dereference: false });
    }
  }
  if (
    readFileSync(join(snapshot, 'package-lock.json'), 'utf8') !== readFileSync(join(root, 'package-lock.json'), 'utf8')
  ) {
    throw Error(
      'Snapshot lockfile differs from installed checkout. Install matching dependencies before verification.'
    );
  }
  symlinkSync(join(root, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
  git(snapshot, 'add', '--all');
  report.snapshot_tree = git(snapshot, 'write-tree').trim();
  report.changed_files = git(snapshot, 'diff', '--cached', '--name-only', '-z', base).split('\0').filter(Boolean);
  const bin = (name) => join(root, 'node_modules', '.bin', name);
  run('fallow', 'npx', [
    '--no-install',
    '--offline',
    'fallow',
    'audit',
    '--base',
    base,
    '--gate',
    'all',
    '--format',
    'json',
  ]);
  if (!auditOnly) {
    const changed = git(snapshot, 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', base)
      .split('\0')
      .filter(Boolean);
    if (changed.length) run('format-changed', bin('prettier'), ['--check', '--ignore-unknown', ...changed]);
    run('factory', 'npm', ['run', 'test:factory']);
    run('typecheck', bin('tsc'), ['--noEmit']);
    run('tests', bin('vitest'), ['run']);
    run('build', 'npm', ['run', 'build']);
  }
} catch (error) {
  failure = true;
  report.error = error.message;
  console.error(error.message);
} finally {
  report.passed = !failure;
  writeFileSync(join(reportDir, `${stamp}-summary.json`), JSON.stringify(report, null, 2) + '\n');
  rmSync(snapshot, { recursive: true, force: true });
}
process.exitCode = failure ? 1 : 0;
