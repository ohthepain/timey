import { eq, sql } from 'drizzle-orm';
import { methods, modules, type DomainMethod } from '../../domain/schema';
import { newId } from '~/db/ids';
import { pgRows } from '~/db/pg-rows';
import { safeQuery } from '~/config/db';
import type { MethodChanges } from '~/types/contentWrites';
import { Method } from '~/types/Method';
import { moduleProgressRepository } from './moduleProgressRepository';

export const methodRepository = {
  async getAllMethods(): Promise<Method[]> {
    const rows = await safeQuery((db) => db.select().from(methods));
    return rows.map((row) => new Method(row));
  },

  async getMethodById(id: string) {
    const [method] = await safeQuery((db) => db.select().from(methods).where(eq(methods.id, id)).limit(1));
    if (!method) return null;
    const methodModules = await safeQuery((db) => db.select().from(modules).where(eq(modules.methodId, id)));
    return { ...method, modules: methodModules };
  },

  async getMethodByTitle(title: string): Promise<DomainMethod | null> {
    const [row] = await safeQuery((db) => db.select().from(methods).where(eq(methods.title, title)).limit(1));
    return row ?? null;
  },

  async createMethod(data: MethodChanges, userId: string): Promise<DomainMethod> {
    const [row] = await safeQuery((db) =>
      db
        .insert(methods)
        .values({
          id: newId(),
          title: data.title,
          description: data.description ?? '',
          index: data.index ?? 0,
          authorId: userId,
        })
        .returning()
    );
    return row;
  },

  async updateMethod(id: string, data: Partial<MethodChanges>, userId: string): Promise<DomainMethod> {
    return safeQuery((db) =>
      db.transaction(async (tx) => {
        const current = pgRows<DomainMethod>(
          await tx.execute(sql`SELECT * FROM domain."Method" WHERE id = ${id} FOR UPDATE`)
        )[0];
        if (current?.authorId !== userId) throw new Response('Only the method author can edit it', { status: 403 });
        const [row] = await tx
          .update(methods)
          .set({ title: data.title, description: data.description, index: data.index })
          .where(eq(methods.id, id))
          .returning();
        return row;
      })
    );
  },

  getModuleProgress: moduleProgressRepository.getModuleProgress,
};
