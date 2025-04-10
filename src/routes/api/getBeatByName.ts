import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getBeatByName } from '~/repositories/beatRepository';
import { json } from '@tanstack/react-start';

export const APIRoute = createAPIFileRoute('/api/getBeatByName')({
  GET: async ({ request }) => {
    try {
      // Extract the `name` query parameter from the request URL
      const url = new URL(request.url);
      const name = url.searchParams.get('name');

      if (!name) {
        return json({ error: 'Beat name is required' }, { status: 400 });
      }

      // Call the repository function to fetch the beat by name
      const beat = await getBeatByName(name);

      if (!beat) {
        return json({ error: `Beat with name "${name}" not found` }, { status: 404 });
      }

      return json({ beat }, { status: 200 });
    } catch (error) {
      console.error('Error fetching beat by name:', error);
      return json({ error: 'Failed to fetch beat' }, { status: 500 });
    }
  },
});
