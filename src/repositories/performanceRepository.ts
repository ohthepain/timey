import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { beatNotes, performances } from '../../domain/schema';
import { newId } from '~/db/ids';
import { safeQuery, type DomainDb } from '~/config/db';
import { Performance } from '~/types/Performance';
import { musicalNote } from '~/types/beatWrites';

type Recording = Pick<Performance, 'beatId' | 'index'> & {
  notes: ReturnType<typeof musicalNote>[];
};

async function removeRecordings(tx: DomainDb, beatId: string, userId: string) {
  const owned = await tx
    .select({ id: performances.id })
    .from(performances)
    .where(and(eq(performances.beatId, beatId), eq(performances.userId, userId)));
  const performanceIds = owned.map((row) => row.id);
  if (performanceIds.length) {
    await tx.delete(beatNotes).where(and(isNull(beatNotes.beatId), inArray(beatNotes.performanceId, performanceIds)));
    await tx.delete(performances).where(inArray(performances.id, performanceIds));
  }
}

export const performanceRepository = {
  async replacePerformance(data: Recording, userId: string) {
    const created = await safeQuery((db) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([userId, data.beatId])}, 0))::text`
        );
        await removeRecordings(tx, data.beatId, userId);
        const performanceId = newId();
        const [row] = await tx
          .insert(performances)
          .values({ id: performanceId, beatId: data.beatId, index: data.index, userId })
          .returning();
        if (data.notes.length) {
          await tx.insert(beatNotes).values(
            data.notes.map((note) => ({
              id: newId(),
              ...note,
              performanceId,
            }))
          );
        }
        const notes = await tx.select().from(beatNotes).where(eq(beatNotes.performanceId, performanceId));
        return { ...row, notes };
      })
    );
    return new Performance(created);
  },

  async fetchPerformancesByBeatIdAndUserId(beatId: string, userId: string) {
    const rows = await safeQuery(async (db) => {
      const performancesForBeat = await db
        .select()
        .from(performances)
        .where(and(eq(performances.beatId, beatId), eq(performances.userId, userId)))
        .orderBy(desc(performances.createdAt));
      return Promise.all(
        performancesForBeat.map(async (row) => {
          const notes = await db.select().from(beatNotes).where(eq(beatNotes.performanceId, row.id));
          return { ...row, notes };
        })
      );
    });
    return rows.map((row) => new Performance(row));
  },

  async deletePerformancesByBeatIdAndUserId(beatId: string, userId: string) {
    return safeQuery((db) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([userId, beatId])}, 0))::text`
        );
        return removeRecordings(tx, beatId, userId);
      })
    );
  },
};
