import { Beat } from '~/types/Beat';
import { BeatNote } from '~/types/BeatNote';
import { PerformanceFeedback } from './PerformanceFeedback';
import { beatRepository } from '~/repositories/beatRepository';
import { ParseBeatSource, ParseBeatString } from '~/lib/ParseBeat';
import { BeatSource } from '~/types/BarSource';

export interface PlayedNoteEvent {
  noteString: string;
  microtiming: number; // in msec
  velocity?: number;
}

export interface MissedNoteEvent {
  index: number; // index into the original beat that identifies the beatnote
}

export interface ExtraNoteEvent {
  index: number; // index into the original beat that identifies the beatnote
  microtiming: number; // in msec
  actualTime: number; // in msec
  noteString: string;
}

export interface BeatTestEvents {
  playedNotes: PlayedNoteEvent[];
  missedNotes: MissedNoteEvent[];
  extraNotes: ExtraNoteEvent[];
}

/**
 * Test utility to check if performance feedback matches expected events
 * Assumes 120 bpm, 4/4 time signature
 */
export function checkBeatNoteFeedback(
  beat: Beat,
  performanceFeedback: PerformanceFeedback,
  expectedEvents: BeatTestEvents
): { success: boolean; errors: string[] } {
  const errors: string[] = [];
  const bpm = 120;
  const beatsPerBar = 4;

  // Check played notes
  for (const expectedPlayed of expectedEvents.playedNotes) {
    const found = performanceFeedback.beatNoteFeedback.find((feedback) => {
      return (
        feedback.performanceNote?.noteString === expectedPlayed.noteString &&
        Math.abs((feedback.performanceNote?.microtiming || 0) - expectedPlayed.microtiming) < 1
      ); // 1ms tolerance
    });

    if (!found) {
      errors.push(
        `Expected played note not found: ${expectedPlayed.noteString} with microtiming ${expectedPlayed.microtiming}ms`
      );
    }
  }

  // Check missed notes
  for (const expectedMissed of expectedEvents.missedNotes) {
    const found = performanceFeedback.beatNoteFeedback.find((feedback) => {
      return feedback.index === expectedMissed.index && feedback.missedNotes && feedback.missedNotes.length > 0;
    });

    if (!found) {
      errors.push(`Expected missed note not found for beat index ${expectedMissed.index}`);
    }
  }

  // Check extra notes (these should not be in beatNoteFeedback as they're recorded separately)
  // Extra notes are typically recorded in the event recorder, not in beatNoteFeedback
  // So we just verify they're not incorrectly matched
  for (const expectedExtra of expectedEvents.extraNotes) {
    const incorrectlyMatched = performanceFeedback.beatNoteFeedback.find((feedback) => {
      return (
        feedback.index === expectedExtra.index && feedback.performanceNote?.noteString === expectedExtra.noteString
      );
    });

    if (incorrectlyMatched) {
      errors.push(`Extra note incorrectly matched: ${expectedExtra.noteString} at index ${expectedExtra.index}`);
    }
  }

  // Check that all feedback entries correspond to expected events
  for (const feedback of performanceFeedback.beatNoteFeedback) {
    if (feedback.performanceNote) {
      // This should be a played note
      const expectedPlayed = expectedEvents.playedNotes.find(
        (played) =>
          played.noteString === feedback.performanceNote!.noteString &&
          Math.abs((feedback.performanceNote!.microtiming || 0) - played.microtiming) < 1
      );

      if (!expectedPlayed) {
        errors.push(
          `Unexpected played note in feedback: ${feedback.performanceNote.noteString} at index ${feedback.index}`
        );
      }
    } else if (feedback.missedNotes && feedback.missedNotes.length > 0) {
      // This should be a missed note
      const expectedMissed = expectedEvents.missedNotes.find((missed) => missed.index === feedback.index);

      if (!expectedMissed) {
        errors.push(`Unexpected missed note in feedback at index ${feedback.index}`);
      }
    }
  }

  return {
    success: errors.length === 0,
    errors,
  };
}

/**
 * Helper function to load the 'Test' beat from the database
 */
export async function loadTestBeat(): Promise<Beat | null> {
  return await beatRepository.getBeatByName('Test Beat');
}

/**
 * Helper function to create a test beat using the same pattern as setup.ts
 */
export function createTestBeat(moduleId: string = 'test-module'): Beat {
  const beatSource = new BeatSource([
    {
      kick: 'k,,,,k,,,',
      hihat: 'h,h,h,h,h,h,h,h',
      snare: ',,s,,,,s,',
      accent: 'a,,a,,a,,a,',
    },
  ]);

  const beatString = ParseBeatSource(beatSource);
  const { beatNotes } = ParseBeatString(beatString);
  const testBeat = new Beat({
    id: 'testBeat',
    name: 'testBeat',
    index: 0,
    authorId: '',
    createdAt: new Date(),
    modifiedAt: new Date(),
    beatNotes: beatNotes,
    description: '',
    moduleId: moduleId,
  });
  return testBeat;
}
