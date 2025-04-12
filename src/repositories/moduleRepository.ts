import prisma from '~/config/db';
import { Module } from '@prisma/client';

export const moduleRepository = {
  async getAllModules(): Promise<Module[]> {
    return prisma.module.findMany();
  },

  async getModulesForMethod(methodId: string): Promise<Module[]> {
    return prisma.module.findMany({ where: { methodId } });
  },

  async getModuleById(id: string): Promise<Module | null> {
    return prisma.module.findUnique({ where: { id } });
  },

  async createModule(data: Omit<Module, 'id' | 'createdAt' | 'modifiedAt'>): Promise<Module> {
    return prisma.module.create({ data });
  },

  async updateModule(data: Partial<Omit<Module, 'createdAt' | 'modifiedAt'>>): Promise<Module> {
    return prisma.module.update({ where: { id: data.id }, data });
  },

  async deleteModule(id: string): Promise<Module> {
    return prisma.module.delete({ where: { id } });
  },
};
