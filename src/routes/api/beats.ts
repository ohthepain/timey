import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';
import prisma from '~/config/db';
import { getAuth } from '@clerk/tanstack-react-start/server';
import { redirect } from '@tanstack/react-router';
import { checkUser } from '~/lib/checkUser';
import { createBeat, updateBeat } from '~/repositories/beatRepository';
import { ParseBeatString } from '~/lib/ParseBeat';

export const APIRoute = createAPIFileRoute('/api/beats')({
  PUT: async ({ request }) => {
    console.log(`/api/beats PUT request`);
    try {
      const { userId } = await getAuth(request);
      const { id, name, beatString, index, description, moduleId } = await request.json();
      console.log('Request body:', { id, name, beatString, index, description, moduleId });

      if (!userId) {
        throw redirect({ to: '/sign-in/$' });
      }

      if (!beatString || typeof beatString !== 'string') {
        return json({ error: 'Invalid beat string' }, { status: 400 });
      }

      if (index === undefined || index === null) {
        console.error('Index is missing in the request body');
        return json({ error: 'Index is required' }, { status: 400 });
      }

      await checkUser(request);

      const { beatNotes } = ParseBeatString(beatString);
      console.log('Parsed beat notes:', beatNotes);

      if (id) {
        const beat = updateBeat(id, {
          name,
          description,
          index,
          moduleId,
          beatNotes: beatNotes,
        });

        return json({ beat }, { status: 200 });
      } else {
        const beat = createBeat({
          name,
          description,
          index,
          authorId: userId,
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

  // DELETE: async ({ request }) => {
  //   console.log(`/api/beats DELETE request`);
  //   try {
  //     const { userId } = await getAuth(request);
  //     const { beatId } = await request.json();

  //     if (!userId) {
  //       throw redirect({ to: '/sign-in/$' });
  //     }

  //     if (!beatId || typeof beatId !== 'string') {
  //       return json({ error: 'Invalid beat ID' }, { status: 400 });
  //     }

  //     await checkUser(request);

  //     const deletedBeat = await prisma.beat.delete({
  //       where: { id: beatId },
  //     });

  //     return json({ deletedBeat }, { status: 200 });
  //   } catch (error) {
  //     console.error('Error deleting beat:', error);
  //     return json({ error: 'Failed to delete beat' }, { status: 500 });
  //   }
  // },
});
