import { eq } from 'drizzle-orm';
import { users } from '../../domain/schema';
import { safeQuery } from '~/config/db';

export const userRepository = {
  async getCurrentModule(userId: string) {
    const [user] = await safeQuery((db) => db.select().from(users).where(eq(users.id, userId)).limit(1));
    if (!user) {
      throw new Error(`User not found with id ${userId}`);
    }
    return user.currentModuleId;
  },

  async setCurrentModule(userId: string, moduleId: string) {
    return await safeQuery((db) =>
      db.update(users).set({ currentModuleId: moduleId }).where(eq(users.id, userId)).returning()
    );
  },
};
