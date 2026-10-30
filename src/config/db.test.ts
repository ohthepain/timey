import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { client, drizzleMock } = vi.hoisted(() => {
  const client = { end: vi.fn(), query: vi.fn() };
  const db = { transaction: vi.fn(), select: vi.fn() };
  return {
    client,
    drizzleMock: vi.fn(() => db),
    db,
  };
});

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(function () {
      return client;
    }),
  },
}));

vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: drizzleMock,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Reflect.deleteProperty(globalThis, 'domainPool');
  Reflect.deleteProperty(globalThis, 'domainDb');
  vi.spyOn(process, 'on').mockReturnValue(process);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  process.env.DATABASE_URL = 'postgresql://postgres:password@localhost:5432/timey_db?schema=domain';
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'domainPool');
  Reflect.deleteProperty(globalThis, 'domainDb');
  delete process.env.DATABASE_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('server database access', () => {
  it('allows browser imports without constructing a client and rejects query execution', async () => {
    const { getServerDb, safeQuery } = await import('./db');
    const query = vi.fn();
    expect(drizzleMock).not.toHaveBeenCalled();
    expect(getServerDb).toThrow('Database not available on client side');
    await expect(safeQuery(query)).rejects.toThrow('Database not available on client side');
    expect(query).not.toHaveBeenCalled();
  });

  it('passes the checked server client to the query and returns its result', async () => {
    vi.stubGlobal('window', undefined);
    const { getServerDb, safeQuery } = await import('./db');
    const query = vi.fn(async () => ({ id: 'fixture' }));
    const db = getServerDb();
    await expect(safeQuery(query)).resolves.toEqual({ id: 'fixture' });
    expect(query).toHaveBeenCalledExactlyOnceWith(db);
    expect(drizzleMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error('Timed out'),
    new Error('Connection pool unavailable'),
    new Error('connection terminated unexpectedly'),
  ])('reconnects and retries once for an existing retry condition: %o', async (error) => {
    vi.stubGlobal('window', undefined);
    const { safeQuery } = await import('./db');
    const query = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('ok');
    await expect(safeQuery(query)).resolves.toBe('ok');
    expect(query).toHaveBeenCalledTimes(2);
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(drizzleMock).toHaveBeenCalledTimes(2);
  });

  it('propagates the second failure without retrying again', async () => {
    vi.stubGlobal('window', undefined);
    const { safeQuery } = await import('./db');
    const error = new Error('Timed out');
    const query = vi.fn().mockRejectedValue(error);
    await expect(safeQuery(query)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(2);
    expect(drizzleMock).toHaveBeenCalledTimes(2);
  });

  it('does not reconnect for unrelated errors', async () => {
    vi.stubGlobal('window', undefined);
    const { safeQuery } = await import('./db');
    const error = new Error('Invalid query');
    const query = vi.fn().mockRejectedValue(error);
    await expect(safeQuery(query)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
    expect(client.end).not.toHaveBeenCalled();
  });
});
