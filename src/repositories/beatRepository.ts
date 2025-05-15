import { prisma, safeQuery } from '../config/db';
import { Beat } from '~/types/Beat';
import { Method } from '~/types/Method';
import { Module } from '~/types/Module';

class BeatRepository {
  async getBeatById(id: string) {
    const data = await safeQuery(() => prisma.beat.findUnique({ where: { id }, include: { beatNotes: true } }));
    return data ? new Beat(data) : null;
  }

  async getBeatWithModuleAndMethod(beatId: string) {
    const data = await safeQuery(() =>
      prisma.beat.findUnique({
        where: { id: beatId },
        include: {
          module: {
            include: {
              method: true,
            },
          },
          beatNotes: true,
        },
      })
    );
    if (!data) return null;
    // Wrap related objects with their constructors
    const method = data.module?.method ? new Method(data.module.method) : undefined;
    const module = data.module ? new Module({ ...data.module, method }) : undefined;
    return new Beat({ ...data, module });
  }

  async getBeatWithPerformances(beatId: string, userId: string) {
    console.log('Fetching beat with performances for user:', userId);
    console.log('Fetching beat with performances for beatId:', beatId);
    const data = await safeQuery(() =>
      prisma.beat.findUnique({
        where: { id: beatId },
        include: {
          module: {
            include: {
              method: true,
            },
          },
          performances: {
            where: { userId: userId },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { notes: true },
          },
        },
      })
    );
    return data ? new Beat(data) : null;
  }

  async getBeatsByUser(userId: string) {
    return await safeQuery(() =>
      prisma.beat
        .findMany({ where: { authorId: userId }, include: { beatNotes: true } })
        .then((data) => data.map((b) => new Beat(b)))
    );
  }

  async getBeatByName(name: string) {
    const data = await safeQuery(() => prisma.beat.findFirst({ where: { name: name }, include: { beatNotes: true } }));
    return data ? new Beat(data) : null;
  }

  async createBeat(data: any) {
    if (data.index === undefined || data.index === null) {
      throw new Error('Index is required and cannot be null or undefined');
    }
    return await safeQuery(() =>
      prisma.beat.create({
        data: {
          name: data.name,
          description: data.description,
          index: data.index,
          authorId: data.authorId,
          moduleId: data.moduleId,
          beatNotes: {
            create: data.beatNotes,
          },
        },
        include: { beatNotes: true },
      })
    );
  }

  async updateBeat(id: string, data: any) {
    return await safeQuery(() =>
      prisma.beat.update({
        where: { id },
        data: {
          name: data.name,
          description: data.description,
          index: data.index,
          moduleId: data.moduleId,
          beatNotes: {
            deleteMany: {},
            create: data.beatNotes,
          },
        },
        include: { beatNotes: true },
      })
    );
  }

  async deleteBeat(id: string) {
    const data = await safeQuery(() => prisma.beat.delete({ where: { id } }));
    return data ? new Beat(data) : null;
  }
}

export const beatRepository = new BeatRepository();
