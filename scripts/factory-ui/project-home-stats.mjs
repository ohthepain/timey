import { FileReadCache } from './file-read-cache.mjs';
import { basename } from 'node:path';
import { parse } from 'yaml';
import { listStoredIssues } from './issue-report-storage.mjs';

const reportCaches = new Map();

function reportContent(content, path) {
  const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!header) throw Error('The issue report ' + basename(path) + ' needs valid metadata.');
  return { ...parse(header), content };
}

export function projectIssueRecords(root) {
  let cache = reportCaches.get(root);
  if (!cache) {
    cache = new FileReadCache(reportContent, 8 * 1024 * 1024);
    reportCaches.set(root, cache);
    while (reportCaches.size > 4) reportCaches.delete(reportCaches.keys().next().value);
  }
  const paths = ['open', 'closed', 'archive'].flatMap((location) =>
    listStoredIssues(root, location).map((path) => ({ path, location }))
  );
  cache.retain(paths.map(({ path }) => path));
  return paths.map(({ path, location }) => ({ ...cache.read(path), id: basename(path, '.md'), location }));
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

export function projectHomeStats(root, now = new Date(), historySince = null) {
  const windowEnd = new Date(now).toISOString();
  const end = timestamp(windowEnd);
  const start = end - 7 * 24 * 60 * 60 * 1000;
  const reports = projectIssueRecords(root);
  const within = (value) => {
    const time = timestamp(value);
    return time !== null && time >= start && time <= end;
  };
  const closedIds = new Set();
  const coverage = timestamp(historySince);
  const incompleteHistory = coverage === null || coverage > start;
  for (const report of reports) {
    const history = Array.isArray(report.closure_history) ? report.closure_history : [];
    if ([...history, report.closure].some((entry) => entry && within(entry.at))) closedIds.add(report.id);
  }
  return {
    created: new Set(reports.filter((report) => within(report.created)).map(({ id }) => id)).size,
    closed: closedIds.size,
    total: new Set(reports.map(({ id }) => id)).size,
    windowStart: new Date(start).toISOString(),
    windowEnd,
    incompleteHistory,
    historyNote: incompleteHistory ? 'Older closure history may be incomplete. Known closures are shown.' : '',
  };
}
