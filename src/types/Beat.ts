import { BeatNote } from './BeatNote';
import { Module } from './Module';

export class Beat {
  id: string | undefined;
  name: string;
  index: number;
  authorId: string;
  createdAt: Date;
  modifiedAt: Date;
  beatNotes: BeatNote[];
  beatsPerBar: number;
  moduleId: string | undefined;
  module: Module | undefined;

  constructor(data: any) {
    this.id = data.id;
    this.name = data.name;
    this.index = data.index || 0;
    this.authorId = data.authorId;
    this.createdAt = data.createdAt || new Date();
    this.modifiedAt = data.modifiedAt || new Date();
    this.beatNotes = data.beatNotes ? data.beatNotes.map((note: any) => new BeatNote(note)) : [];
    this.beatsPerBar = data.beatsPerBar || 4;
    this.moduleId = data.moduleId;
    this.module = data.module ? new Module(data.module) : undefined;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      index: this.index,
      authorId: this.authorId,
      createdAt: this.createdAt,
      modifiedAt: this.modifiedAt,
      beatNotes: this.beatNotes.map((note) => note.toJSON()),
      beatsPerBar: this.beatsPerBar,
      moduleId: this.moduleId,
      // module: this.module ? this.module.toJSON() : undefined,
    };
  }

  getLoopLengthMsec(bpm: number): number {
    if (!this.beatNotes.length) throw new Error('No beat notes available to calculate loop length');
    // Find the max barNum in the beat
    const maxBarNum = Math.max(...this.beatNotes.map((n) => n.barNum));
    // Assume 4/4 time: 4 beats per bar
    const numBars = maxBarNum + 1;
    const totalBeats = numBars * this.beatsPerBar;
    const beatDurationMsec = 60000 / bpm;
    return totalBeats * beatDurationMsec;
  }

  static loopedTimeDiff(timeMsec: number, beatNoteTime: number, loopLengthMsec: number): number {
    const forwardDiff = (beatNoteTime - timeMsec + loopLengthMsec) % loopLengthMsec;
    const backwardDiff = (timeMsec - beatNoteTime + loopLengthMsec) % loopLengthMsec;
    return Math.min(forwardDiff, backwardDiff);
  }

  findClosestBeatNoteIndex(noteStringOrMidi: string | number, timeMsec: number, bpm: number): number {
    let isDrumEquivalent = (a: string, b: string) => {
      if (a === b) return true;
      if ((b === '35' || b === '36') && a.includes('kick')) return true;
      if ((b === '38' || b === '40') && a.includes('snare')) return true;
      if ((b === '42' || b === '44' || b === '46') && a.includes('hihat')) return true;
      return false;
    };

    const loopLengthMsec = this.getLoopLengthMsec(bpm);
    let targetNoteString = typeof noteStringOrMidi === 'number' ? String(noteStringOrMidi) : noteStringOrMidi;

    let closest: BeatNote | null = null;
    let minDiff = Infinity;

    for (const beatNote of this.beatNotes) {
      if (!isDrumEquivalent(beatNote.noteString, targetNoteString)) {
        continue;
      }

      const beatNoteTime = beatNote.getTimeMsec(bpm);
      const diff = Beat.loopedTimeDiff(timeMsec, beatNoteTime, loopLengthMsec);
      if (diff < minDiff) {
        minDiff = diff;
        closest = beatNote;
      }
    }

    if (!closest) {
      console.log('Beat.findClosestBeatNoteIndex: drum not found', noteStringOrMidi);
      return -1;
    }

    return closest.index;
  }
}
