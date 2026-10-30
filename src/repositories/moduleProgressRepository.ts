import { and, eq } from 'drizzle-orm';
import { moduleProgress, type DomainModuleProgress } from '../../domain/schema';
import { newId } from '~/db/ids';
import { safeQuery } from '~/config/db';

export const moduleProgressRepository = {
  async deleteModuleProgress(userId: string, moduleId: string) {
    return await safeQuery((db) =>
      db
        .delete(moduleProgress)
        .where(and(eq(moduleProgress.userId, userId), eq(moduleProgress.moduleId, moduleId)))
        .returning()
    );
  },

  async setModuleProgress(userId: string, moduleId: string, data: Partial<DomainModuleProgress>) {
    const [row] = await safeQuery((db) =>
      db
        .insert(moduleProgress)
        .values({ id: newId(), userId, moduleId, ...data })
        .onConflictDoUpdate({
          target: [moduleProgress.userId, moduleProgress.moduleId],
          set: data,
        })
        .returning()
    );
    return row;
  },

  async getModuleProgress(userId: string, moduleId: string) {
    const [row] = await safeQuery((db) =>
      db
        .select()
        .from(moduleProgress)
        .where(and(eq(moduleProgress.userId, userId), eq(moduleProgress.moduleId, moduleId)))
        .limit(1)
    );
    return row ?? null;
  },

  async setCurrentMethodForModule(userId: string, moduleId: string, methodId: string) {
    const [row] = await safeQuery((db) =>
      db
        .insert(moduleProgress)
        .values({ id: newId(), userId, moduleId, currentMethodId: methodId })
        .onConflictDoUpdate({
          target: [moduleProgress.userId, moduleProgress.moduleId],
          set: { currentMethodId: methodId },
        })
        .returning()
    );
    return row;
  },

  async getCurrentMethodForModule(userId: string, moduleId: string) {
    const [row] = await safeQuery((db) =>
      db
        .select({ currentMethodId: moduleProgress.currentMethodId })
        .from(moduleProgress)
        .where(and(eq(moduleProgress.userId, userId), eq(moduleProgress.moduleId, moduleId)))
        .limit(1)
    );
    if (!row) {
      throw new Error(`Module progress not found for user ${userId} and module ${moduleId}`);
    }
    return row.currentMethodId;
  },
};
