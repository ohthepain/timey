import prisma from '~/config/db';
import { Method } from '@prisma/client';

export const methodRepository = {
  async getAllMethods(): Promise<Method[]> {
    return await prisma.method.findMany();
  },

  async getMethodById(id: string): Promise<Method | null> {
    return await prisma.method.findUnique({
      where: { id },
      include: { modules: true },
    });
  },

  async getMethodByTitle(title: string): Promise<Method | null> {
    return await prisma.method.findUnique({
      where: { title },
    });
  },

  async createMethod(data: Omit<Method, 'id' | 'createdAt' | 'modifiedAt'>): Promise<Method> {
    return await prisma.method.create({
      data,
    });
  },

  async updateMethod(id: string, data: Partial<Omit<Method, 'id' | 'createdAt' | 'modifiedAt'>>): Promise<Method> {
    return await prisma.method.update({
      where: { id },
      data,
    });
  },

  async deleteMethod(id: string): Promise<Method> {
    return await prisma.method.delete({
      where: { id },
    });
  },
};
