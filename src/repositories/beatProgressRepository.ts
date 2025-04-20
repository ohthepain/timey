import prisma from '~/config/db';

export const setBeatBestTempo = async (userId: string, beatId: string, tempo: number) => {
  const existing = await prisma.beatProgress.findUnique({
    where: { userId_beatId: { userId, beatId } },
  });
  if (!existing || existing.bestTempo == null || tempo > existing.bestTempo) {
    return prisma.beatProgress.upsert({
      where: { userId_beatId: { userId, beatId } },
      update: { bestTempo: tempo },
      create: { userId, beatId, bestTempo: tempo },
    });
  }
  return existing;
};
