// src/config/db.ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Only create Prisma client on server side
let prisma: PrismaClient | null = null;

if (typeof window === 'undefined') {
  // Server-side only
  prisma =
    globalForPrisma.prisma ||
    new PrismaClient({
      // log: ['query', 'info', 'warn', 'error'], // uncomment for debugging
    });

  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
  }

  // Graceful shutdown - only on server side
  if (typeof process !== 'undefined' && process.on) {
    process.on('SIGTERM', async () => {
      await prisma?.$disconnect();
    });
    process.on('SIGINT', async () => {
      await prisma?.$disconnect();
    });
  }
}

export function getServerPrisma(): PrismaClient {
  if (typeof window !== 'undefined' || !prisma) {
    throw new Error('Database not available on client side');
  }
  return prisma;
}

/**
 * Executes a database query with retry logic for specific errors.
 *
 * If the query fails due to a database connection issue (e.g., error code P1001,
 * "Timed out", or "Connection pool"), the function will attempt to reconnect
 * to the database and retry the query once.
 *
 * @template T - The type of the result returned by the query.
 * @param {(client: PrismaClient) => Promise<T>} fn - A function that performs the database query.
 * @returns {Promise<T>} The result of the query.
 * @throws Will rethrow the original error if it is not a connection issue or if
 *         the retry attempt also fails.
 */
export async function safeQuery<T>(fn: (client: PrismaClient) => Promise<T>): Promise<T> {
  const client = getServerPrisma();

  try {
    return await fn(client);
  } catch (e: any) {
    if (
      e.code === 'P1001' || // can't reach DB
      e.message?.includes('Timed out') ||
      e.message?.includes('Connection pool')
    ) {
      console.warn('[safeQuery] Reconnecting Prisma...');
      await client.$disconnect();
      await client.$connect();
      return await fn(client); // retry once
    }
    throw e;
  }
}
