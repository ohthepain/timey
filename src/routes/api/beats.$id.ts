import { requireDomainUser } from '~/server/domain-session';
import { deleteContent } from '~/repositories/contentDeletion';
import { deleteContentInput } from '~/types/contentDeletion';
import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { beatRepository } from '~/repositories/beatRepository';

export const APIRoute = createAPIFileRoute('/api/beats/$id')({
  GET: async ({ params }) => {
    const { id } = params;

    try {
      const beat = await beatRepository.getBeatById(id);

      if (!beat) {
        return json({ error: 'Beat not found' }, { status: 404 });
      }

      return json(beat, { status: 200 });
    } catch (error) {
      console.error('Error fetching beat:', error);
      return json({ error: 'Failed to fetch beat' }, { status: 500 });
    }
  },
  DELETE: async ({ params, request }) => {
    try {
      const { userId } = await requireDomainUser(request);
      const id = await deletionId(request, params.id);
      return json(await deleteContent('beat', id, userId));
    } catch (error) {
      if (error instanceof Response) return error;
      console.error('Beat deletion failed:', error);
      return json({ error: 'Unable to delete beat; please retry' }, { status: 500 });
    }
  },
});

async function deletionId(request: Request, id: string) {
  const parsed = deleteContentInput.safeParse({ ...Object.fromEntries(new URL(request.url).searchParams), id });
  if (!parsed.success) throw new Response('Invalid deletion fields', { status: 400 });
  if (await request.text()) throw new Response('Unexpected deletion body', { status: 400 });
  return parsed.data.id;
}
