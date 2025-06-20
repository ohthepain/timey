import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { beatRepository } from '~/repositories/beatRepository';
import { ParseBeatString } from '~/lib/ParseBeat';

export const APIRoute = createAPIFileRoute('/api/beats')({
  PUT: async ({ request }) => {
    console.log(`/api/beats PUT request`);
    try {
      const { id, name, beatString, index, description, moduleId } = await request.json();
      console.log('Request body:', { id, name, beatString, index, description, moduleId });

      if (!beatString || typeof beatString !== 'string') {
        return json({ error: 'Invalid beat string' }, { status: 400 });
      }

      if (index === undefined || index === null) {
        console.error('Index is missing in the request body');
        return json({ error: 'Index is required' }, { status: 400 });
      }

      // For now, use a default author ID since we removed authentication
      const defaultAuthorId = 'default-user';

      const { beatNotes } = ParseBeatString(beatString);
      console.log('Parsed beat notes:', beatNotes);

      if (id) {
        const beat = await beatRepository.updateBeat(id, {
          name,
          description,
          index,
          moduleId,
          beatNotes: beatNotes,
        });

        return json({ beat }, { status: 200 });
      } else {
        const beat = await beatRepository.createBeat({
          name,
          description,
          index,
          authorId: defaultAuthorId,
          moduleId,
          beatNotes: beatNotes,
        });

        return json({ beat }, { status: 200 });
      }
    } catch (error) {
      console.error('Error saving/updating beat:', error);
      return json({ error: 'Failed to save/update beat' }, { status: 500 });
    }
  },
});
