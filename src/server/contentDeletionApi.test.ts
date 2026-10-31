import { describe, expect, it, vi } from 'vite-plus/test';

const { identity, remove } = vi.hoisted(() => ({ identity: vi.fn(), remove: vi.fn() }));
vi.mock('~/server/domain-session', () => ({ requireDomainUser: identity }));
vi.mock('~/repositories/contentDeletion', () => ({ deleteContent: remove }));
import { Route } from '../routes/api/beats.$id';
const route = Route.options.server!.handlers as unknown as {
  DELETE: (ctx: { params: { id: string }; request: Request }) => Promise<Response>;
};

function request(url = 'http://localhost/api/beats/target', body?: string) {
  return route.DELETE({ params: { id: 'target' }, request: new Request(url, { method: 'DELETE', body }) });
}

describe('beat DELETE boundary', () => {
  it('uses only the validated identity and waits for transactional completion', async () => {
    identity.mockResolvedValue({ userId: 'trusted' });
    remove.mockResolvedValue({ success: true });
    expect(await (await request()).json()).toEqual({ success: true });
    expect(remove).toHaveBeenLastCalledWith('beat', 'target', 'trusted');
  });
  it('rejects query ownership claims and unexpected bodies before cleanup', async () => {
    remove.mockClear();
    expect((await request('http://localhost/api/beats/target?authorId=other')).status).toBe(400);
    expect((await request(undefined, '{"role":"admin"}')).status).toBe(400);
    expect(remove).not.toHaveBeenCalled();
  });
  it('preserves session denial and transaction failures as failures', async () => {
    identity.mockRejectedValueOnce(new Response('Authentication required', { status: 401 }));
    expect((await request()).status).toBe(401);
    remove.mockRejectedValueOnce(new Error('write failed'));
    expect((await request()).status).toBe(500);
  });
});
