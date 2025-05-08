import { createServerFn } from '@tanstack/react-start';
import { beatRepository } from '~/repositories/beatRepository';
import { z } from 'zod';
import { getWebRequest } from '@tanstack/react-start/server';
import { getAuth } from '@clerk/tanstack-react-start/server';
import { Beat } from '~/types/Beat';

export const deleteBeatServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(async (ctx) => {
    const beat: Beat | null = await beatRepository.deleteBeat(ctx.data.id);
    if (beat) {
      return { success: true };
    } else {
      return { success: false };
    }
  });

const saveBeatServerFnArgs = z.object({
  id: z.string().optional(),
  index: z.number().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  moduleId: z.string(),
  beatNotes: z.array(z.any()),
});

export const saveBeatServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator((data: unknown) => {
    return saveBeatServerFnArgs.parse(data);
  })
  .handler(async (ctx) => {
    const request = getWebRequest();
    const { userId } = await getAuth(request!);
    if (!userId) {
      throw new Error('User not authenticated');
    }
    if (ctx.data.id) {
      console.log('Updating beat with ID:', ctx.data.id);
      return beatRepository.updateBeat(ctx.data.id, {
        ...ctx.data,
        index: ctx.data.index || 0,
        description: ctx.data.description || null,
        authorId: userId,
      });
    } else {
      console.log('Creating new beat with beat notes:', ctx.data.beatNotes);
      return beatRepository.createBeat({
        ...ctx.data,
        index: ctx.data.index || 0,
        description: ctx.data.description || null,
        authorId: userId,
      });
    }
  });

const copyBeatServerFnArgs = z.object({
  id: z.string(),
});

export const copyBeatServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator((data: unknown) => copyBeatServerFnArgs.parse(data))
  .handler(async (ctx) => {
    const request = getWebRequest();
    const { userId } = await getAuth(request!);
    if (!userId) {
      throw new Error('User not authenticated');
    }

    // Fetch the original beat
    const original = await beatRepository.getBeatById(ctx.data.id);
    if (!original) throw new Error('Beat not found');

    // Prepare new beat data
    const newBeatData = {
      name: original.name + ' (Copy)',
      index: original.index + 1,
      authorId: userId,
      moduleId: original.moduleId,
      beatNotes: original.beatNotes.map(({ id, ...note }) => ({
        ...note,
      })),
    };

    // Create the new beat
    const newBeat = await beatRepository.createBeat(newBeatData);
    return newBeat;
  });

const getBeatByNameServerFnArgs = z.object({
  name: z.string(),
});

export const getBeatByNameServerFn = createServerFn({ method: 'GET', response: 'data' })
  .validator((data: unknown) => getBeatByNameServerFnArgs.parse(data))
  .handler(async (ctx): Promise<any> => {
    const data = await beatRepository.getBeatByName(ctx.data.name);
    if (!data) {
      return null;
    }
    return new Beat(data).toJSON();
  });
