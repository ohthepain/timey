// src/config/db.ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    // log: ['query', 'info', 'warn', 'error'], // uncomment for debugging
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export async function safeQuery<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (
      e.code === 'P1001' || // can't reach DB
      e.message?.includes('Timed out') ||
      e.message?.includes('Connection pool')
    ) {
      console.warn('[safeQuery] Reconnecting Prisma...');
      await prisma.$disconnect();
      await prisma.$connect();
      return await fn(); // retry once
    }
    throw e;
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
});
process.on('SIGINT', async () => {
  await prisma.$disconnect();
});
