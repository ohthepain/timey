import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { methodRepository } from '~/repositories/methodRepository';

export const APIRoute = createAPIFileRoute('/api/methods/$id')({
  GET: async ({ params }) => {
    console.log(`/api/methods GET id request`);
    try {
      const { id } = params;
      if (!id) {
        return json({ error: 'ID is required' }, { status: 400 });
      }
      console.log('Fetching method with ID:', id);
      const method = await methodRepository.getMethodById(id);
      console.log('route: Method:', method);
      if (!method) {
        return json({ error: 'Method not found' }, { status: 404 });
      }
      return json(method, { status: 200 });
    } catch (error) {
      console.error('Error fetching method:', error);
      return json({ error: 'Failed to get method' }, { status: 500 });
    }
  },
  DELETE: async ({ request }) => {
    console.log(`/api/methods DELETE request`);
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) {
      return json({ error: 'ID is required' }, { status: 400 });
    }
    const method = await methodRepository.deleteMethod(id);
    if (!method) {
      return json({ error: 'Method not found' }, { status: 404 });
    }
    return json({ message: 'Method deleted successfully' }, { status: 200 });
  },
  POST: async ({ request }) => {
    console.log(`/api/methods POST request`);
    try {
      const { title } = await request.json();
      if (!title) {
        return json({ error: 'Title is required' }, { status: 400 });
      }

      // For now, use a default author ID since we removed authentication
      const defaultAuthorId = 'default-user';

      const newMethod = await methodRepository.createMethod({
        title,
        authorId: defaultAuthorId,
        description: '',
        index: 0,
      });

      return json(newMethod, { status: 201 });
    } catch (error) {
      console.error('Error creating method:', error);
      return json({ error: 'Failed to create method' }, { status: 500 });
    }
  },
  PUT: async ({ request, params }) => {
    console.log(`/api/methods PUT request`);
    try {
      const { id } = params;
      const data = await request.json();
      if (!id) {
        throw new Error('ID is required');
      }
      const method = await methodRepository.updateMethod(id, data);
      return json({ method }, { status: 200 });
    } catch (error) {
      console.error('Error updating method:', error);
      return json({ error: 'Failed to update method' }, { status: 500 });
    }
  },
});
