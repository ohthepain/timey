import { BeatNote } from './BeatNote';

export interface Performance {
  id: string | undefined;
  beatId: string;
  index: number;
  userId: string;
  createdAt: Date;
  modifiedAt: Date;
  notes: BeatNote[];
}
