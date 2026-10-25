import { safeQuery } from '~/config/db';
import type { MethodChanges } from '~/types/contentWrites';
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

  async createMethod(data: MethodChanges, userId: string): Promise<Method> {
    return safeQuery((prisma) =>
      prisma.method.create({
        data: { title: data.title, description: data.description ?? '', index: data.index ?? 0, authorId: userId },
      })
    );
  },

  async updateMethod(id: string, data: Partial<MethodChanges>, userId: string): Promise<Method> {
    return safeQuery((prisma) =>
      prisma.$transaction(async (tx) => {
        // Lock before checking: ownership cannot change between authorization and write.
        const rows = await tx.$queryRaw<Method[]>`SELECT * FROM "Method" WHERE id = ${id} FOR UPDATE`;
        if (rows[0]?.authorId !== userId) throw new Response('Only the method author can edit it', { status: 403 });
        return tx.method.update({
          where: { id },
          data: { title: data.title, description: data.description, index: data.index },
        });
      })
    );
  },

  getModuleProgress: moduleProgressRepository.getModuleProgress,
};
