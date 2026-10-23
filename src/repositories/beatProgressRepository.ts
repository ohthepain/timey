import { getServerPrisma, safeQuery } from '~/config/db';

class BeatProgressRepository {
  async setBeatBestTempo(userId: string, beatId: string, tempo: number) {
    const existing = await getServerPrisma().beatProgress.findUnique({
      where: { userId_beatId: { userId, beatId } },
    });
    if (!existing || existing.bestTempo == null || tempo > existing.bestTempo) {
      return await safeQuery((prisma) =>
        prisma.beatProgress.upsert({
          where: { userId_beatId: { userId, beatId } },
          update: { bestTempo: tempo },
          create: { userId, beatId, bestTempo: tempo },
        })
      );
    }
    return existing;
  }

  async getBeatProgressForModule(userId: string, moduleId: string) {
    return await safeQuery((prisma) =>
      prisma.beat.findMany({
        where: { moduleId },
        include: {
          beatProgress: {
            where: { userId },
          },
        },
      })
    );
  }
}

export const beatProgressRepository = new BeatProgressRepository();
