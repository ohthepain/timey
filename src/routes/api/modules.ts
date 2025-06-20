import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { moduleRepository } from '~/repositories/moduleRepository';

export const APIRoute = createAPIFileRoute('/api/modules')({
  GET: async () => {
    console.log(`/api/modules GET request`);
    try {
      const modules = await moduleRepository.getAllModules();
      return json({ modules });
    } catch (error) {
      console.error('Error fetching methods:', error);
      return json({ error: 'Failed to get methods' }, { status: 500 });
    }
  },
  POST: async ({ request }) => {
    console.log(`/api/modules POST request`);
    try {
      const { title, index, methodId } = await request.json();
      if (!title || !methodId) {
        return json({ error: 'Title and methodId are required' }, { status: 400 });
      }

      // For now, use a default author ID since we removed authentication
      const defaultAuthorId = 'default-user';

      const newMethod = await moduleRepository.createModule({
        title,
        index,
        description: '',
        authorId: defaultAuthorId,
        methodId,
      });

      return json(newMethod, { status: 201 });
    } catch (error) {
      console.error('Error creating method:', error);
      return json({ error: 'Failed to create method' }, { status: 500 });
    }
  },
  PUT: async ({ request }) => {
    console.log(`/api/modules PUT request`);
    try {
      const { id, title, index } = await request.json();
      if (!id || !title) {
        return json({ error: 'ID and title are required' }, { status: 400 });
      }

      const updatedMethod = await moduleRepository.updateModule({
        id,
        title,
        index,
      });

      return json(updatedMethod, { status: 200 });
    } catch (error) {
      console.error('Error updating method:', error);
      return json({ error: 'Failed to update method' }, { status: 500 });
    }
  },
  DELETE: async ({ request }) => {
    console.log(`/api/modules DELETE request`);
    try {
      const { id } = await request.json();
      if (!id) {
        return json({ error: 'ID is required' }, { status: 400 });
      }

      const deletedMethod = await moduleRepository.deleteModule(id);
      return json(deletedMethod, { status: 200 });
    } catch (error) {
      console.error('Error deleting method:', error);
      return json({ error: 'Failed to delete method' }, { status: 500 });
    }
  },
});
