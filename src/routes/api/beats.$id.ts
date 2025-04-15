import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getBeatById, deleteBeat } from '~/repositories/beatRepository';

export const APIRoute = createAPIFileRoute('/api/beats/$id')({
  GET: async ({ params }) => {
    const { id } = params;
    console.log(`/api/beats/${id} GET request`);

    if (!id) {
      return json({ error: 'Module ID is required' }, { status: 400 });
    }

    try {
      const beat = await getBeatById(id);

      if (!beat) {
        return json({ error: 'Beat not found' }, { status: 404 });
      }

      return json(beat, { status: 200 });
    } catch (error) {
      console.error('Error fetching beat:', error);
      return json({ error: 'Failed to fetch beat' }, { status: 500 });
    }
  },
  DELETE: async ({ params }) => {
    const { id } = params;
    if (!id) {
      return json({ error: 'Module ID is required' }, { status: 400 });
    }
    console.log(`/api/modules/${id} DELETE request`);
    try {
      const beat = deleteBeat(id);
      if (!beat) {
        return json({ error: 'Beat not found' }, { status: 404 });
      }
      return json(beat, { status: 200 });
    } catch (error) {
      console.error('Error deleting beat:', error);
      return json({ error: 'Failed to delete beat' }, { status: 500 });
    }
  },
});
