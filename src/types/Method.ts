import { Module } from '~/types/Module';

export class Method {
  id: string;
  title: string;
  description?: string;
  index: number;
  authorId: string;
  createdAt: Date;
  modifiedAt: Date;
  modules?: Module[];

  constructor(data: any) {
    this.id = data.id;
    this.title = data.title;
    this.description = data.description || '';
    this.index = data.index || 0;
    this.authorId = data.authorId;
    this.createdAt = data.createdAt || new Date();
    this.modifiedAt = data.modifiedAt || new Date();
    this.modules = data.modules ? data.modules.map((m: any) => new Module(m)) : [];
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      description: this.description,
      index: this.index,
      authorId: this.authorId,
      createdAt: this.createdAt,
      modifiedAt: this.modifiedAt,
      modules: this.modules ? this.modules.map((m) => m.toJSON()) : [],
    };
  }
}
