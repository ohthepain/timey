import { createFileRoute } from '@tanstack/react-router';
import { deleteContent } from '~/repositories/contentDeletion';
import { deleteContentInput } from '~/types/contentDeletion';
import { moduleRepository } from '~/repositories/moduleRepository';
import { requireDomainUser } from '~/server/domain-session';
import { createModuleInput, updateModuleApiInput } from '~/types/contentWrites';

export const Route = createFileRoute('/api/modules')({
  server: {
    handlers: {
      GET: async () => {
        console.log(`/api/modules GET request`);
        try {
          const modules = await moduleRepository.getAllModules();
          return Response.json({ modules });
        } catch (error) {
          console.error('Error fetching methods:', error);
          return Response.json({ error: 'Failed to get methods' }, { status: 500 });
        }
      },
      POST: async ({ request }) => {
        try {
          const { userId } = await requireDomainUser(request);
          const parsed = createModuleInput.safeParse(await request.json());
          if (!parsed.success) return Response.json({ error: 'Invalid module fields' }, { status: 400 });
          return Response.json(await moduleRepository.createModule(parsed.data, userId), { status: 201 });
        } catch (error) {
          return moduleWriteError(error);
        }
      },
      PUT: async ({ request }) => {
        try {
          const { userId } = await requireDomainUser(request);
          const parsed = updateModuleApiInput.safeParse(await request.json());
          if (!parsed.success) return Response.json({ error: 'Invalid module fields' }, { status: 400 });
          return Response.json(await moduleRepository.updateModule(parsed.data.id, parsed.data, userId));
        } catch (error) {
          return moduleWriteError(error);
        }
      },
      DELETE: async ({ request }) => {
        try {
          const { userId } = await requireDomainUser(request);
          const parsed = deleteContentInput.safeParse(await request.json());
          if (!parsed.success) return Response.json({ error: 'Invalid deletion fields' }, { status: 400 });
          return Response.json(await deleteContent('module', parsed.data.id, userId));
        } catch (error) {
          return moduleWriteError(error);
        }
      },
    },
  },
});

function moduleWriteError(error: unknown) {
  if (error instanceof Response) return error;
  if (error instanceof SyntaxError) return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  console.error('Module write failed:', error);
  return Response.json({ error: 'Unable to save module; please retry' }, { status: 500 });
}
