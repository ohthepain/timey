import { applyCatalogEntityFields } from '~/types/catalogEntity';
import type { Module } from '~/types/Module';

export class Method {
  id!: string;
  title!: string;
  description?: string;
  index!: number;
  authorId!: string;
  createdAt!: Date;
  modifiedAt!: Date;
  modules?: Module[];

  constructor(data: any) {
    applyCatalogEntityFields(this, data);
    this.modules = data.modules ?? [];
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
      modules: this.modules?.map((m) => (typeof m.toJSON === 'function' ? m.toJSON() : m)) ?? [],
    };
  }
}
