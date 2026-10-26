export type CatalogEntityFields = {
  id: string;
  title: string;
  description?: string;
  index: number;
  authorId: string;
  createdAt: Date;
  modifiedAt: Date;
};

export function applyCatalogEntityFields(target: CatalogEntityFields, data: any) {
  target.id = data.id;
  target.title = data.title;
  target.description = data.description || '';
  target.index = data.index || 0;
  target.authorId = data.authorId;
  target.createdAt = data.createdAt || new Date();
  target.modifiedAt = data.modifiedAt || new Date();
}
