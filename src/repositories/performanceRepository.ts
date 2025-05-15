import { prisma, safeQuery } from '../config/db';
import { Performance as PrismaPerformance } from '@prisma/client';
import { Performance } from '~/types/Performance';

export const performanceRepository = {
  async createPerformance(data: Omit<Performance, 'userId' | 'id' | 'createdAt' | 'modifiedAt'>, userId: string) {
    const created = await safeQuery(() =>
      prisma.performance.create({
        data: {
          beatId: data.beatId,
          index: data.index,
          userId,
          notes: {
            create: data.notes.map((note) => ({
              ...note,
              // Remove any fields not in the DB schema if needed
            })),
          },
        },
        include: { notes: true },
      })
    );
    return new Performance(created);
  },

  async getPerformanceById(id: string) {
    const prismaPerformance = await safeQuery(() =>
      prisma.performance.findUnique({
        where: { id },
        include: { notes: true },
      })
    );
    return new Performance(prismaPerformance);
  },

  async getPerformancesByBeatId(beatId: string) {
    const prismaPerformance = await safeQuery(() =>
      prisma.performance.findMany({
        where: { beatId },
        include: { notes: true },
      })
    );
    return new Performance(prismaPerformance);
  },

  async getPerformancesByUserId(userId: string) {
    const prismaPerformances = await safeQuery(() =>
      prisma.performance.findMany({
        where: { userId },
        include: { notes: true },
      })
    );
    return prismaPerformances.map((perf: PrismaPerformance) => new Performance(perf));
  },

  async fetchPerformancesByBeatIdAndUserId(beatId: string, userId: string) {
    const prismaPerformances = await safeQuery(() =>
      prisma.performance.findMany({
        where: { beatId, userId },
        include: { notes: true },
      })
    );
    return prismaPerformances.map((perf: PrismaPerformance) => new Performance(perf));
  },

  async deletePerformance(id: string) {
    return await safeQuery(() =>
      prisma.performance.delete({
        where: { id },
      })
    );
  },

  async deletePerformancesByBeatIdAndUserId(beatId: string, userId: string) {
    return await safeQuery(() =>
      prisma.performance.deleteMany({
        where: { beatId, userId },
      })
    );
  },
};
