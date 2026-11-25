import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

const heapError = 'JavaScript heap out of memory';
const reportDirectory = (root) => join(root, '.issues', 'factory-ui', 'node-crashes');
export const factoryReportFlags = ['--report-exclude-env', '--report-exclude-network'];

export function recordFactoryFatalErrors(root) {
  // The fatal path can ignore these exclusions if set through process.report at runtime.
  if (!factoryReportFlags.every((flag) => process.execArgv.includes(flag))) return;
  const directory = reportDirectory(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  process.report.directory = directory;
  process.report.reportOnFatalError = true;
}

function readHeapReport(path) {
  try {
    const { header } = JSON.parse(readFileSync(path, 'utf8'));
    if (header.trigger === 'OOMError' && header.event.includes(heapError))
      return { path, pid: header.processId, time: new Date(Number(header.dumpEventTimeStamp)).toISOString() };
  } catch {
    // A fatal process can leave an incomplete report. Continue to older evidence.
  }
}

function filenames(directory, pattern) {
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => pattern.test(name))
        .sort()
        .reverse()
    : [];
}

function fatalHeapLine(path) {
  const fd = openSync(path, 'r');
  try {
    const { size, mtime } = fstatSync(fd);
    const buffer = Buffer.alloc(Math.min(size, 65536));
    const bytes = readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    if (/^FATAL ERROR: .*JavaScript heap out of memory\s*$/m.test(buffer.toString('utf8', 0, bytes)))
      return { path, logUpdatedAt: mtime.toISOString() };
  } finally {
    closeSync(fd);
  }
}

function savedHeapCrash(root) {
  const directory = reportDirectory(root);
  for (const name of filenames(directory, /^report\.[\d.]+\.json$/)) {
    const report = readHeapReport(join(directory, name));
    if (report) return report;
  }
}

export function latestFactoryHeapCrash(root) {
  const directory = join(root, '.issues', 'evidence');
  const logs = filenames(directory, /^(restart-.*\.json|factory-outage-recovery-\d+)\.log$/).map((name) =>
    join(directory, name)
  );
  const uiLog = join(root, '.issues', 'factory-ui', 'server-restart.log');
  if (existsSync(uiLog)) logs.push(uiLog);
  return (
    savedHeapCrash(root) ??
    logs
      .map(fatalHeapLine)
      .filter(Boolean)
      .sort((a, b) => b.logUpdatedAt.localeCompare(a.logUpdatedAt))[0]
  );
}
