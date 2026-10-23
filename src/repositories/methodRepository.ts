import { safeQuery } from '~/config/db';
import { Method } from '@prisma/client';
import { moduleProgressRepository } from './moduleProgressRepository';

export const methodRepository = {
  async getAllMethods(): Promise<Method[]> {
    return await safeQuery((prisma) => prisma.method.findMany());
  },

  async getMethodById(id: string): Promise<Method | null> {
    return await safeQuery((prisma) =>
      prisma.method.findUnique({
        where: { id },
        include: { modules: true },
      })
    );
  },

  async getMethodByTitle(title: string): Promise<Method | null> {
    return await safeQuery((prisma) =>
      prisma.method.findUnique({
        where: { title },
      })
    );
  },

  async createMethod(data: Omit<Method, 'id' | 'createdAt' | 'modifiedAt'>): Promise<Method> {
    return await safeQuery((prisma) =>
      prisma.method.create({
        data,
      })
    );
  },

  async updateMethod(id: string, data: Partial<Omit<Method, 'id' | 'createdAt' | 'modifiedAt'>>): Promise<Method> {
    return await safeQuery((prisma) =>
      prisma.method.update({
        where: { id },
        data,
      })
    );
  },

  async deleteMethod(id: string): Promise<Method> {
    return await safeQuery((prisma) =>
      prisma.method.delete({
        where: { id },
      })
    );
  },

  getModuleProgress: moduleProgressRepository.getModuleProgress,
};
