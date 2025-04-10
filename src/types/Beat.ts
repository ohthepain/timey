import { BeatNote } from './BeatNote';

export interface Beat {
  id: string;
  name: string;
  authorId: string;
  createdAt: Date;
  modifiedAt: Date;
  beatNotes: BeatNote[];
}
