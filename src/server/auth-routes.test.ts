// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { APIRoute as authRoute } from '../routes/api/auth/$';
import { APIRoute as sessionRoute } from '../routes/api/session';
import { getAuth } from './auth';
import { requireDomainUser } from './domain-session';

vi.mock('@tanstack/react-start/api', () => ({
  createAPIFileRoute: (path: string) => (methods: object) => ({ path, methods }),
}));
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
    expect(await authRoute.methods.POST!({ request, params: {} })).toBe(response);
    expect(handler).toHaveBeenCalledWith(request);
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it('returns only the provisioned ID with private caching', async () => {
    vi.mocked(requireDomainUser).mockResolvedValue({ userId: 'trusted' });
    const response = await sessionRoute.methods.GET!({ request, params: {} });
    expect(await response.json()).toEqual({ userId: 'trusted' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each([401, 503])('preserves boundary failure %s without returning an identity', async (status) => {
    vi.mocked(requireDomainUser).mockRejectedValue(new Response('Blocked', { status }));
    const response = await sessionRoute.methods.GET!({ request, params: {} });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe('Blocked');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
