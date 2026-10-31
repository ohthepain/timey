import { getRequest } from '@tanstack/react-start/server';
import { requireDomainUser } from '~/server/domain-session';

// Helper function to wrap server function handlers with authentication
export const withAuth = <TResult>(handler: (ctx: unknown, userId: string) => Promise<TResult>) => {
  return async (ctx: unknown): Promise<TResult> => {
    try {
      const { userId } = await requireDomainUser(getRequest());
      return handler(ctx, userId);
    } catch (error) {
      if (error instanceof Response && error.status === 401) {
        throw new Error('Authentication required');
      }
      throw error;
    }
  };
};
