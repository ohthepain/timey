import type { Module as ModuleRow, Method as MethodRow } from '@prisma/client';
import type { ModuleChanges } from '~/types/contentWrites';
import { safeQuery } from '~/config/db';
import { Module } from '~/types/Module';

export const moduleRepository = {
  async getAllModules(): Promise<Module[]> {
    const data = await safeQuery((prisma) => prisma.module.findMany());
    return data.map((m) => new Module(m));
  },

  async getModulesForMethod(methodId: string): Promise<Module[]> {
    const data = await safeQuery((prisma) => prisma.module.findMany({ where: { methodId } }));
    return data.map((m) => new Module(m));
  },

  async getModuleById(id: string): Promise<Module | null> {
    const data = await safeQuery((prisma) =>
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

  async createModule(data: ModuleChanges & { title: string; methodId: string }, userId: string): Promise<Module> {
    const row = await safeQuery((prisma) =>
      prisma.$transaction(async (tx) => {
        const parents = await tx.$queryRaw<MethodRow[]>`SELECT * FROM "Method" WHERE id = ${data.methodId} FOR UPDATE`;
        if (parents[0]?.authorId !== userId) throw new Response('You must own the destination method', { status: 403 });
        return tx.module.create({
          data: {
            title: data.title,
            description: data.description ?? '',
            index: data.index ?? 0,
            methodId: data.methodId,
            authorId: userId,
          },
        });
      })
    );
    return new Module(row);
  },

  async updateModule(id: string, data: ModuleChanges, userId: string): Promise<Module> {
    const row = await safeQuery((prisma) =>
      prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<ModuleRow[]>`SELECT * FROM "Module" WHERE id = ${id} FOR UPDATE`;
        const current = rows[0];
        if (current?.authorId !== userId) throw new Response('Only the module author can edit it', { status: 403 });
        if (data.methodId !== undefined) {
          const parents = await tx.$queryRaw<
            MethodRow[]
          >`SELECT * FROM "Method" WHERE id = ${data.methodId} FOR UPDATE`;
          if (parents[0]?.authorId !== userId)
            throw new Response('You must own the destination method', { status: 403 });
        }
        return tx.module.update({
          where: { id },
          data: {
            title: data.title,
            description: data.description,
            index: data.index,
            methodId: data.methodId,
          },
        });
      })
    );
    return new Module(row);
  },

  async deleteModule(id: string): Promise<Module> {
    const data = await safeQuery((prisma) => prisma.module.delete({ where: { id } }));
    return new Module(data);
  },
};
