import { createServerFn } from '@tanstack/react-start';
import { ensureKeycloakUser } from '~/lib/ensureKeycloakUser';

// Helper function to wrap server function handlers with authentication
export const withAuth = <T extends any[]>(handler: (ctx: any, userId: string) => Promise<any>) => {
  return async (ctx: any) => {
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

// Example usage:
// export const createMethodServerFn = createServerFn({ method: 'POST', response: 'data' })
//   .validator(createMethodServerFnArgs)
//   .handler(withAuth(async (ctx, userId) => {
//     const method = await methodRepository.createMethod({
//       ...ctx.data,
//       authorId: userId,
//     });
//     return new Method(method).toJSON();
//   }));
