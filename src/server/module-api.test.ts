import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APIRoute } from '~/routes/api/modules';
import { requireDomainUser } from '~/server/domain-session';
import { moduleRepository } from '~/repositories/moduleRepository';

vi.mock('@tanstack/react-start', () => ({ json: (value: unknown, init?: ResponseInit) => Response.json(value, init) }));
vi.mock('@tanstack/react-start/api', () => ({ createAPIFileRoute: () => (methods: unknown) => ({ methods }) }));
vi.mock('~/server/domain-session', () => ({ requireDomainUser: vi.fn() }));
vi.mock('~/repositories/moduleRepository', () => ({
  moduleRepository: { createModule: vi.fn(), updateModule: vi.fn() },
}));

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
    expect((await APIRoute.methods.POST!(request({ title: 'Module', methodId: 'parent' }) as never)).status).toBe(
      status
    );
    expect(moduleRepository.createModule).not.toHaveBeenCalled();
  });
  it.each(['authorId', 'userId', 'role', 'token', 'enableAdmin'])('rejects client %s on both writes', async (field) => {
    const create = await APIRoute.methods.POST!(
      request({ title: 'Module', methodId: 'parent', [field]: 'forged' }) as never
    );
    const update = await APIRoute.methods.PUT!(
      request({ id: 'selected', title: 'Edited', [field]: 'forged' }) as never
    );
    expect([create.status, update.status]).toEqual([400, 400]);
    expect(moduleRepository.createModule).not.toHaveBeenCalled();
    expect(moduleRepository.updateModule).not.toHaveBeenCalled();
  });
  it('passes the selected ID and destination with the trusted identity', async () => {
    vi.mocked(moduleRepository.updateModule).mockResolvedValue({ id: 'selected' } as never);
    const result = await APIRoute.methods.PUT!(request({ id: 'selected', methodId: 'destination' }) as never);
    expect(result.status).toBe(200);
    expect(moduleRepository.updateModule).toHaveBeenCalledWith(
      'selected',
      { id: 'selected', methodId: 'destination' },
      'trusted'
    );
  });
});
