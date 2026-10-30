import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { Route } from '~/routes/api/modules';
import { requireDomainUser } from '~/server/domain-session';
import { moduleRepository } from '~/repositories/moduleRepository';

vi.mock('~/server/domain-session', () => ({ requireDomainUser: vi.fn() }));
vi.mock('~/repositories/moduleRepository', () => ({
  moduleRepository: { createModule: vi.fn(), updateModule: vi.fn() },
}));

const handlers = Route.options.server!.handlers as unknown as {
  POST: (ctx: { request: Request }) => Promise<Response>;
  PUT: (ctx: { request: Request }) => Promise<Response>;
};
const request = (body: unknown) => ({
  request: new Request('http://localhost/api/modules', { method: 'POST', body: JSON.stringify(body) }),
});

describe('module API write boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireDomainUser).mockResolvedValue({ userId: 'trusted' });
  });
  it.each([401, 503])('returns session/profile failure %s before repository work', async (status) => {
    vi.mocked(requireDomainUser).mockRejectedValue(new Response('Unavailable', { status }));
    expect((await handlers.POST(request({ title: 'Module', methodId: 'parent' }))).status).toBe(status);
    expect(moduleRepository.createModule).not.toHaveBeenCalled();
  });
  it.each(['authorId', 'userId', 'role', 'token', 'enableAdmin'])('rejects client %s on both writes', async (field) => {
    const create = await handlers.POST(request({ title: 'Module', methodId: 'parent', [field]: 'forged' }));
    const update = await handlers.PUT(request({ id: 'selected', title: 'Edited', [field]: 'forged' }));
    expect([create.status, update.status]).toEqual([400, 400]);
    expect(moduleRepository.createModule).not.toHaveBeenCalled();
    expect(moduleRepository.updateModule).not.toHaveBeenCalled();
  });
  it('passes the selected ID and destination with the trusted identity', async () => {
    vi.mocked(moduleRepository.updateModule).mockResolvedValue({ id: 'selected' } as never);
    const result = await handlers.PUT(request({ id: 'selected', methodId: 'destination' }));
    expect(result.status).toBe(200);
    expect(moduleRepository.updateModule).toHaveBeenCalledWith(
      'selected',
      { id: 'selected', methodId: 'destination' },
      'trusted'
    );
  });
});
