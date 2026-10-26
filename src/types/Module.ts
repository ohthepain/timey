import { Beat } from './Beat';
import { Method } from './Method';
import { applyCatalogEntityFields } from './catalogEntity';

export class Module {
  id!: string;
  title!: string;
  description?: string;
  index!: number;
  authorId!: string;
  createdAt!: Date;
  modifiedAt!: Date;
  beats?: Beat[];
  methodId: string;
  method: Method | null;

  constructor(data: any) {
    applyCatalogEntityFields(this, data);
    this.methodId = data.methodId;
    this.method = data.method ? new Method(data.method) : null;
    this.beats = data.beats ? data.beats.map((b: any) => new Beat(b)) : [];
  }

  toJSON(): any {
    return {
      id: this.id,
      title: this.title,
      description: this.description,
      index: this.index,
      authorId: this.authorId,
      createdAt: this.createdAt,
      modifiedAt: this.modifiedAt,
      methodId: this.methodId,
      method: this.method ? this.method.toJSON() : null,
      beats: this.beats ? this.beats.map((b) => b.toJSON()) : [],
    };
  }
}
