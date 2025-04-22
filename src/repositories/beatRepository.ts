import prisma from '../config/db';

class BeatRepository {
  getBeatById(id: string) {
    return prisma.beat.findUnique({ where: { id }, include: { beatNotes: true } });
  }

  getBeatWithModuleAndMethod(beatId: string) {
    return prisma.beat.findUnique({
      where: { id: beatId },
      include: {
        module: {
          include: {
            method: true,
          },
        },
      },
    });
  }

  getBeatsByUser(userId: string) {
    return prisma.beat.findMany({ where: { authorId: userId }, include: { beatNotes: true } });
  }

  getBeatByName(name: string) {
    return prisma.beat.findFirst({ where: { name: name }, include: { beatNotes: true } });
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
    return prisma.beat.delete({ where: { id } });
  }
}

export const beatRepository = new BeatRepository();
