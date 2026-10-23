import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { checkBeatNoteFeedback, BeatTestEvents, createTestBeat } from './BeatTestUtil';
import { PerformanceFeedback, BeatNoteFeedback } from './PerformanceFeedback';
import { BeatNote } from '~/types/BeatNote';
import { Beat } from '~/types/Beat';
import { BeatRecorder } from './BeatRecorder';
import { EventRecorderService } from './EventRecorderService';
import { TempoService } from './TempoService';
import { Performance } from '~/types/Performance';

describe('BeatTestUtil', () => {
  let eventRecorder: EventRecorderService;
  let tempoService: TempoService;
  let beatRecorder: BeatRecorder;
  let beat: Beat;

  beforeAll(async () => {
    // Try to load the 'Test' beat from the database
    try {
      // EventRecorderService.shutdown();
      // TempoService.shutdown();
      // BeatRecorder.shutdown();
      eventRecorder = EventRecorderService.getInstance();
      eventRecorder.clear();
      tempoService = TempoService.getInstance();
      tempoService.reset();
      tempoService.startSimulatedIntervalTimerForTesting();
      tempoService.bpm = 120; // Set a standard BPM for testing
      beatRecorder = BeatRecorder.getInstance();

      // Create a test beat since database isn't available in test environment
      beat = createTestBeat('test-module');
    } catch (error) {
      console.error('Error setting up test beat:', error);
      throw error;
    }
  });

  beforeEach(async () => {
    // Reset the beat recorder
    beatRecorder.performance = new Performance({ beatId: beat.id, index: 0 });
    beatRecorder.performanceFeedback = new PerformanceFeedback([]);

    // Reset the recorder state
    beatRecorder.setBeat(beat);
    tempoService.record();
  });

  afterEach(() => {
    // Clean up after each test
    tempoService.reset();
    eventRecorder.clear();
    beatRecorder.stop();
  });

  afterAll(() => {
    // Ensure proper cleanup to prevent module teardown issues
    try {
      tempoService.reset();
      eventRecorder.clear();
      beatRecorder.stop();
    } catch (error) {
      // Ignore cleanup errors during teardown
      console.log('Cleanup error (expected during teardown):', error instanceof Error ? error.message : String(error));
    }
  });

  it('should validate correct performance feedback', () => {
    // Create expected events
    const expectedEvents: BeatTestEvents = {
      playedNotes: [
        { noteString: 'kick', microtiming: 5 }, // played slightly late
        { noteString: 'snare', microtiming: -2 }, // played slightly early
        { noteString: 'kick', microtiming: 0 }, // played on time
      ],
      missedNotes: [
        { index: 3 }, // missed the last snare
      ],
      extraNotes: [
        { index: 1, microtiming: 10, actualTime: 1250, noteString: 'hihat' }, // extra hihat
      ],
    };

    // Create performance feedback that matches expected events
    const performanceFeedback = new PerformanceFeedback([
      new BeatNoteFeedback({
        beat,
        index: 0,
        beatNote: beat.beatNotes[0],
        performanceNote: new BeatNote({
          id: 'test-1',
          index: 0,
          noteString: 'kick',
          barNum: 0,
          beatNum: 0,
          divisionNum: 0,
          subDivisionNum: 0,
          numSubDivisions: 2,
          velocity: 100,
          microtiming: 5,
          duration: 0,
        }),
        timingDifferenceMs: 5,
        velocityDifference: 0,
      }),
      new BeatNoteFeedback({
        beat,
        index: 1,
        beatNote: beat.beatNotes[1],
        performanceNote: new BeatNote({
          id: 'test-2',
          index: 1,
          noteString: 'snare',
          barNum: 0,
          beatNum: 1,
          divisionNum: 0,
          subDivisionNum: 0,
          numSubDivisions: 2,
          velocity: 100,
          microtiming: -2,
          duration: 0,
        }),
        timingDifferenceMs: -2,
        velocityDifference: 0,
      }),
      new BeatNoteFeedback({
        beat,
        index: 2,
        beatNote: beat.beatNotes[2],
        performanceNote: new BeatNote({
          id: 'test-3',
          index: 2,
          noteString: 'kick',
          barNum: 0,
          beatNum: 2,
          divisionNum: 0,
          subDivisionNum: 0,
          numSubDivisions: 2,
          velocity: 100,
          microtiming: 0,
          duration: 0,
        }),
        timingDifferenceMs: 0,
        velocityDifference: 0,
      }),
      new BeatNoteFeedback({
        beat,
        index: 3,
        beatNote: beat.beatNotes[3],
        performanceNote: null,
        timingDifferenceMs: null,
        velocityDifference: null,
        missedNotes: ['snare'],
      }),
    ]);

    // Test the validation
    const result = checkBeatNoteFeedback(beat, performanceFeedback, expectedEvents);

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('should detect missing played notes', () => {
    // Use a simple 2-note beat for this test
    const expectedEvents: BeatTestEvents = {
      playedNotes: [
        { noteString: 'kick', microtiming: 0 },
        { noteString: 'snare', microtiming: 0 },
      ],
      missedNotes: [],
      extraNotes: [],
    };

    // Create performance feedback missing the snare
    const performanceFeedback = new PerformanceFeedback([
      new BeatNoteFeedback({
        beat,
        index: 0,
        beatNote: beat.beatNotes[0],
        performanceNote: new BeatNote({
          id: 'test-1',
          index: 0,
          noteString: 'kick',
          barNum: 0,
          beatNum: 0,
          divisionNum: 0,
          subDivisionNum: 0,
          numSubDivisions: 2,
          velocity: 100,
          microtiming: 0,
          duration: 0,
        }),
        timingDifferenceMs: 0,
        velocityDifference: 0,
      }),
    ]);

    const result = checkBeatNoteFeedback(beat, performanceFeedback, expectedEvents);

    expect(result.success).toBe(false);
    expect(result.errors).toContain('Expected played note not found: snare with microtiming 0ms');
  });

  it('should detect missing missed notes', () => {
    const expectedEvents: BeatTestEvents = {
      playedNotes: [{ noteString: 'kick', microtiming: 0 }],
      missedNotes: [{ index: 1 }],
      extraNotes: [],
    };

    // Create performance feedback without the missed note
    const performanceFeedback = new PerformanceFeedback([
      new BeatNoteFeedback({
        beat,
        index: 0,
        beatNote: beat.beatNotes[0],
        performanceNote: new BeatNote({
          id: 'test-1',
          index: 0,
          noteString: 'kick',
          barNum: 0,
          beatNum: 0,
          divisionNum: 0,
          subDivisionNum: 0,
          numSubDivisions: 2,
          velocity: 100,
          microtiming: 0,
          duration: 0,
        }),
        timingDifferenceMs: 0,
        velocityDifference: 0,
      }),
    ]);

    const result = checkBeatNoteFeedback(beat, performanceFeedback, expectedEvents);

    expect(result.success).toBe(false);
    expect(result.errors).toContain('Expected missed note not found for beat index 1');
  });
});
