import { prisma, safeQuery } from '~/config/db';
import { ModuleProgress } from '@prisma/client';

export const moduleProgressRepository = {
  async deleteModuleProgress(userId: string, moduleId: string) {
    return await safeQuery(() =>
      prisma.moduleProgress.delete({
        where: { userId_moduleId: { userId, moduleId } },
      })
    );
  },

  async setModuleProgress(userId: string, moduleId: string, data: Partial<ModuleProgress>) {
    return await safeQuery(() =>
      prisma.moduleProgress.upsert({
        where: { userId_moduleId: { userId, moduleId } },
        update: data,
        create: { userId, moduleId, ...data },
      })
    );
  },

  async getModuleProgress(userId: string, moduleId: string) {
    return await safeQuery(() =>
      prisma.moduleProgress.findUnique({
        where: { userId_moduleId: { userId, moduleId } },
      })
    );
  },

  async setCurrentMethodForModule(userId: string, moduleId: string, methodId: string) {
    return await safeQuery(() =>
      prisma.moduleProgress.upsert({
        where: { userId_moduleId: { userId, moduleId } },
        update: { currentMethodId: methodId },
        create: { userId, moduleId, currentMethodId: methodId },
      })
    );
  },

  async getCurrentMethodForModule(userId: string, moduleId: string) {
    const moduleProgress = await safeQuery(() =>
      prisma.moduleProgress.findUnique({
        where: { userId_moduleId: { userId, moduleId } },
        select: { currentMethodId: true },
      })
    );
    if (!moduleProgress) {
      throw new Error(`Module progress not found for user ${userId} and module ${moduleId}`);
    }
    return moduleProgress.currentMethodId;
  },
};
