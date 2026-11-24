const suiteExtensionMs = 5 * 60 * 1000;
const hardWaitMs = 30 * 60 * 1000;

export function startMergeWait(head, initialMs, now = Date.now) {
  const startedAt = now();
  return {
    head,
    now,
    initialDeadline: startedAt + initialMs,
    cap: startedAt + hardWaitMs,
    completed: new Set(),
    finalPoll: false,
  };
}

function recordCompletions(wait, progress) {
  if (progress?.head !== wait.head) return;
  for (const suite of progress.completedSuites) wait.completed.add(suite);
}

export function observeMergeWait(wait, progress) {
  recordCompletions(wait, progress);
  const deadline = Math.min(wait.initialDeadline + wait.completed.size * suiteExtensionMs, wait.cap);
  const remaining = deadline - wait.now();
  if (remaining > 0) {
    wait.finalPoll = false;
    return { kind: 'wait', remaining };
  }
  if (wait.finalPoll) return { kind: 'timeout' };
  wait.finalPoll = true;
  return { kind: 'refresh' };
}
