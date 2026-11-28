import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { digest } from './factory-ui/common.mjs';
import { mergeTiming, summarizeMergeTiming } from './factory-ui/flow-merge-timing.mjs';

test('PR #146 wall time reconciles with overlapping and missing phase timestamps', () => {
  const { elapsedMs, coveredMs, unclassifiedMs, intervals } = summarizeMergeTiming({
    attemptId: '688ab0d3-ba66-4162-bb69-e5f3181c9b50',
    startedAt: '2026-11-27T12:15:54.391Z',
    finishedAt: '2026-11-27T13:22:45.138Z',
    intervals: [
      { phase: 'repair', startedAt: '2026-11-27T12:24:42.986Z', finishedAt: '2026-11-27T12:32:01.680Z' },
      { phase: 'repair', startedAt: '2026-11-27T12:44:51.900Z', finishedAt: '2026-11-27T12:50:16.146Z' },
      { phase: 'repair', startedAt: '2026-11-27T13:03:21.967Z', finishedAt: '2026-11-27T13:09:27.588Z' },
      { phase: 'ci-queue', runId: '46005116928', finishedAt: '2026-11-27T13:12:36.000Z' },
      {
        phase: 'ci-observed-span',
        runId: '46005116928',
        startedAt: '2026-11-27T13:12:36.000Z',
        finishedAt: '2026-11-27T13:21:37.638Z',
      },
      {
        phase: 'required-check-pending',
        startedAt: '2026-11-27T13:21:26.561Z',
        finishedAt: '2026-11-27T13:21:37.638Z',
      },
    ],
  });
  assert.equal(coveredMs, 1670199);
  assert.equal(unclassifiedMs, 2340548);
  assert.equal(elapsedMs, 4010747);
  assert.equal(intervals.find(({ phase }) => phase === 'ci-queue').elapsedMs, null);
  assert.equal(intervals.find(({ phase }) => phase === 'ci-queue').unknown, 'missing start or finish timestamp');
  assert.equal(intervals.filter(({ phase }) => phase === 'unattributed').length, 5);
});

test('Merge retains CI queue and execution by candidate, workflow run and attempt', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'merge-timing-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const timing = mergeTiming(folder, { id: 'merge-attempt', startedAt: '2026-01-01T10:00:00Z' }, 'test/fixture');
  const check = {
    name: 'test',
    detailsUrl: 'https://github.com/test/fixture/actions/runs/45999924727/job/88',
    startedAt: '2026-01-01T10:00:10Z',
    completedAt: '2026-01-01T10:00:30Z',
    checkSuite: {
      status: 'COMPLETED',
      workflowRun: { runAttempt: 1, createdAt: '2026-01-01T10:00:05Z' },
    },
  };
  timing.checks('candidate-a', [check]);
  timing.checks('candidate-b', [
    { ...check, checkSuite: { ...check.checkSuite, workflowRun: { ...check.checkSuite.workflowRun, runAttempt: 2 } } },
  ]);
  const { path, sha256 } = timing.evidence();
  const bytes = readFileSync(path);
  assert.equal(digest(bytes), sha256);
  const { attemptId, intervals } = JSON.parse(bytes);
  assert.equal(attemptId, 'merge-attempt');
  const phases = intervals.filter(({ runId }) => runId === '45999924727');
  assert.deepEqual(
    phases.map(({ phase, revision, runAttempt, elapsedMs }) => [phase, revision, runAttempt, elapsedMs]),
    [
      ['ci-queue', 'candidate-b', 2, null],
      ['ci-queue', 'candidate-a', 1, 5000],
      ['ci-execution', 'candidate-a', 1, 20000],
      ['ci-execution', 'candidate-b', 2, 20000],
    ]
  );
});
