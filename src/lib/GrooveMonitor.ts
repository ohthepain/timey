import { EventEmitter } from 'events';
import { allowedNodeEnvironmentFlags } from 'process';
import { Beat } from '~/types/Beat';
import { BeatNote } from '~/types/BeatNote';
import { Performance } from '~/types/Performance';

export class PerformanceFeedback {
  beatNoteFeedback: BeatNoteFeedback[];

  constructor(beatNoteFeedback: BeatNoteFeedback[] | null) {
    this.beatNoteFeedback = beatNoteFeedback || [];
  }

  getEffectiveTempo(bpm: number, sliceSize: number): number | null {
    // Slice off last 4 beatNoteFeedbacks
    const notes = this.beatNoteFeedback.slice(-sliceSize);
    if (notes.length < sliceSize) {
      return null;
    }
    // get average timingDifferenceMs for the notes
    const timingDifferenceMs = notes.reduce((sum, feedback) => sum + feedback.timingDifferenceMs, 0) / notes.length;

    const beatLengthMsec = (60000 * 4) / bpm;
    // const effectiveTimingDifferenceMs = timingDifferenceMs / beatLengthMsec;
    const effectiveBpm = (60000 * 4) / (beatLengthMsec + timingDifferenceMs);
    return effectiveBpm;
  }

  getTempoFeedback(bpm: number): {
    bpm: number | null;
    min: number | null;
    max: number | null;
    skillLevel: number | null;
  } {
    const sliceSize = 4;
    const effectiveBpm = this.getEffectiveTempo(bpm, sliceSize);

    const gradeSliceSize = 16;
    const gradeEffectiveBpm = this.getEffectiveTempo(bpm, gradeSliceSize);
    let gradeMinTempo = null;
    let gradeMaxTempo = null;
    let skillLevel = null;
    if (gradeEffectiveBpm) {
      const diff = Math.abs(gradeEffectiveBpm - bpm);
      skillLevel = Math.ceil(Math.log2(diff));
      const nearestPowerOf2 = Math.max(1, Math.pow(2, skillLevel));
      gradeMinTempo = bpm - nearestPowerOf2;
      gradeMaxTempo = bpm + nearestPowerOf2;
    }

    return { bpm: effectiveBpm, min: gradeMinTempo, max: gradeMaxTempo, skillLevel: skillLevel };
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

class GrooveMonitor extends EventEmitter {
  getPerformanceFeedback(beat: Beat, performance: Performance): PerformanceFeedback {
    const feedback: BeatNoteFeedback[] = [];
    for (let i = 0; i < beat.beatNotes.length; i++) {
      const beatNoteFeedback = this.getBeatNoteFeedback(beat, i, performance);
      feedback.push(beatNoteFeedback);
    }
    return new PerformanceFeedback(feedback);
  }

  matchBeatNoteFromPerformance(
    beat: Beat,
    noteStringOrMidi: string | number,
    timeMsec: number,
    velocity: number,
    bpm: number
  ): BeatNoteFeedback | null {
    timeMsec %= beat.getLoopLengthMsec(bpm);
    const beatNoteIndex = beat.findClosestBeatNoteIndex(noteStringOrMidi, timeMsec, bpm);
    if (beatNoteIndex !== -1) {
      const closestBeatNote = beat.beatNotes.find((beatNote) => beatNote.index === beatNoteIndex);
      if (!closestBeatNote) {
        throw new Error('findClosestBeatNoteIndex returned a bad index?!?!?');
      }

      const loopLengthMsec = beat.getLoopLengthMsec(bpm);
      const tolerance = 60000 / bpm / 4;
      const beatNoteTime = closestBeatNote.getTimeMsec(bpm);

      let timeDiff = timeMsec - beatNoteTime;
      if (Math.abs(timeMsec + loopLengthMsec - beatNoteTime) < Math.abs(timeDiff)) {
        timeDiff = timeMsec + loopLengthMsec - beatNoteTime;
      }
      if (Math.abs(timeMsec - loopLengthMsec - beatNoteTime) < Math.abs(timeDiff)) {
        timeDiff = timeMsec - loopLengthMsec - beatNoteTime;
      }

      if (Math.abs(timeDiff) <= tolerance) {
        // console.log('GrooveMonitor: matchBeatNoteFromPerformance 3 return', noteStringOrMidi, timeMsec, velocity, bpm);
        return {
          beat,
          index: closestBeatNote.index,
          beatNote: closestBeatNote,
          performanceNote: new BeatNote({
            ...closestBeatNote,
            microtiming: timeMsec,
            velocity: velocity,
          }),
          timingDifferenceMs: timeDiff,
          velocityDifference: velocity - (closestBeatNote.velocity || 0),
        };
      }
    }
    // console.log('GrooveMonitor: matchBeatNoteFromPerformance 4 null', noteStringOrMidi, timeMsec, velocity, bpm);

    return null;
  }
}

export const grooveMonitor = new GrooveMonitor();
