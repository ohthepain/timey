import { Module } from '~/types/Module';

export interface Method {
  id: string;
  title: string;
  description?: string;
  index: number;
  authorId: string;
  createdAt: Date;
  modifiedAt: Date;
  modules?: Module[];
}
