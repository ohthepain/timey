import { beforeEach, expect, it, vi } from 'vitest';
import { withAuth } from './authenticatedServerFn';
import { requireDomainUser } from '~/server/domain-session';

vi.mock('@tanstack/react-start/server', () => ({ getWebRequest: vi.fn(() => new Request('http://localhost')) }));
vi.mock('~/server/domain-session', () => ({ requireDomainUser: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

it('passes the provisioned domain user id to the handler', async () => {
  const handler = vi.fn().mockResolvedValue('ok');
  vi.mocked(requireDomainUser).mockResolvedValue({ userId: 'database-user' });

  const wrapped = withAuth(handler);
  await expect(wrapped({ data: {} })).resolves.toBe('ok');
  expect(handler).toHaveBeenCalledWith({ data: {} }, 'database-user');
});

it('rejects unauthenticated requests', async () => {
  vi.mocked(requireDomainUser).mockRejectedValue(new Response('Authentication required', { status: 401 }));
  const handler = vi.fn();
  await expect(withAuth(handler)({ data: {} })).rejects.toThrow('Authentication required');
});
