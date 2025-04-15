import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';
import prisma from '~/config/db';
import { getAuth } from '@clerk/tanstack-react-start/server';
import { redirect } from '@tanstack/react-router';
import { checkUser } from '~/lib/checkUser';

export const APIRoute = createAPIFileRoute('/api/beats')({
  PUT: async ({ request }) => {
    console.log(`/api/beats PUT request`);
    try {
      const { userId } = await getAuth(request);
      const { id, name, beatString, index, description, moduleId } = await request.json();

      if (!userId) {
        throw redirect({ to: '/sign-in/$' });
      }

      if (!beatString || typeof beatString !== 'string') {
        return json({ error: 'Invalid beat string' }, { status: 400 });
      }

      await checkUser(request);

      const { beatNotes } = parseBeatString(beatString);

      const beat = await prisma.beat.upsert({
        where: { id: id || '' },
        update: {
          name,
          description,
          index,
          moduleId,
          beatNotes: {
            deleteMany: {},
            create: beatNotes,
          },
        },
        create: {
          name,
          description,
          index,
          authorId: userId,
          moduleId,
          beatNotes: {
            create: beatNotes,
          },
        },
        include: { beatNotes: true },
      });

      return json({ beat }, { status: 200 });
    } catch (error) {
      console.error('Error saving/updating beat:', error);
      return json({ error: 'Failed to save/update beat' }, { status: 500 });
    }
  },

  DELETE: async ({ request }) => {
    console.log(`/api/beats DELETE request`);
    try {
      const { userId } = await getAuth(request);
      const { beatId } = await request.json();

      if (!userId) {
        throw redirect({ to: '/sign-in/$' });
      }

      if (!beatId || typeof beatId !== 'string') {
        return json({ error: 'Invalid beat ID' }, { status: 400 });
      }

      await checkUser(request);

      const deletedBeat = await prisma.beat.delete({
        where: { id: beatId },
      });

      return json({ deletedBeat }, { status: 200 });
    } catch (error) {
      console.error('Error deleting beat:', error);
      return json({ error: 'Failed to delete beat' }, { status: 500 });
    }
  },
});

// Helper function to parse the beat string
const parseBeatString = (input: string) => {
  const lines = input.split('\n');
  const beatNotes: any[] = [];

  lines.forEach((line) => {
    const noteRegex = /^note,\d+,\d+[t]?,\[(.+?)\],\d+,\d+,\d+,\d+,\d+$/;
    const match = line.match(noteRegex);

    if (match) {
      const [, keysString] = match;
      beatNotes.push({
        noteString: keysString,
        velocity: 127, // Default velocity
      });
    }
  });

  return { beatNotes };
};
