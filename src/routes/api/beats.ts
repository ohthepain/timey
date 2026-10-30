import { createFileRoute } from '@tanstack/react-router';
import { beatRepository } from '~/repositories/beatRepository';
import { ParseBeatString } from '~/lib/ParseBeat';
import { requireDomainUser } from '~/server/domain-session';
import { createBeatApiInput, createBeatInput, editBeatApiInput, editBeatInput } from '~/types/beatWrites';

export const Route = createFileRoute('/api/beats')({
  server: {
    handlers: {
      PUT: async ({ request }) => {
        try {
          const body = await request.json();
          return body.id ? await updateExistingBeat(request, body) : await createBeat(request, body);
        } catch (error) {
          if (error instanceof Response) return error;
          if (error instanceof SyntaxError) return Response.json({ error: 'Invalid JSON' }, { status: 400 });
          console.error('Beat write failed:', error);
          return Response.json({ error: 'Failed to save/update beat' }, { status: 500 });
        }
      },
    },
  },
});

async function createBeat(request: Request, body: unknown) {
  const { userId } = await requireDomainUser(request);
  const parsed = createBeatApiInput.safeParse(body);
  if (!parsed.success) return Response.json({ error: 'Invalid beat fields' }, { status: 400 });
  const { beatString, ...fields } = parsed.data;
  const input = createBeatInput.safeParse({ ...fields, beatNotes: ParseBeatString(beatString).beatNotes });
  if (!input.success) return Response.json({ error: 'Invalid musical notes' }, { status: 400 });
  return Response.json({ beat: await beatRepository.createBeat(input.data, userId) });
}

async function updateExistingBeat(request: Request, body: unknown) {
  const { userId } = await requireDomainUser(request);
  const parsed = editBeatApiInput.safeParse(body);
  if (!parsed.success) return Response.json({ error: 'Invalid beat fields' }, { status: 400 });
  const { beatString, ...fields } = parsed.data;
  const input = editBeatInput.safeParse({ ...fields, beatNotes: ParseBeatString(beatString).beatNotes });
  if (!input.success) return Response.json({ error: 'Invalid musical notes' }, { status: 400 });
  return Response.json({ beat: await beatRepository.updateBeat(input.data.id, input.data, userId) });
}
