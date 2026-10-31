import { PerformanceFeedback } from './PerformanceFeedback';
import { createTestBeat } from '~/lib/createTestBeat';
import {
  collectExtraNoteErrors,
  collectMissedNoteErrors,
  collectPlayedNoteErrors,
  collectUnexpectedFeedbackErrors,
  type BeatTestEvents,
} from '~/lib/beatTestFeedbackChecks';

export { createTestBeat };
export type { BeatTestEvents } from '~/lib/beatTestFeedbackChecks';

/**
 * Test utility to check if performance feedback matches expected events
 * Assumes 120 bpm, 4/4 time signature
 */
export function checkBeatNoteFeedback(
  _beat: unknown,
  performanceFeedback: PerformanceFeedback,
  expectedEvents: BeatTestEvents
): { success: boolean; errors: string[] } {
  const errors = [
    ...collectPlayedNoteErrors(performanceFeedback, expectedEvents),
    ...collectMissedNoteErrors(performanceFeedback, expectedEvents),
    ...collectExtraNoteErrors(performanceFeedback, expectedEvents),
    ...collectUnexpectedFeedbackErrors(performanceFeedback, expectedEvents),
  ];
  return { success: errors.length === 0, errors };
}
