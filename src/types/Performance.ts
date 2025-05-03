import { BeatNote } from './BeatNote';

export class Performance {
  id: string | undefined;
  beatId: string;
  index: number;
  userId: string | undefined;
  createdAt: Date | undefined;
  modifiedAt: Date | undefined;
  notes: BeatNote[];

  constructor(data: any) {
    this.id = data.id;
    this.beatId = data.beatId;
    this.index = data.index || 0;
    this.userId = data.userId;
    this.createdAt = data.createdAt;
    this.modifiedAt = data.modifiedAt;
    this.notes = data.notes ? data.notes.map((note: any) => new BeatNote(note)) : [];
  }

  toJSON() {
    return {
      id: this.id,
      beatId: this.beatId,
      index: this.index,
      userId: this.userId,
      createdAt: this.createdAt,
      modifiedAt: this.modifiedAt,
      notes: this.notes.map((note) => note.toJSON()),
    };
  }
}
