import { createFileRoute } from '@tanstack/react-router';
import { moduleRepository } from '~/repositories/moduleRepository';

export const Route = createFileRoute('/api/modules/$id')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { id } = params;
        console.log(`/api/modules/${id} GET request`);

        if (!id) {
          return Response.json({ error: 'Module ID is required' }, { status: 400 });
        }

        try {
          const module = await moduleRepository.getModuleById(id);

          if (!module) {
            return Response.json({ error: 'Module not found' }, { status: 404 });
          }

          return Response.json(module, { status: 200 });
        } catch (error) {
          console.error('Error fetching module:', error);
          return Response.json({ error: 'Failed to fetch module' }, { status: 500 });
        }
      },
    },
  },
});
