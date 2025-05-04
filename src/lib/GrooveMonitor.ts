import { EventEmitter } from 'events';
import { Beat } from '~/types/Beat';
import { BeatNote } from '~/types/BeatNote';
import { Performance } from '~/types/Performance';

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
