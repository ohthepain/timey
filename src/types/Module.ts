import { Beat } from './Beat';

export interface Module {
  id: string;
  title: string;
  description?: string;
  index: number;
  authorId: string;
  createdAt: Date;
  modifiedAt: Date;
  beats?: Beat[];
  methodId: string;
}
