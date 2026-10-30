import { createFileRoute } from '@tanstack/react-router';
import { requireDomainUser } from '~/server/domain-session';

export const Route = createFileRoute('/api/session')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          return Response.json(await requireDomainUser(request), { headers: { 'Cache-Control': 'no-store' } });
        } catch (error) {
          if (!(error instanceof Response)) throw error;
          error.headers.set('Cache-Control', 'no-store');
          return error;
        }
      },
    },
  },
});
