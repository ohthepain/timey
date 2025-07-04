import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { ensureKeycloakUser } from '~/lib/ensureKeycloakUser';

export const APIRoute = createAPIFileRoute('/api/auth/ensure-user')({
  POST: async ({ request }) => {
    console.log('/api/auth/ensure-user POST request');
    try {
      // This will ensure the user exists in the database
      const userId = await ensureKeycloakUser();

      if (!userId) {
        return json({ error: 'Authentication required' }, { status: 401 });
      }

      return json({ userId }, { status: 200 });
    } catch (error) {
      console.error('Error ensuring user:', error);
      if (error instanceof Error && error.message === 'Authentication required') {
        return json({ error: 'Authentication required' }, { status: 401 });
      }
      return json({ error: 'Failed to ensure user' }, { status: 500 });
    }
  },
});
