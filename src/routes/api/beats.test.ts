import { beforeEach, expect, it, vi } from 'vite-plus/test';
const mocks = vi.hoisted(() => ({ domain: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock('~/server/domain-session', () => ({ requireDomainUser: mocks.domain }));
vi.mock('~/repositories/beatRepository', () => ({
  beatRepository: { createBeat: mocks.create, updateBeat: mocks.update },
}));
import { Route } from './beats';
const input = { name: 'Beat', moduleId: 'destination', index: 0, beatString: 'note,0,8,[g/4],0,0,0,0,1' };
const putBeat = (
  Route.options.server!.handlers as unknown as {
    PUT: (ctx: { request: Request }) => Promise<Response>;
  }
).PUT;
async function put(data: unknown) {
  return putBeat({
    request: new Request('http://localhost/api/beats', { method: 'PUT', body: JSON.stringify(data) }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.domain.mockResolvedValue({ userId: 'trusted' });
  mocks.create.mockResolvedValue({ id: 'created' });
});
it('creation rejects authority fields and passes only validated session authorship', async () => {
  expect((await put({ ...input, authorId: 'forged' })).status).toBe(400);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await put(input)).status).toBe(200);
  expect(mocks.create.mock.calls[0][1]).toBe('trusted');
});
it('creation propagates invalid session and ownership responses', async () => {
  mocks.domain.mockRejectedValueOnce(new Response('Authentication required', { status: 401 }));
  expect((await put(input)).status).toBe(401);
  mocks.create.mockRejectedValueOnce(new Response('Destination denied', { status: 403 }));
  expect((await put(input)).status).toBe(403);
});
it('existing editing uses only the validated session and rejects forged claims', async () => {
  mocks.update.mockResolvedValue({ id: 'existing' });
  expect((await put({ ...input, id: 'existing' })).status).toBe(200);
  expect(mocks.update.mock.calls[0][2]).toBe('trusted');
  expect((await put({ ...input, id: 'existing', authorId: 'forged' })).status).toBe(400);
});
