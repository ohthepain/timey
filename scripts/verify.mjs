import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Analyze an exported snapshot: unstaged edits cannot mask a staged audit finding,
// and the pre-pilot recorder tests cannot write CSV files into the user's checkout.
const args = process.argv.slice(2);
const staged = args.includes('--staged');
const auditOnly = args.includes('--audit-only');
const baseIndex = args.indexOf('--base');
const git = (cwd, ...command) =>
  execFileSync('git', ['-C', cwd, ...command], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
const base = git(root, 'rev-parse', '--verify', `${baseIndex >= 0 ? args[baseIndex + 1] : 'HEAD'}^{commit}`).trim();
const head = git(root, 'rev-parse', 'HEAD').trim();
const snapshot = mkdtempSync(join(tmpdir(), 'timey-verify-'));
const reportDir = join(root, '.issues', 'evidence');
mkdirSync(reportDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-');
const report = { revision: head, base, snapshot: staged ? 'index' : 'working-tree', checks: [] };
let failure = false;
function run(name, command, commandArgs, input) {
  const log = join(reportDir, `${stamp}-${name}.log`);
  const result = spawnSync(command, commandArgs, {
    cwd: snapshot,
    encoding: 'utf8',
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? '') + (result.error?.message ?? ''));
  const passed = result.status === 0;
  failure ||= !passed;
  report.checks.push({ name, passed, exit: result.status, log });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${log}`);
}
try {
  git(root, 'clone', '--shared', '--no-checkout', '--quiet', root, snapshot);
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
  const diff = git(snapshot, 'diff', '--cached', '--unified=0', base);
  const bin = (name) => join(root, 'node_modules', '.bin', name);
  run(
    'fallow',
    bin('fallow'),
    ['audit', '--base', base, '--gate', 'new-only', '--diff-stdin', '--format', 'json'],
    diff
  );
  if (!auditOnly) {
    const changed = git(snapshot, 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', base)
      .split('\0')
      .filter(Boolean);
    if (changed.length) run('format-changed', bin('prettier'), ['--check', '--ignore-unknown', ...changed]);
    run('factory', process.execPath, ['--test', 'scripts/factory.check.mjs', 'scripts/verify.check.mjs']);
    run('typecheck', bin('tsc'), ['--noEmit']);
    run('tests', bin('vitest'), ['run']);
    run('build', 'npm', ['run', 'build']);
  }
} catch (error) {
  failure = true;
  report.error = error.message;
  console.error(error.message);
} finally {
  writeFileSync(join(reportDir, `${stamp}-summary.json`), JSON.stringify(report, null, 2) + '\n');
  rmSync(snapshot, { recursive: true, force: true });
}
process.exitCode = failure ? 1 : 0;
