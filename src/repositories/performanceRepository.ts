import prisma from '../config/db';
import { Performance } from '~/types/Performance';
import { beatRepository } from './beatRepository';

export const performanceRepository = {
  async createPerformance(data: Omit<Performance, 'id' | 'createdAt' | 'modifiedAt'>) {
    const beat = await beatRepository.getBeatById(data.beatId);
    return prisma.performance.create({
      data: {
        ...data,
        notes: {
          create: data.notes.map((note) => ({
            ...note,
            beat: { connect: { id: beat!.id } }, // Transform 'beat' to the expected type
          })),
        },
      },
      include: { notes: true },
    });
  },

  async getPerformanceById(id: string) {
    const prismaPerformance = await prisma.performance.findUnique({
      where: { id },
      include: { notes: true },
    });
    return new Performance(prismaPerformance);
  },

  async getPerformancesByBeatId(beatId: string) {
    const prismaPerformance = await prisma.performance.findMany({
      where: { beatId },
      include: { notes: true },
    });
    return new Performance(prismaPerformance);
  },

  async getPerformancesByUserId(userId: string) {
    const prismaPerformances = await prisma.performance.findMany({
      where: { userId },
      include: { notes: true },
    });
    return prismaPerformances.map((perf) => new Performance(perf));
  },

  async getPerformancesByBeatIdAndUserId(beatId: string, userId: string) {
    const prismaPerformances = await prisma.performance.findMany({
      where: { beatId, userId },
      include: { notes: true },
    });
    return prismaPerformances.map((perf) => new Performance(perf));
  },

  async deletePerformance(id: string) {
    return prisma.performance.delete({
      where: { id },
    });
  },

  async deletePerformancesByBeatIdAndUserId(beatId: string, userId: string) {
    return prisma.performance.deleteMany({
      where: { beatId, userId },
    });
  },
};
