import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { beatRepository } from '~/repositories/beatRepository';
import { ParseBeatString } from '~/lib/ParseBeat';
import { requireKeycloakUser } from '~/lib/ensureKeycloakUser';
import { requireDomainUser } from '~/server/domain-session';
import { createBeatApiInput, createBeatInput } from '~/types/beatWrites';

export const APIRoute = createAPIFileRoute('/api/beats')({
  PUT: async ({ request }) => {
    try {
      const body = await request.json();
      return body.id ? await updateExistingBeat(body) : await createBeat(request, body);
    } catch (error) {
      if (error instanceof Response) return error;
      if (error instanceof SyntaxError) return json({ error: 'Invalid JSON' }, { status: 400 });
      console.error('Beat write failed:', error);
      return json({ error: 'Failed to save/update beat' }, { status: 500 });
    }
  },
});

async function createBeat(request: Request, body: unknown) {
  const { userId } = await requireDomainUser(request);
  const parsed = createBeatApiInput.safeParse(body);
  if (!parsed.success) return json({ error: 'Invalid beat fields' }, { status: 400 });
  const { beatString, ...fields } = parsed.data;
  const input = createBeatInput.safeParse({ ...fields, beatNotes: ParseBeatString(beatString).beatNotes });
  if (!input.success) return json({ error: 'Invalid musical notes' }, { status: 400 });
  return json({ beat: await beatRepository.createBeat(input.data, userId) });
}

// Transitional existing-beat policy is deliberately unchanged by the creation cutover.
async function updateExistingBeat(body: Record<string, any>) {
  const { id, name, beatString, index, description, moduleId } = body;
  if (!beatString || typeof beatString !== 'string') return json({ error: 'Invalid beat string' }, { status: 400 });
  if (index === undefined || index === null) return json({ error: 'Index is required' }, { status: 400 });
  await requireKeycloakUser();
  const { beatNotes } = ParseBeatString(beatString);
  return json({ beat: await beatRepository.updateBeat(id, { name, description, index, moduleId, beatNotes }) });
}
