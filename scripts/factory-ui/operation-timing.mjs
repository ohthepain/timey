const activeStatuses = new Set(['preparing', 'running', 'checking']);

export function startOperationTiming(run, at = run.created) {
  run.timing = {
    version: 1,
    totalMs: 0,
    operationMs: 0,
    phase: run.status,
    phaseStartedAt: at,
    endedAt: null,
  };
}

export function advanceOperationTiming(run, status, at) {
  const timing = run.timing;
  if (!timingSupportsStatus(timing, status)) return;

  const elapsed = elapsedBetween(timing.phaseStartedAt, at);
  finishPhase(timing, status, at, elapsed);
}

function finishPhase(timing, status, at, elapsed) {
  timing.totalMs += elapsed;
  if (activeStatuses.has(status)) {
    timing.operationMs = 0;
    timing.phase = status;
    timing.phaseStartedAt = at;
    timing.endedAt = null;
    return;
  }
  timing.operationMs = elapsed;
  timing.phase = status;
  timing.phaseStartedAt = null;
  timing.endedAt = at;
}

function timingSupportsStatus(timing, status) {
  return Boolean(timing && timing.version === 1 && status !== timing.phase);
}

function elapsedBetween(start, end) {
  const endMs = Date.parse(end);
  const startMs = Date.parse(start || '');
  if (!Number.isFinite(endMs) || !Number.isFinite(startMs)) return 0;
  return Math.max(0, endMs - startMs);
}
