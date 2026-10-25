import { safeQuery } from '../config/db';
import type { Prisma } from '@prisma/client';
import { Performance } from '~/types/Performance';

type Recording = Pick<Performance, 'beatId' | 'index'> & { notes: Prisma.BeatNoteCreateWithoutPerformanceInput[] };

async function removeRecordings(tx: Prisma.TransactionClient, beatId: string, userId: string) {
  // Notes with a beatId belong to content, even if legacy data also links a performance.
  await tx.beatNote.deleteMany({ where: { beatId: null, Performance: { beatId, userId } } });
  return tx.performance.deleteMany({ where: { beatId, userId } });
}

export const performanceRepository = {
  async replacePerformance(data: Recording, userId: string) {
    const created = await safeQuery((prisma) =>
      prisma.$transaction(async (tx) => {
        // Serialize replacement for this owner/beat, including the first save.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([userId, data.beatId])}, 0))::text`;
        await removeRecordings(tx, data.beatId, userId);
        return tx.performance.create({
          data: { beatId: data.beatId, index: data.index, userId, notes: { create: data.notes } },
          include: { notes: true },
        });
      })
    );
    return new Performance(created);
  },

  async fetchPerformancesByBeatIdAndUserId(beatId: string, userId: string) {
    const rows = await safeQuery((prisma) =>
      prisma.performance.findMany({
        where: { beatId, userId },
        include: { notes: true },
        orderBy: { createdAt: 'desc' },
      })
    );
    return rows.map((row) => new Performance(row));
  },

  async deletePerformancesByBeatIdAndUserId(beatId: string, userId: string) {
    return safeQuery((prisma) =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([userId, beatId])}, 0))::text`;
        return removeRecordings(tx, beatId, userId);
      })
    );
  },
};
