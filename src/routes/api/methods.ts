import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { methodRepository } from '~/repositories/methodRepository';
import { checkUser } from '~/lib/checkUser';
import { getAuth } from '@clerk/tanstack-react-start/server';
import { redirect } from '@tanstack/react-router';

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
      const { userId } = await getAuth(request);
      if (!userId) {
        throw redirect({
          to: '/sign-in/$',
        });
      }

      const { title } = await request.json();
      if (!title) {
        return json({ error: 'Title and authorId are required' }, { status: 400 });
      }

      await checkUser(request);

      const newMethod = await methodRepository.createMethod({
        title,
        authorId: userId,
        description: '',
        index: 0,
      });

      return json(newMethod, { status: 201 });
    } catch (error) {
      console.error('Error creating method:', error);
      return json({ error: 'Failed to create method' }, { status: 500 });
    }
  },
});
