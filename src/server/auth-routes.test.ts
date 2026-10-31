// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';
import { Route as authRoute } from '../routes/api/auth/$';
import { Route as sessionRoute } from '../routes/api/session';
import { getAuth } from './auth';
import { requireDomainUser } from './domain-session';

vi.mock('./auth', () => ({ getAuth: vi.fn() }));
vi.mock('./domain-session', () => ({ requireDomainUser: vi.fn() }));

const request = new Request('http://localhost/api/session');

describe('auth HTTP response boundaries', () => {
  it('preserves the original auth response and every Set-Cookie header', async () => {
    const response = new Response(null, { status: 200 });
    response.headers.append('Set-Cookie', 'session=first; HttpOnly');
    response.headers.append('Set-Cookie', 'preference=second; HttpOnly');
    const handler = vi.fn().mockResolvedValue(response);
    vi.mocked(getAuth).mockResolvedValue({ handler } as unknown as Awaited<ReturnType<typeof getAuth>>);
    const authHandlers = authRoute.options.server!.handlers as unknown as {
      POST: (ctx: { request: Request }) => Promise<Response>;
    };
    expect(await authHandlers.POST({ request })).toBe(response);
    expect(handler).toHaveBeenCalledWith(request);
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it('returns only the provisioned ID with private caching', async () => {
    vi.mocked(requireDomainUser).mockResolvedValue({ userId: 'trusted' });
    const sessionHandlers = sessionRoute.options.server!.handlers as unknown as {
      GET: (ctx: { request: Request }) => Promise<Response>;
    };
    const response = await sessionHandlers.GET({ request });
    expect(await response.json()).toEqual({ userId: 'trusted' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each([401, 503])('preserves boundary failure %s without returning an identity', async (status) => {
    vi.mocked(requireDomainUser).mockRejectedValue(new Response('Blocked', { status }));
    const sessionHandlers = sessionRoute.options.server!.handlers as unknown as {
      GET: (ctx: { request: Request }) => Promise<Response>;
    };
    const response = await sessionHandlers.GET({ request });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe('Blocked');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
