import { EventEmitter } from 'events';
import TempoService from '~/lib/MidiSync/TempoService';
import { midiService } from './MidiService';
import { Beat } from '~/types/Beat';
import type { BeatNote } from '~/types/BeatNote';
import type { Performance } from '~/types/Performance';
import { beatPlayer } from './BeatPlayer';

export interface BeatNoteFeedback {
  beat: Beat;
  index: number;
  beatNote: BeatNote | null;
  performanceNote: BeatNote | null;
  timingDifferenceMs: number | null;
  velocityDifference: number | null;
}

class GrooveMonitor extends EventEmitter {
  getBeatNoteFeedback(beat: Beat, index: number, performance: Performance): BeatNoteFeedback {
    const beatNote = beat.beatNotes.find((n) => n.index === index);
    if (!beatNote) {
      return {
        beat,
        index,
        beatNote: null,
        performanceNote: null,
        timingDifferenceMs: null,
        velocityDifference: null,
      };
    }

    function isDrumEquivalent(a: string, b: string) {
      if (a === b) return true;
      const hihatSet = new Set(['hihat', 'hihat-open', 'hihat-closed', 'hihat-pedal', '42', '44', '46']);
      return hihatSet.has(a) && hihatSet.has(b);
    }

    const candidates = performance.notes.filter(
      (n) => n.index === index && isDrumEquivalent(n.noteString, beatNote.noteString)
    );
    let performanceNote: BeatNote | null = null;
    let timingDifferenceMs: number | null = null;
    let velocityDifference: number | null = null;
    if (candidates.length > 0) {
      // If multiple, pick the one with the smallest timing difference
      performanceNote = candidates.reduce((prev, curr) => {
        const prevDiff = Math.abs(prev.microtiming || 0);
        const currDiff = Math.abs(curr.microtiming || 0);
        return currDiff < prevDiff ? curr : prev;
      });
      timingDifferenceMs = (performanceNote.microtiming || 0) - (beatNote.microtiming || 0);
      velocityDifference = (performanceNote.velocity || 0) - (beatNote.velocity || 0);
    } else {
      // If no note with the same index and drum, find the closest in time with drum equivalence
      const drumCandidates = performance.notes.filter((n) => isDrumEquivalent(n.noteString, beatNote.noteString));
      if (drumCandidates.length > 0) {
        performanceNote = drumCandidates.reduce((prev, curr) => {
          const prevDiff = Math.abs((prev.microtiming || 0) - (beatNote.microtiming || 0));
          const currDiff = Math.abs((curr.microtiming || 0) - (beatNote.microtiming || 0));
          return currDiff < prevDiff ? curr : prev;
        }, drumCandidates[0]);
        timingDifferenceMs = (performanceNote.microtiming || 0) - (beatNote.microtiming || 0);
        velocityDifference = (performanceNote.velocity || 0) - (beatNote.velocity || 0);
      }
    }
    return {
      beat,
      index,
      beatNote,
      performanceNote,
      timingDifferenceMs,
      velocityDifference,
    };
  }
}

export const grooveMonitor = new GrooveMonitor();
