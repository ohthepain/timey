import { BeatNote } from './BeatNote';

export class Beat {
  id: string | undefined;
  name: string;
  index: number;
  authorId: string;
  createdAt: Date;
  modifiedAt: Date;
  beatNotes: BeatNote[];
  beatsPerBar: number = 4;

  constructor(data: any) {
    this.id = data.id;
    this.name = data.name;
    this.index = data.index || 0;
    this.authorId = data.authorId;
    this.createdAt = data.createdAt || new Date();
    this.modifiedAt = data.modifiedAt || new Date();
    this.beatNotes = data.beatNotes ? data.beatNotes.map((note: any) => new BeatNote(note)) : [];
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
}
