import { createAPIFileRoute } from '@tanstack/react-start/api';
import { requireDomainUser } from '~/server/domain-session';

export const APIRoute = createAPIFileRoute('/api/session')({
  GET: async ({ request }) => {
    try {
      return Response.json(await requireDomainUser(request), { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      if (!(error instanceof Response)) throw error;
      error.headers.set('Cache-Control', 'no-store');
      return error;
    }
  },
});
