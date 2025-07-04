import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { methodRepository } from '~/repositories/methodRepository';
import { requireKeycloakUser } from '~/lib/ensureKeycloakUser';

export const APIRoute = createAPIFileRoute('/api/methods')({
  GET: async () => {
    console.log(`/api/methods GET request`);
    try {
      const methods = await methodRepository.getAllMethods();
      return json({ methods });
    } catch (error) {
      console.error('Error fetching methods:', error);
      return json({ error: 'Failed to get methods' }, { status: 500 });
    }
  },
  POST: async ({ request }) => {
    console.log(`/api/methods POST request`);
    try {
      const { title } = await request.json();
      if (!title) {
        return json({ error: 'Title is required' }, { status: 400 });
      }

      // Get the authenticated user ID
      const authorId = await requireKeycloakUser();

      const newMethod = await methodRepository.createMethod({
        title,
        authorId,
        description: '',
        index: 0,
      });

      return json(newMethod, { status: 201 });
    } catch (error) {
      console.error('Error creating method:', error);
      if (error instanceof Error && error.message === 'Authentication required') {
        return json({ error: 'Authentication required' }, { status: 401 });
      }
      return json({ error: 'Failed to create method' }, { status: 500 });
    }
  },
});
