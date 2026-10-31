import type { PerformanceFeedback } from './PerformanceFeedback';

export interface PlayedNoteEvent {
  noteString: string;
  microtiming: number;
  velocity?: number;
}

export interface MissedNoteEvent {
  index: number;
}

export interface ExtraNoteEvent {
  index: number;
  microtiming: number;
  actualTime: number;
  noteString: string;
}

export interface BeatTestEvents {
  playedNotes: PlayedNoteEvent[];
  missedNotes: MissedNoteEvent[];
  extraNotes: ExtraNoteEvent[];
}

const TIMING_TOLERANCE_MS = 1;

function matchesPlayedNote(
  feedback: PerformanceFeedback['beatNoteFeedback'][number],
  expected: { noteString: string; microtiming: number }
) {
  return (
    feedback.performanceNote?.noteString === expected.noteString &&
    Math.abs((feedback.performanceNote?.microtiming || 0) - expected.microtiming) < TIMING_TOLERANCE_MS
  );
}

export function collectPlayedNoteErrors(feedback: PerformanceFeedback, expectedEvents: BeatTestEvents): string[] {
  const errors: string[] = [];
  for (const expected of expectedEvents.playedNotes) {
    const found = feedback.beatNoteFeedback.some((entry) => matchesPlayedNote(entry, expected));
    if (!found) {
      errors.push(`Expected played note not found: ${expected.noteString} with microtiming ${expected.microtiming}ms`);
    }
  }
  return errors;
}

export function collectMissedNoteErrors(feedback: PerformanceFeedback, expectedEvents: BeatTestEvents): string[] {
  const errors: string[] = [];
  for (const expected of expectedEvents.missedNotes) {
    const found = feedback.beatNoteFeedback.some(
      (entry) => entry.index === expected.index && entry.missedNotes && entry.missedNotes.length > 0
    );
    if (!found) errors.push(`Expected missed note not found for beat index ${expected.index}`);
  }
  return errors;
}

export function collectExtraNoteErrors(feedback: PerformanceFeedback, expectedEvents: BeatTestEvents): string[] {
  const errors: string[] = [];
  for (const expected of expectedEvents.extraNotes) {
    const incorrectlyMatched = feedback.beatNoteFeedback.some(
      (entry) => entry.index === expected.index && entry.performanceNote?.noteString === expected.noteString
    );
    if (incorrectlyMatched) {
      errors.push(`Extra note incorrectly matched: ${expected.noteString} at index ${expected.index}`);
    }
  }
  return errors;
}

export function collectUnexpectedFeedbackErrors(
  feedback: PerformanceFeedback,
  expectedEvents: BeatTestEvents
): string[] {
  const errors: string[] = [];
  for (const entry of feedback.beatNoteFeedback) {
    if (entry.performanceNote) {
      const expected = expectedEvents.playedNotes.find((played) => matchesPlayedNote(entry, played));
      if (!expected) {
        errors.push(`Unexpected played note in feedback: ${entry.performanceNote.noteString} at index ${entry.index}`);
      }
      continue;
    }
    if (entry.missedNotes?.length) {
      const expected = expectedEvents.missedNotes.some((missed) => missed.index === entry.index);
      if (!expected) errors.push(`Unexpected missed note in feedback at index ${entry.index}`);
    }
  }
  return errors;
}
