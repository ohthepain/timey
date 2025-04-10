import prisma from '../config/db';
import { Prisma } from '@prisma/client';

export const getBeatById = async (id: string) => {
  return prisma.beat.findUnique({ where: { id }, include: { beatNotes: true } });
};

export const getBeatsByUser = async (userId: string) => {
  return prisma.beat.findMany({ where: { authorId: userId }, include: { beatNotes: true } });
};

export const getBeatByName = async (name: string) => {
  // No unique constraint on name, so we use findFirst
  return prisma.beat.findFirst({ where: { name: name }, include: { beatNotes: true } });
};

export const createBeat = async (authorId: string) => {
  return prisma.beat.create({
    data: {
      authorId,
    },
  });
};

export const updateBeat = async (id: string, data: Prisma.BeatUpdateInput) => {
  return prisma.beat.update({ where: { id }, data });
};

export const deleteBeat = async (id: string) => {
  return prisma.beat.delete({ where: { id } });
};
