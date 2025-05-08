import { prisma } from '~/config/db';
import { Module } from '~/types/Module';

export const moduleRepository = {
  async getAllModules(): Promise<Module[]> {
    const data = await prisma.module.findMany();
    return data.map((m) => new Module(m));
  },

  async getModulesForMethod(methodId: string): Promise<Module[]> {
    const data = await prisma.module.findMany({ where: { methodId } });
    return data.map((m) => new Module(m));
  },

  async getModuleById(id: string): Promise<Module | null> {
    const data = await prisma.module.findUnique({
      where: { id },
      include: {
        beats: {
          include: {
            beatNotes: true,
          },
        },
        method: true,
      },
    });
    return data ? new Module(data) : null;
  },

  async createModule(data: Omit<Module, 'id' | 'createdAt' | 'modifiedAt'>): Promise<Module> {
    const { method, ...moduleData } = data;
    const d = await prisma.module.create({ data: { ...moduleData, beats: { create: [] } } });
    return new Module(d);
  },

  async updateModule(data: Partial<Omit<Module, 'createdAt' | 'modifiedAt'>>): Promise<Module> {
    const { id, method, ...updateData } = data;
    const m = await prisma.module.update({ where: { id }, data: updateData });
    return new Module(m);
  },

  async deleteModule(id: string): Promise<Module> {
    const data = await prisma.module.delete({ where: { id } });
    return new Module(data);
  },
};
