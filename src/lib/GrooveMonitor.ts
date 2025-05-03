import { EventEmitter } from 'events';
import { Beat } from '~/types/Beat';
import type { BeatNote } from '~/types/BeatNote';
import type { Performance } from '~/types/Performance';

export class PerformanceFeedback {
  beatNoteFeedback: BeatNoteFeedback[];

  constructor(beatNoteFeedback: BeatNoteFeedback[] | null) {
    this.beatNoteFeedback = beatNoteFeedback || [];
  }
}

export interface BeatNoteFeedback {
  beat: Beat;
  index: number;
  beatNote: BeatNote | null;
  performanceNote: BeatNote | null;
  timingDifferenceMs: number;
  velocityDifference: number;
}

// function getBeatLoopLengthMsec(beatNotes: BeatNote[], bpm: number): number {
//   if (!beatNotes.length) return 0;
//   // Find the max barNum in the beat
//   const maxBarNum = Math.max(...beatNotes.map((n) => n.barNum));
//   // Assume 4/4 time: 4 beats per bar
//   const beatsPerBar = 4;
//   const numBars = maxBarNum + 1;
//   const totalBeats = numBars * beatsPerBar;
//   const beatDurationMsec = 60000 / bpm;
//   return totalBeats * beatDurationMsec;
// }

export function getBeatNoteTime(beatNote: BeatNote, bpm: number): number {
  const beatsPerBar = 4;
  const divisionsPerBeat = 2; // 8th notes
  const beatDurationMsec = 60000 / bpm;
  const divisionDurationMsec = beatDurationMsec / divisionsPerBeat;

  const barTime = beatNote.barNum * beatsPerBar * beatDurationMsec;
  const beatTime = beatNote.beatNum * beatDurationMsec;
  const divisionTime = beatNote.divisionNum * divisionDurationMsec;

  let subDivisionTime = 0;
  if (beatNote.numSubDivisions > 1) {
    const subDivisionDurationMsec = divisionDurationMsec / beatNote.numSubDivisions;
    subDivisionTime = beatNote.subDivisionNum * subDivisionDurationMsec;
  }

  return barTime + beatTime + divisionTime + subDivisionTime + (beatNote.microtiming || 0);
}

/**
 * Calculates the position in the beat for a given time (in ms) at the given bpm.
 * Returns { beatNum, divisionNum, subDivisionNum, numSubDivisions }.
 * If the division contains subDivisions, subDivisionNum and numSubDivisions are set, otherwise they are undefined.
 */
// export function getBeatPosition(beatNotes: BeatNote[], bpm: number, timeMsec: number) {
//   if (!beatNotes.length) return null;
//   // Assume 4/4 time: 4 beats per bar, 2 divisions per beat (8th notes)
//   const beatsPerBar = 4;
//   const divisionsPerBeat = 2; // 8th notes
//   const beatDurationMsec = 60000 / bpm;
//   const divisionDurationMsec = beatDurationMsec / divisionsPerBeat;

//   // Get loop length and mod timeMsec
//   const loopLength = getBeatLoopLengthMsec(beatNotes, bpm);
//   const t = ((timeMsec % loopLength) + loopLength) % loopLength; // handle negative times

//   // Calculate barNum, beatNum, divisionNum
//   const totalBeats = Math.floor(t / beatDurationMsec);
//   const beatNum = totalBeats % beatsPerBar;
//   const divisionNum = Math.floor((t % beatDurationMsec) / divisionDurationMsec);

//   // Find if this division has subDivisions in the beatNotes
//   const matching = beatNotes.find((n) => n.beatNum === beatNum && n.divisionNum === divisionNum);
//   if (matching && matching.numSubDivisions > 1) {
//     // Calculate subDivisionNum
//     const subDivisionDurationMsec = divisionDurationMsec / matching.numSubDivisions;
//     const divisionStartMsec = totalBeats * beatDurationMsec + divisionNum * divisionDurationMsec;
//     const subDivisionNum = Math.floor((t - divisionStartMsec) / subDivisionDurationMsec);
//     return {
//       beatNum,
//       divisionNum,
//       subDivisionNum,
//       numSubDivisions: matching.numSubDivisions,
//     };
//   } else {
//     return {
//       beatNum,
//       divisionNum,
//     };
//   }
// }

