import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const globalForDb = globalThis as unknown as { domainPool?: pg.Pool; domainDb?: DomainDb };

export type DomainDb = NodePgDatabase;

let pool: pg.Pool | null = null;
let db: DomainDb | null = null;

function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for domain database access');
  return url;
}

function createPool() {
  return new pg.Pool({ connectionString: connectionString() });
}

if (typeof window === 'undefined') {
  pool = globalForDb.domainPool ?? createPool();
  db = globalForDb.domainDb ?? drizzle({ client: pool });
  if (process.env.NODE_ENV !== 'production') {
    globalForDb.domainPool = pool;
    globalForDb.domainDb = db;
  }
  if (typeof process !== 'undefined' && process.on) {
    const close = async () => {
      await pool?.end();
    };
    process.on('SIGTERM', close);
    process.on('SIGINT', close);
  }
}

export function getServerDb(): DomainDb {
  if (typeof window !== 'undefined' || !db) {
    throw new Error('Database not available on client side');
  }
  return db;
}

function isConnectionError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('timed out') ||
    message.includes('connection pool') ||
    message.includes('connection terminated') ||
    message.includes('econnrefused') ||
    message.includes('cannot connect')
  );
}

async function reconnect() {
  await pool?.end();
  pool = createPool();
  db = drizzle({ client: pool });
  if (process.env.NODE_ENV !== 'production') {
    globalForDb.domainPool = pool;
    globalForDb.domainDb = db;
  }
}

/** Executes a database query with one reconnect retry for transient pool failures. */
export async function safeQuery<T>(fn: (client: DomainDb) => Promise<T>): Promise<T> {
  const client = getServerDb();
  try {
    return await fn(client);
  } catch (error) {
    if (!isConnectionError(error)) throw error;
    console.warn('[safeQuery] Reconnecting domain database pool...');
    await reconnect();
    return await fn(getServerDb());
  }
}
