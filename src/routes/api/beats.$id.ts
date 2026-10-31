import { createFileRoute } from '@tanstack/react-router';
import { requireDomainUser } from '~/server/domain-session';
import { deleteContent } from '~/repositories/contentDeletion';
import { deleteContentInput } from '~/types/contentDeletion';
import { beatRepository } from '~/repositories/beatRepository';

export const Route = createFileRoute('/api/beats/$id')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { id } = params;

        try {
          const beat = await beatRepository.getBeatById(id);

          if (!beat) {
            return Response.json({ error: 'Beat not found' }, { status: 404 });
          }

          return Response.json(beat, { status: 200 });
        } catch (error) {
          console.error('Error fetching beat:', error);
          return Response.json({ error: 'Failed to fetch beat' }, { status: 500 });
        }
      },
      DELETE: async ({ params, request }) => {
        try {
          const { userId } = await requireDomainUser(request);
          const id = await deletionId(request, params.id);
          return Response.json(await deleteContent('beat', id, userId));
        } catch (error) {
          if (error instanceof Response) return error;
          console.error('Beat deletion failed:', error);
          return Response.json({ error: 'Unable to delete beat; please retry' }, { status: 500 });
        }
      },
    },
  },
});

async function deletionId(request: Request, id: string) {
  const parsed = deleteContentInput.safeParse({ ...Object.fromEntries(new URL(request.url).searchParams), id });
  if (!parsed.success) throw new Response('Invalid deletion fields', { status: 400 });
  if (await request.text()) throw new Response('Unexpected deletion body', { status: 400 });
  return parsed.data.id;
}