class GrooveMonitor extends EventEmitter {
  getPerformanceFeedback(beat: Beat, performance: Performance): PerformanceFeedback {
    const feedback: BeatNoteFeedback[] = [];
    for (let i = 0; i < beat.beatNotes.length; i++) {
      const beatNoteFeedback = this.getBeatNoteFeedback(beat, i, performance);
      feedback.push(beatNoteFeedback);
    }
    return new PerformanceFeedback(feedback);
  }

  getBeatNoteFeedback(beat: Beat, index: number, performance: Performance): BeatNoteFeedback {
    const beatNote = beat.beatNotes.find((n) => n.index === index);
    if (!beatNote) {
      return {
        beat,
        index,
        beatNote: null,
        performanceNote: null,
        timingDifferenceMs: 0,
        velocityDifference: 0,
      };
    }

    function isDrumEquivalent1(a: string, b: string) {
      if (a === b) return true;
      const hihatSet = new Set(['hihat', 'hihat-open', 'hihat-closed', 'hihat-pedal', '42', '44', '46']);
      return hihatSet.has(a) && hihatSet.has(b);
    }

    const candidates = performance.notes.filter(
      (n) => n.index === index && isDrumEquivalent1(n.noteString, beatNote.noteString)
    );
    let performanceNote: BeatNote | null = null;
    let timingDifferenceMs: number = -Infinity;
    let velocityDifference: number = -Infinity;
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
      const drumCandidates = performance.notes.filter((n) => isDrumEquivalent1(n.noteString, beatNote.noteString));
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

  /**
   * Finds the closest BeatNote in the Beat to a given note (by noteString or midi note) and time in ms.
   * Returns BeatNoteFeedback if within the given tolerance (16th note duration in ms), otherwise null.
   */
  matchBeatNoteFromPerformance(
    beat: Beat,
    noteStringOrMidi: string | number,
    timeMsec: number,
    velocity: number,
    bpm: number
  ): BeatNoteFeedback | null {
    const loopLengthMsec = beat.getLoopLengthMsec(bpm);
    let isDrumEquivalent2 = (a: string, b: string) => {
      console.log('GrooveMonitor: matchBeatNoteFromPerformance isDrumEquivalent2', a, b);
      if (a === b) return true;
      const kickSet = new Set(['kick', '36', '35']);
      if (kickSet.has(a) && kickSet.has(b)) return true;
      const snareSet = new Set(['snare', '40', '38']);
      if (snareSet.has(a) && snareSet.has(b)) return true;
      const hihatSet = new Set(['hihat', 'hihat-open', 'hihat-closed', 'hihat-pedal', '42', '44', '46']);
      return hihatSet.has(a) && hihatSet.has(b);
    };
    console.log('GrooveMonitor: matchBeatNoteFromPerformance 1', noteStringOrMidi, timeMsec, velocity, bpm);
    let targetNoteString = typeof noteStringOrMidi === 'number' ? String(noteStringOrMidi) : noteStringOrMidi;
    const tolerance = 60000 / bpm; // / 4;
    let closest: BeatNote | null = null;
    let minDiff = Infinity;
    for (const beatNote of beat.beatNotes) {
      if (!isDrumEquivalent2(beatNote.noteString, targetNoteString)) {
        // console.log(
        //   'GrooveMonitor: matchBeatNoteFromPerformance 2 wrong note',
        //   noteStringOrMidi,
        //   timeMsec,
        //   velocity,
        //   bpm
        // );
        continue;
      }
      const positionTime = timeMsec % loopLengthMsec;
      const beatNoteTime = getBeatNoteTime(beatNote, bpm);
      console.log('GrooveMonitor: found', beatNote);
      console.log('GrooveMonitor: timeMsec', positionTime);
      console.log('GrooveMonitor: diff', Math.abs(beatNoteTime - timeMsec));
      const diff = Math.abs(beatNoteTime - positionTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = beatNote;
      }
    }
    if (closest && minDiff <= tolerance) {
      // console.log('GrooveMonitor: matchBeatNoteFromPerformance 3 return', noteStringOrMidi, timeMsec, velocity, bpm);
      return {
        beat,
        index: closest.index,
        beatNote: closest,
        performanceNote: {
          ...closest,
          microtiming: timeMsec,
          velocity: velocity,
        },
        timingDifferenceMs: timeMsec - (closest.microtiming || 0),
        velocityDifference: velocity - (closest.velocity || 0),
      };
    }
    // console.log('GrooveMonitor: matchBeatNoteFromPerformance 4 null', noteStringOrMidi, timeMsec, velocity, bpm);

    return null;
  }
}

export const grooveMonitor = new GrooveMonitor();
