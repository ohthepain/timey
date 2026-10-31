import { createFileRoute } from '@tanstack/react-router';
import { beatRepository } from '~/repositories/beatRepository';

export const Route = createFileRoute('/api/getBeatByName')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          const name = url.searchParams.get('name');

          if (!name) {
            return Response.json({ error: 'Beat name is required' }, { status: 400 });
          }

          const beat = await beatRepository.getBeatByName(name);

          if (!beat) {
            return Response.json({ error: `Beat with name "${name}" not found` }, { status: 404 });
          }

          return Response.json({ beat }, { status: 200 });
        } catch (error) {
          console.error('Error fetching beat by name:', error);
          return Response.json({ error: 'Failed to fetch beat' }, { status: 500 });
        }
      },
    },
  },
});
