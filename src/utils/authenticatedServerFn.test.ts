import { beforeEach, expect, expectTypeOf, it, vi } from 'vitest';
import { withAuth } from './authenticatedServerFn';
import { ensureKeycloakUser } from '~/lib/ensureKeycloakUser';

vi.mock('~/lib/ensureKeycloakUser', () => ({ ensureKeycloakUser: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

it('preserves the handler result type and forwards the token and database user ID', async () => {
  vi.mocked(ensureKeycloakUser).mockResolvedValue('database-user');
  const handler = vi.fn(async (_ctx: unknown, userId: string) => [{ beatId: 'beat', userId }]);
  const wrapped = withAuth(handler);
  expectTypeOf<ReturnType<typeof wrapped>>().toEqualTypeOf<Promise<{ beatId: string; userId: string }[]>>();
  const ctx = { data: { token: 'fixture-token' } };
  await expect(wrapped(ctx)).resolves.toEqual([{ beatId: 'beat', userId: 'database-user' }]);
  expect(ensureKeycloakUser).toHaveBeenCalledWith('fixture-token');
  expect(handler).toHaveBeenCalledWith(ctx, 'database-user');
});

it('rejects an unauthenticated call before invoking the handler', async () => {
  vi.mocked(ensureKeycloakUser).mockResolvedValue(null);
  const handler = vi.fn(async () => []);
  await expect(withAuth(handler)({ data: {} })).rejects.toThrow('Authentication required');
  expect(handler).not.toHaveBeenCalled();
});
