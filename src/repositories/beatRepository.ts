import prisma from '../config/db';

export const getBeatById = async (id: string) => {
  return prisma.beat.findUnique({ where: { id }, include: { beatNotes: true } });
};

export const getBeatWithModuleAndMethod = async (beatId: string) => {
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
};

export const getBeatsByUser = async (userId: string) => {
  return prisma.beat.findMany({ where: { authorId: userId }, include: { beatNotes: true } });
};

export const getBeatByName = async (name: string) => {
  // No unique constraint on name, so we use findFirst
  return prisma.beat.findFirst({ where: { name: name }, include: { beatNotes: true } });
};

export async function createBeat2({
  name,
  description,
  index,
  authorId,
  moduleId,
  beatNotes,
}: {
  name: string;
  description?: string;
  index: number;
  authorId: string;
  moduleId: string;
  beatNotes: Array<{
    index: number;
    duration: number;
    noteString: string;
    barNum: number;
    beatNum: number;
    divisionNum: number;
    subDivisionNum: number;
    numSubDivisions: number;
    velocity: number;
  }>;
}) {
  console.log(`createBeat called with name: ${name}`);
  console.log(`createBeat called with index: ${index}`);
  console.log(`createBeat called with authorId: ${authorId}`);
  console.log(`createBeat called with moduleId: ${moduleId}`);
  console.log(`createBeat called with beatNotes: ${JSON.stringify(beatNotes)}`);
  console.log(`createBeat called with beatNotes length: ${beatNotes.length}`);

  return prisma.beat.create({
    data: {
      name,
      description,
      index,
      authorId,
      moduleId,
      beatNotes: {
        create: beatNotes,
      },
    },
    include: { beatNotes: true },
  });
}

export const createBeat = async (data: any) => {
  console.log('createBeat with data:', data); // Debug log to confirm data passed to Prisma

  if (data.index === undefined || data.index === null) {
    throw new Error('Index is required and cannot be null or undefined');
  }

  return prisma.beat.create({
    data: {
      name: data.name,
      description: data.description,
      index: data.index, // Ensure index is explicitly passed
      authorId: data.authorId,
      moduleId: data.moduleId,
      beatNotes: {
        create: data.beatNotes,
      },
    },
    include: { beatNotes: true },
  });
};

export const updateBeat = async (id: string, data: any) => {
  console.log('updateBeat with index:', data.index);
  const existingBeat = await prisma.beat.findUnique({ where: { id } });
  if (!existingBeat) {
    throw new Error(`Beat with id ${id} does not exist`);
  }

  try {
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
  } catch (error) {
    console.error('Error updating beat:', error);
    if (error instanceof Error) {
      throw new Error(`Failed to update beat: ${error.message}`);
    }
    throw new Error('Failed to update beat: An unknown error occurred');
  }
};

export const deleteBeat = async (id: string) => {
  return prisma.beat.delete({ where: { id } });
};
