import { Beat } from '~/types/Beat';
import { BeatNote } from '~/types/BeatNote';

export class BeatNoteFeedback {
  beat: Beat;
  index: number;
  beatNote: BeatNote | null;
  performanceNote: BeatNote | null;
  timingDifferenceMs: number | null;
  velocityDifference: number | null;
  missedNotes: string[] | undefined;

  constructor(data: any) {
    this.beat = data.beat;
    this.index = data.index;
    this.beatNote = data.beatNote;
    this.performanceNote = data.performanceNote;
    this.timingDifferenceMs = data.timingDifferenceMs;
    this.velocityDifference = data.velocityDifference;
    this.missedNotes = data.missedNotes;
  }
}

export class PerformanceFeedback {
  beatNoteFeedback: BeatNoteFeedback[];

  constructor(beatNoteFeedback: BeatNoteFeedback[] | null) {
    this.beatNoteFeedback = beatNoteFeedback || [];
  }

  matchNoteToBeat(
    beat: Beat,
    index: number,
    noteNum: number,
    timeMsec: number,
    velocity: number,
    bpm: number
  ): BeatNoteFeedback | null {
    const position = timeMsec % beat.getLoopLengthMsec(bpm);
    const beatNoteIndex = index; //beat.findClosestBeatNoteIndex(noteNum, position, bpm);
    if (beatNoteIndex === index || beatNoteIndex === index + 1) {
      const closestBeatNote = beat.beatNotes.find((beatNote) => beatNote.index === beatNoteIndex);
      if (!closestBeatNote) {
        throw new Error('findClosestBeatNoteIndex returned a bad index?!?!?');
      }

      const idealBeatPosition = closestBeatNote.getPositionMsec(bpm);
      const timeDiff = Beat.loopedTimeDiff(position, idealBeatPosition, beat.getLoopLengthMsec(bpm));
      const tolerance = 60000 / bpm;
      if (Math.abs(timeDiff) <= tolerance) {
        return new BeatNoteFeedback({
          beat,
          index: closestBeatNote.index,
          beatNote: closestBeatNote,
          performanceNote: new BeatNote({
            ...closestBeatNote,
            microtiming: timeDiff,
            velocity: velocity,
          }),
          timingDifferenceMs: timeDiff,
          velocityDifference: velocity - (closestBeatNote.velocity || 0),
          missedNotes: undefined,
        });
      }
    }

    return null;
  }

  addBeatNote(
    beat: Beat,
    playedNote: BeatNote,
    index: number,
    positionMsec: number,
    noteNum: number,
    bpm: number
  ): BeatNoteFeedback | null {
    const beatNoteFeedback = this.matchNoteToBeat(beat, index, noteNum, positionMsec, playedNote.velocity, bpm);
    if (beatNoteFeedback) {
      this.beatNoteFeedback.push(beatNoteFeedback);
    }

    return beatNoteFeedback;
  }
}
