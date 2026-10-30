import { and, eq } from 'drizzle-orm';
import { beatProgress, beats } from '../../domain/schema';
import { newId } from '~/db/ids';
import { safeQuery } from '~/config/db';

class BeatProgressRepository {
  async setBeatBestTempo(userId: string, beatId: string, tempo: number) {
    const [existing] = await safeQuery((db) =>
      db
        .select()
        .from(beatProgress)
        .where(and(eq(beatProgress.userId, userId), eq(beatProgress.beatId, beatId)))
        .limit(1)
    );
    if (!existing || existing.bestTempo == null || tempo > existing.bestTempo) {
      const [row] = await safeQuery((db) =>
        db
          .insert(beatProgress)
          .values({ id: newId(), userId, beatId, bestTempo: tempo })
          .onConflictDoUpdate({
            target: [beatProgress.userId, beatProgress.beatId],
            set: { bestTempo: tempo },
          })
          .returning()
      );
      return row;
    }
    return existing;
  }

  async getBeatProgressForModule(userId: string, moduleId: string) {
    return await safeQuery(async (db) => {
      const moduleBeats = await db.select().from(beats).where(eq(beats.moduleId, moduleId));
      return Promise.all(
        moduleBeats.map(async (beat) => {
          const [progress] = await db
            .select()
            .from(beatProgress)
            .where(and(eq(beatProgress.userId, userId), eq(beatProgress.beatId, beat.id)))
            .limit(1);
          return { ...beat, beatProgress: progress ? [progress] : [] };
        })
      );
    });
  }
}

export const beatProgressRepository = new BeatProgressRepository();
