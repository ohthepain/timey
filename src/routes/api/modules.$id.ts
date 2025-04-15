import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { moduleRepository } from '~/repositories/moduleRepository';

export const APIRoute = createAPIFileRoute('/api/modules/$id')({
  GET: async ({ params }) => {
    const { id } = params;
    console.log(`/api/modules/${id} GET request`);

    if (!id) {
      return json({ error: 'Module ID is required' }, { status: 400 });
    }

    try {
      const module = await moduleRepository.getModuleById(id);

      if (!module) {
        return json({ error: 'Module not found' }, { status: 404 });
      }

      return json(module, { status: 200 });
    } catch (error) {
      console.error('Error fetching module:', error);
      return json({ error: 'Failed to fetch module' }, { status: 500 });
    }
  },
});
