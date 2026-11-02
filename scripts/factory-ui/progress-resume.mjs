import { nextProgress } from './next-action.mjs';
import { resumableProgressKinds } from './lifecycle-progress-kinds.mjs';

export function resumeProgressAllowed(queue, issue, runs, record, basis) {
  const choice = nextProgress(queue, issue, runs);
  const attempt = `${basis}:${choice.kind}`;
  return resumableProgressKinds.includes(choice.kind) && !record.attempts.includes(attempt);
}
