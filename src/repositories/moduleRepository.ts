import { prisma, safeQuery } from '~/config/db';
import { Module } from '~/types/Module';

export const moduleRepository = {
  async getAllModules(): Promise<Module[]> {
    const data = await safeQuery(() => prisma.module.findMany());
    return data.map((m) => new Module(m));
  },

  async getModulesForMethod(methodId: string): Promise<Module[]> {
    const data = await safeQuery(() => prisma.module.findMany({ where: { methodId } }));
    return data.map((m) => new Module(m));
  },

  async getModuleById(id: string): Promise<Module | null> {
    const data = await safeQuery(() =>
      prisma.module.findUnique({
        where: { id },
        include: {
          beats: {
            include: {
              beatNotes: true,
            },
          },
          method: true,
        },
      })
    );
    return data ? new Module(data) : null;
  },

  async createModule(data: {
    title: string;
    description?: string;
    index: number;
    authorId: string;
    methodId: string;
  }): Promise<Module> {
    try {
      const d = await safeQuery(() => prisma.module.create({ data: { ...data, beats: { create: [] } } }));
      return new Module(d);
    } catch (error) {
      console.error('Error creating module:', error);
      throw error;
    }
  },

  async updateModule(data: Partial<Omit<Module, 'createdAt' | 'modifiedAt'>>): Promise<Module> {
    const { id, method, beats, ...updateData } = data;
    const m = await safeQuery(() =>
      prisma.module.update({
        where: { id },
        data: {
          ...updateData,
          methodId: method?.id || undefined,
        },
      })
    );
    return new Module(m);
  },

  async deleteModule(id: string): Promise<Module> {
    const data = await safeQuery(() => prisma.module.delete({ where: { id } }));
    return new Module(data);
  },
};
