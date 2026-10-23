import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { client, PrismaClient } = vi.hoisted(() => {
  const client = { $connect: vi.fn(), $disconnect: vi.fn() };
  return {
    client,
    PrismaClient: vi.fn(function () {
      return client;
    }),
  };
});

vi.mock('@prisma/client', () => ({ PrismaClient }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Reflect.deleteProperty(globalThis, 'prisma');
  vi.spyOn(process, 'on').mockReturnValue(process);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'prisma');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('server database access', () => {
  it('allows browser imports without constructing a client and rejects query execution', async () => {
    const { getServerPrisma, safeQuery } = await import('./db');
    const query = vi.fn();
    expect(PrismaClient).not.toHaveBeenCalled();
    expect(getServerPrisma).toThrow('Database not available on client side');
    await expect(safeQuery(query)).rejects.toThrow('Database not available on client side');
    expect(query).not.toHaveBeenCalled();
  });

  it('passes the checked server client to the query and returns its result', async () => {
    vi.stubGlobal('window', undefined);
    const { getServerPrisma, safeQuery } = await import('./db');
    const query = vi.fn(async () => ({ id: 'fixture' }));
    expect(getServerPrisma()).toBe(client);
    await expect(safeQuery(query)).resolves.toEqual({ id: 'fixture' });
    expect(query).toHaveBeenCalledExactlyOnceWith(client);
    expect(PrismaClient).toHaveBeenCalledTimes(1);
  });

  it.each([{ code: 'P1001' }, new Error('Timed out'), new Error('Connection pool unavailable')])(
    'reconnects and retries once for an existing retry condition: %o',
    async (error) => {
      vi.stubGlobal('window', undefined);
      const { safeQuery } = await import('./db');
      const query = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('ok');
      await expect(safeQuery(query)).resolves.toBe('ok');
      expect(query.mock.calls).toEqual([[client], [client]]);
      expect(client.$disconnect).toHaveBeenCalledTimes(1);
      expect(client.$connect).toHaveBeenCalledTimes(1);
    }
  );

  it('propagates the second failure without retrying again', async () => {
    vi.stubGlobal('window', undefined);
    const { safeQuery } = await import('./db');
    const error = new Error('Timed out');
    const query = vi.fn().mockRejectedValue(error);
    await expect(safeQuery(query)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(2);
    expect(client.$connect).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect for unrelated errors', async () => {
    vi.stubGlobal('window', undefined);
    const { safeQuery } = await import('./db');
    const error = new Error('Invalid query');
    const query = vi.fn().mockRejectedValue(error);
    await expect(safeQuery(query)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
    expect(client.$disconnect).not.toHaveBeenCalled();
    expect(client.$connect).not.toHaveBeenCalled();
  });
});
