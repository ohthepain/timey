import { BeatNote } from './BeatNote';

export class Performance {
  id: string | undefined;
  beatId: string;
  index: number;
  userId: string;
  createdAt: Date;
  modifiedAt: Date;
  notes: BeatNote[];

  constructor(data: any) {
    this.id = data.id;
    this.beatId = data.beatId;
    this.index = data.index;
    this.userId = data.userId;
    this.createdAt = data.createdAt;
    this.modifiedAt = data.modifiedAt;
    this.notes = data.notes.map((note: any) => new BeatNote(note));
  }
}
