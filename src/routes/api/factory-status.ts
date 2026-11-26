import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const discovery = z.object({
  port: z.number().int().min(1).max(65535),
  instanceId: z.string().regex(/^[a-f0-9]{32}$/),
});

async function reachableFactoryUrl(): Promise<string | null> {
  try {
    const record = discovery.parse(
      JSON.parse(await readFile(join(process.cwd(), '.issues/factory-discovery.json'), 'utf8'))
    );
    const origin = `http://127.0.0.1:${record.port}`;
    const response = await fetch(origin + '/api/health', {
      redirect: 'error',
      signal: AbortSignal.timeout(1000),
    });
    return response.status === 204 && response.headers.get('X-Factory-Instance') === record.instanceId
      ? origin + '/'
      : null;
  } catch {
    return null;
  }
}

export const Route = createFileRoute('/api/factory-status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { hostname } = new URL(request.url);
        const local = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
        return Response.json(
          { url: local ? await reachableFactoryUrl() : null },
          {
            headers: { 'Cache-Control': 'no-store' },
          }
        );
      },
    },
  },
});
