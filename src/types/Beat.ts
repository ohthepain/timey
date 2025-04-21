import { BeatNote } from './BeatNote';

export interface Beat {
  id: string | undefined;
  name: string;
  index: number;
  authorId: string;
  createdAt: Date;
  modifiedAt: Date;
  beatNotes: BeatNote[];
}
