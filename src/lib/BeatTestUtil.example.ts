import { checkBeatNoteFeedback, loadTestBeat, BeatTestEvents } from './BeatTestUtil';
import { PerformanceFeedback } from './PerformanceFeedback';
import { createTestBeat } from './BeatTestUtil';

/**
 * Example of how to use BeatTestUtil to test BeatRecorder functionality
 */
export async function exampleUsage() {
  // 1. Create the 'Test' beat. We always use the same beat.
  const beat = createTestBeat('test-module');

  // 2. Define expected events from a performance
  const expectedEvents: BeatTestEvents = {
    playedNotes: [
      { noteString: 'kick', microtiming: 5 }, // Played 5ms late
      { noteString: 'snare', microtiming: -2 }, // Played 2ms early
      { noteString: 'kick', microtiming: 0 }, // Played on time
    ],
    missedNotes: [
      { index: 3 }, // Missed the last snare
    ],
    extraNotes: [
      { index: 1, microtiming: 10, actualTime: 1250, noteString: 'hihat' }, // Extra hihat
    ],
  };

  // 3. Simulate the actual performance feedback from BeatRecorder
  // (This would normally come from BeatRecorder.performanceFeedback)
  const actualPerformanceFeedback = new PerformanceFeedback([
    // This would be populated by BeatRecorder during recording
  ]);

  // 4. Validate the performance
  const result = checkBeatNoteFeedback(beat, actualPerformanceFeedback, expectedEvents);

  if (result.success) {
    console.log('✅ Performance matches expectations');
  } else {
    console.log('❌ Performance validation failed:');
    result.errors.forEach((error) => console.log(`  - ${error}`));
  }

  return result;
}

/**
 * Example of testing a specific scenario
 */
export function testBasicBeat() {
  const beat = createTestBeat('test-module');

  const expectedEvents: BeatTestEvents = {
    playedNotes: [
      { noteString: 'kick', microtiming: 0 },
      { noteString: 'snare', microtiming: 0 },
    ],
    missedNotes: [],
    extraNotes: [],
  };

  // This would be the actual feedback from BeatRecorder
  const performanceFeedback = new PerformanceFeedback([]);

  return checkBeatNoteFeedback(beat, performanceFeedback, expectedEvents);
}
