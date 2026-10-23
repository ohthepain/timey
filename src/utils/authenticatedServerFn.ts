import { ensureKeycloakUser } from '~/lib/ensureKeycloakUser';

// Helper function to wrap server function handlers with authentication
export const withAuth = <TResult>(handler: (ctx: any, userId: string) => Promise<TResult>) => {
  return async (ctx: any): Promise<TResult> => {
    // Check if token is passed in the data
    const token = ctx.data?.token;

    // Get the authenticated user ID
    const userId = await ensureKeycloakUser(token);

    if (!userId) {
      throw new Error('Authentication required');
    }

    // Call the handler with the user ID
    return handler(ctx, userId);
  };
};
