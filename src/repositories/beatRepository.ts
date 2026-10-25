import type { Beat as BeatRow, Module as ModuleRow, Prisma } from '@prisma/client';
import { type NewBeat, musicalNote, copiedBeatName } from '~/types/beatWrites';
import { safeQuery } from '../config/db';
import { Beat } from '~/types/Beat';
import { Performance } from '~/types/Performance';
import { Method } from '~/types/Method';
import { Module } from '~/types/Module';

class BeatRepository {
  async getBeatById(id: string) {
    const data = await safeQuery((prisma) =>
      prisma.beat.findUnique({ where: { id }, include: { beatNotes: { where: { performanceId: null } } } })
    );
    return data ? new Beat(data) : null;
  }

  async getBeatWithModuleAndMethod(beatId: string) {
    const data = await safeQuery((prisma) =>
      prisma.beat.findUnique({
        where: { id: beatId },
        include: {
          module: {
            include: {
              method: true,
            },
          },
          beatNotes: { where: { performanceId: null } },
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
    const data = await safeQuery((prisma) =>
      prisma.beat.findUnique({
        where: { id: beatId },
        include: {
          module: {
            include: {
              method: true,
            },
          },
          beatNotes: { where: { performanceId: null } },
          performances: {
            where: { userId: userId },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { notes: true },
          },
        },
      })
    );
    return data
      ? {
          ...new Beat(data).toJSON(),
          performances: data.performances.map((performance) => new Performance(performance).toJSON()),
        }
      : null;
  }

  async getBeatsByUser(userId: string) {
    return await safeQuery((prisma) =>
      prisma.beat
        .findMany({ where: { authorId: userId }, include: { beatNotes: { where: { performanceId: null } } } })
        .then((data) => data.map((b) => new Beat(b)))
    );
  }

  async getBeatByName(name: string) {
    const data = await safeQuery((prisma) =>
      prisma.beat.findFirst({ where: { name: name }, include: { beatNotes: { where: { performanceId: null } } } })
    );
    return data ? new Beat(data) : null;
  }

  async createBeat(data: NewBeat, userId: string) {
    return safeQuery((prisma) =>
      prisma.$transaction(async (tx) => {
        await lockDestination(tx, data.moduleId, userId);
        return insertBeat(tx, data, userId);
      })
    );
  }

  async copyBeat(id: string, moduleId: string, userId: string) {
    return safeQuery((prisma) =>
      prisma.$transaction(async (tx) => {
        await lockDestination(tx, moduleId, userId);
        // Public content only. Never load performances or progress into the copy.
        const source = await tx.beat.findUnique({
          where: { id },
          include: { beatNotes: { where: { performanceId: null } } },
        });
        if (!source) throw new Response('Beat not found', { status: 404 });
        return insertBeat(
          tx,
          {
            name: copiedBeatName(source.name),
            description: source.description,
            index: source.index + 1,
            moduleId,
            beatNotes: source.beatNotes.map(musicalNote),
          },
          userId
        );
      })
    );
  }

  async updateBeat(id: string, data: NewBeat, userId: string) {
    return safeQuery((prisma) =>
      prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<BeatRow[]>`SELECT * FROM "Beat" WHERE id = ${id} FOR UPDATE`;
        const current = rows[0];
        if (!current) throw new Response('Beat not found', { status: 404 });
        if (current.authorId !== userId) throw new Response('Only the beat author can edit it', { status: 403 });
        if (data.moduleId !== current.moduleId) await lockDestination(tx, data.moduleId, userId);
        // Ordinary edits preserve authorship and all saved practice history.
        return tx.beat.update({
          where: { id },
          data: {
            name: data.name,
            description: data.description,
            index: data.index,
            moduleId: data.moduleId,
            beatNotes: {
              deleteMany: { performanceId: null },
              create: data.beatNotes.map(musicalNote),
            },
          },
          include: { beatNotes: { where: { performanceId: null } } },
        });
      })
    );
  }
}

async function lockDestination(tx: Prisma.TransactionClient, moduleId: string, userId: string) {
  const rows = await tx.$queryRaw<ModuleRow[]>`SELECT * FROM "Module" WHERE id = ${moduleId} FOR UPDATE`;
  if (rows[0]?.authorId !== userId) throw new Response('You must own the destination module', { status: 403 });
}

function insertBeat(tx: Prisma.TransactionClient, data: NewBeat, userId: string) {
  return tx.beat.create({
    data: {
      name: data.name,
      description: data.description,
      index: data.index,
      moduleId: data.moduleId,
      authorId: userId,
      beatNotes: { create: data.beatNotes.map(musicalNote) },
    },
    include: { beatNotes: { where: { performanceId: null } } },
  });
}

export const beatRepository = new BeatRepository();
