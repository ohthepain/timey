import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, writeJson } from './common.mjs';
import { githubCheckRuns } from './flow-ci-evidence.mjs';

const now = () => new Date().toISOString();

function elapsed(startedAt, finishedAt) {
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return duration >= 0 ? duration : null;
}

function timed(interval) {
  const { startedAt = null, finishedAt = null } = interval;
  const elapsedMs = elapsed(startedAt, finishedAt);
  return {
    ...interval,
    startedAt,
    finishedAt,
    elapsedMs,
    ...(elapsedMs === null && {
      unknown: startedAt && finishedAt ? 'timestamps out of order' : 'missing start or finish timestamp',
    }),
  };
}

function unknownGaps(startedAt, finishedAt, intervals) {
  let cursor = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  const gaps = [];
  const window = intervals
    .map((interval) => [
      Math.max(cursor, Date.parse(interval.startedAt)),
      Math.min(end, Date.parse(interval.finishedAt)),
    ])
    .filter(([start, finish]) => start < finish)
    .sort(([a], [b]) => a - b);
  for (const [start, finish] of window) {
    if (cursor < start) gaps.push([cursor, start]);
    cursor = Math.max(cursor, finish);
  }
  if (cursor < end) gaps.push([cursor, end]);
  return gaps.map(([start, finish]) =>
    timed({
      phase: 'unattributed',
      startedAt: new Date(start).toISOString(),
      finishedAt: new Date(finish).toISOString(),
      unknown: 'no complete phase observation covers this time',
    })
  );
}

export function summarizeMergeTiming({ attemptId, startedAt, finishedAt, intervals }) {
  const phases = intervals.map(timed);
  const elapsedMs = elapsed(startedAt, finishedAt);
  const gaps = elapsedMs === null ? [] : unknownGaps(startedAt, finishedAt, phases);
  const unclassifiedMs = elapsedMs === null ? null : gaps.reduce((total, gap) => total + gap.elapsedMs, 0);
  return {
    attemptId,
    startedAt,
    finishedAt,
    elapsedMs,
    coveredMs: elapsedMs === null ? null : elapsedMs - unclassifiedMs,
    unclassifiedMs,
    intervals: [...phases, ...gaps].sort((a, b) => String(a.startedAt ?? '').localeCompare(b.startedAt ?? '')),
  };
}

function observedJob(repository, check) {
  const { status, workflowRun = {} } = check.checkSuite ?? {};
  const [github = {}] = githubCheckRuns(repository, [check]);
  const { runAttempt = null, createdAt } = workflowRun ?? {};
  return {
    runId: github.runId,
    runAttempt,
    queuedAt: runAttempt === 1 ? createdAt : null,
    startedAt: check.startedAt,
    finishedAt: check.completedAt,
    status,
  };
}

function ciIntervals({ jobs, queuedAt, status, ...identity }) {
  const startedAt = jobs
    .map(({ startedAt }) => startedAt)
    .filter(Boolean)
    .sort()[0];
  const completions = jobs
    .map(({ finishedAt }) => finishedAt)
    .filter(Boolean)
    .sort();
  const finishedAt = status === 'COMPLETED' && completions.length === jobs.length ? completions.at(-1) : null;
  return [
    { ...identity, phase: 'ci-queue', startedAt: queuedAt, finishedAt: startedAt },
    { ...identity, phase: 'ci-execution', startedAt, finishedAt },
  ];
}

export function mergeTiming(folder, attempt, repository) {
  const startedAt = attempt.startedAt ?? now();
  const intervals = [];
  const runs = new Map();
  return {
    record(phase, interval) {
      intervals.push({ phase, ...interval });
    },
    checks(revision, checks = []) {
      const observed = checks.map((check) => observedJob(repository, check)).filter(({ runId }) => runId != null);
      const current = Map.groupBy(observed, ({ runId, runAttempt }) => JSON.stringify([revision, runId, runAttempt]));
      for (const [key, jobs] of current) {
        const { runId, runAttempt, queuedAt, status } = jobs[0];
        runs.set(key, { revision, runId: String(runId), runAttempt, queuedAt, status, jobs });
      }
    },
    evidence() {
      const path = join(folder, 'merge-timing.json');
      const summary = summarizeMergeTiming({
        attemptId: attempt.id,
        startedAt,
        finishedAt: now(),
        intervals: [...intervals, ...[...runs.values()].flatMap(ciIntervals)],
      });
      writeJson(path, summary);
      return { key: 'mergeTiming', label: 'Merge timing', path, sha256: digest(readFileSync(path)) };
    },
  };
}
