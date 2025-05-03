import prisma from '../config/db';
import { Beat } from '~/types/Beat';

class BeatRepository {
  getBeatById(id: string) {
    const data = prisma.beat.findUnique({ where: { id }, include: { beatNotes: true } });
    return data ? new Beat(data) : null;
  }

  getBeatWithModuleAndMethod(beatId: string) {
    const data = prisma.beat.findUnique({
      where: { id: beatId },
      include: {
        module: {
          include: {
            method: true,
          },
        },
      },
    });
    return data ? new Beat(data) : null;
  }

  getBeatWithPerformances(beatId: string, userId: string) {
    console.log('Fetching beat with performances for user:', userId);
    console.log('Fetching beat with performances for beatId:', beatId);
    const data = prisma.beat.findUnique({
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
    });
    return data ? new Beat(data) : null;
  }

  getBeatsByUser(userId: string) {
    return prisma.beat
      .findMany({ where: { authorId: userId }, include: { beatNotes: true } })
      .then((data) => data.map((b) => new Beat(b)));
  }

  getBeatByName(name: string) {
    const data = prisma.beat.findFirst({ where: { name: name }, include: { beatNotes: true } });
    return data ? new Beat(data) : null;
  }

  createBeat(data: any) {
    if (data.index === undefined || data.index === null) {
      throw new Error('Index is required and cannot be null or undefined');
    }
    return prisma.beat.create({
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
    });
  }

  updateBeat(id: string, data: any) {
    return prisma.beat.update({
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
    });
  }

  deleteBeat(id: string) {
    const data = prisma.beat.delete({ where: { id } });
    return data ? new Beat(data) : null;
  }
}

export const beatRepository = new BeatRepository();
