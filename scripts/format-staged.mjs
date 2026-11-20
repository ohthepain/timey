import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function ignoredForFormat(root, file) {
  const patterns = readFileSync(join(root, '.prettierignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return patterns.some((pattern) => {
    const normalized = pattern.replace(/^\*\*\//, '').replace(/^\//, '');
    if (pattern.startsWith('**/')) return file.endsWith(normalized) || file.includes('/' + normalized);
    return file === normalized || file.endsWith('/' + normalized);
  });
}

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
  cwd: root,
  encoding: 'buffer',
})
  .toString()
  .split('\0')
  .filter(Boolean);

const formatTargets = files.filter((file) => !ignoredForFormat(root, file));
if (formatTargets.length === 0) process.exit(0);

const isIssueReport = (file) => /^\.issues\/(?:(?:closed|archive)\/)?\d[\w-]*\.md$/.test(file);
const formatter = join(root, 'node_modules', '.bin', 'vp');

function format(mode, snapshots) {
  if (!snapshots.length) return 0;
  const result = spawnSync(
    formatter,
    ['fmt', mode, '--no-error-on-unmatched-pattern', ...snapshots.map(({ path }) => path)],
    {
      cwd: root,
      stdio: 'inherit',
    }
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function formattedReport({ file, path, content }) {
  const formatted = readFileSync(path);
  if (content.equals(formatted)) return null;
  const entry = execFileSync('git', ['ls-files', '--stage', '--', file], { cwd: root, encoding: 'utf8' });
  const match = /^(100(?:644|755)) ([\da-f]+) 0\t/.exec(entry);
  if (!match || !content.equals(readIndexBlob(match[2]))) throw Error('Staged issue report changed: ' + file);
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: formatted, encoding: 'utf8' });
  return { file, content, formatted, indexEntry: match[1] + ' ' + oid.trim() + '\t' + file + '\0' };
}

function readIndexBlob(oid) {
  return execFileSync('git', ['cat-file', 'blob', oid], { cwd: root });
}

function saveFormattedReports(snapshots) {
  const reports = snapshots.map(formattedReport).filter(Boolean);
  if (!reports.length) return;
  const input = reports.map(({ indexEntry }) => indexEntry).join('');
  execFileSync('git', ['update-index', '-z', '--index-info'], { cwd: root, input });
  reports.forEach(updateMatchingWorkingReport);
}

function updateMatchingWorkingReport({ file, content, formatted }) {
  const path = join(root, file);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return;
  if (realpathSync(path) !== path) return;
  if (content.equals(readFileSync(path))) writeFileSync(path, formatted);
}

// Keep snapshot paths inside the checkout. The formatter excludes files outside
// its project root, which made staged issue reports fail or escape formatting.
const snapshotId = randomUUID();
const snapshotFiles = [];
try {
  const stagedFiles = formatTargets.map((file, index) => {
    const destination = join(root, `.timey-format-staged-${snapshotId}-${index}-${file.split('/').at(-1)}`);
    const content = execFileSync('git', ['show', `:${file}`], { cwd: root });
    writeFileSync(destination, content);
    snapshotFiles.push(destination);
    return { file, path: destination, content };
  });
  const reports = stagedFiles.filter(({ file }) => isIssueReport(file));
  process.exitCode =
    format(
      '--check',
      stagedFiles.filter(({ file }) => !isIssueReport(file))
    ) || format('--write', reports);
  if (process.exitCode === 0) saveFormattedReports(reports);
} finally {
  for (const file of snapshotFiles) rmSync(file, { force: true });
}
