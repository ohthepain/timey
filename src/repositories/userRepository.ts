import { safeQuery } from '~/config/db';

export const userRepository = {
  async getCurrentModule(userId: string) {
    const user = await safeQuery((prisma) =>
      prisma.user.findUnique({
        where: { id: userId },
        include: { moduleProgress: true },
      })
    );
    if (!user) {
      throw new Error(`User not found with id ${userId}`);
    }
    return user.currentModuleId;
  },

  async setCurrentModule(userId: string, moduleId: string) {
    return await safeQuery((prisma) =>
      prisma.user.update({
        where: { id: userId },
        data: { currentModuleId: moduleId },
      })
    );
  },
};
