import { Beat } from '~/types/Beat';
import { BeatNote } from '~/types/BeatNote';
import { TempoService } from '~/lib/MidiSync/TempoService';
import { EventRecorderService } from './EventRecorderService';

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
  lastNoteEffectiveTempo: number | null = 8;
  currentSkillLevel: number = 8;
  windowSkillLevel: number = 8;
  windowStartMsec: number = 0;

  constructor(beatNoteFeedback: BeatNoteFeedback[] | null) {
    this.beatNoteFeedback = beatNoteFeedback || [];
  }

  get tempoService(): TempoService {
    return TempoService.getInstance();
  }

  get eventRecorder(): EventRecorderService {
    return EventRecorderService.getInstance();
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

  getEffectiveTempo(bpm: number, sliceSize: number): number | null {
    // Slice off last beatNoteFeedbacks
    // Go back to at least 4 indexes, and then to the nearest 8th
    // let notes: BeatNoteFeedback[] = [];
    // const lastBeatNum = this.beatNoteFeedback[this.beatNoteFeedback.length - 1].beatNote!.beatNum;
    // const previousBeatNum = lastBeatNum > 0 ? lastBeatNum - 1 : 3;
    // let numNotes = 0;
    // for (let i = this.beatNoteFeedback.length - 1; i >= 0; i--) {
    //   const beatNote = this.beatNoteFeedback[i].beatNote;
    //   if (beatNote!.beatNum !== lastBeatNum && beatNote!.beatNum !== previousBeatNum) {
    //     notes = this.beatNoteFeedback.slice(-numNotes);
    //     break;
    //   }
    //   ++numNotes;
    // }

    let notes = this.beatNoteFeedback.slice(-sliceSize);
    if (notes.length === 0) {
      return null;
    }

    // get average timingDifferenceMs for the notes
    const timingDifferenceMs = notes.reduce((sum, feedback) => sum + feedback.timingDifferenceMs!, 0) / notes.length;

    const beatLengthMsec = (60000 * 4) / bpm;
    // const effectiveTimingDifferenceMs = timingDifferenceMs / beatLengthMsec;
    const effectiveBpm = (60000 * 4) / (beatLengthMsec + timingDifferenceMs);
    return effectiveBpm;
  }

  addBeatNote(
    beat: Beat,
    playedNote: BeatNote,
    index: number,
    positionMsec: number,
    noteNum: number
  ): BeatNoteFeedback | null {
    const beatNoteFeedback = this.matchNoteToBeat(
      beat,
      index,
      noteNum,
      positionMsec,
      playedNote.velocity,
      this.tempoService.bpm
    );
    if (beatNoteFeedback) {
      this.beatNoteFeedback.push(beatNoteFeedback);
      this.eventRecorder.recordNoteFeedback(playedNote, beatNoteFeedback);
    }

    this.lastNoteEffectiveTempo = this.getEffectiveTempo(this.tempoService.bpm, 1);
    if (this.lastNoteEffectiveTempo) {
      const lastNoteSkillLevel = this.getSkillLevelForTempo(this.lastNoteEffectiveTempo, this.tempoService.bpm);
      if (lastNoteSkillLevel > this.windowSkillLevel) {
        // Reset skill window whenever skill drops. Punish them!!
        this.windowSkillLevel = lastNoteSkillLevel;
        this.windowStartMsec = this.tempoService.elapsedMsec;
      } else if (this.tempoService.elapsedMsec - this.windowStartMsec > 2000) {
        // If skill is good, but we've been playing for a while, increase skill level
        this.windowSkillLevel = lastNoteSkillLevel;
        this.windowStartMsec = this.tempoService.elapsedMsec;
      }
    }

    return beatNoteFeedback;
  }

  getSkillLevelForTempo(effectiveBpm: number, bpm: number): number {
    const diff = Math.abs(effectiveBpm - bpm);
    if (diff < 1) {
      return 0;
    } else {
      return Math.ceil(Math.log2(diff));
    }
  }

  getTempoFeedback(bpm: number): {
    bpm: number | null;
    skillLevel: number | null;
    windowSkillLevel: number | null;
    lastNoteEffectiveTempo: number | null;
  } {
    const sliceSize = 8;
    const effectiveBpm = this.getEffectiveTempo(bpm, sliceSize);

    const gradeSliceSize = 32;
    const gradeEffectiveBpm = this.getEffectiveTempo(bpm, gradeSliceSize);
    let skillLevel = null;
    if (gradeEffectiveBpm) {
      skillLevel = this.getSkillLevelForTempo(gradeEffectiveBpm, bpm);
    }

    return {
      bpm: effectiveBpm,
      skillLevel: skillLevel,
      windowSkillLevel: this.windowSkillLevel,
      lastNoteEffectiveTempo: this.lastNoteEffectiveTempo,
    };
  }
}
