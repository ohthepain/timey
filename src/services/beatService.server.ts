import { createServerFn } from '@tanstack/react-start';
import { beatRepository } from '~/repositories/beatRepository';
import { z } from 'zod';
import { requirePracticeUser } from '~/server/practice-session';
import { Beat } from '~/types/Beat';
import { requireDomainUser } from '~/server/domain-session';
import { createBeatInput, copyBeatInput } from '~/types/beatWrites';
import { withAuth } from '~/utils/authenticatedServerFn';

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
  id: z.string().min(1),
  index: z.number().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  moduleId: z.string(),
  beatNotes: z.array(z.any()),
  token: z.string(),
});

export const saveBeatServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator(saveBeatServerFnArgs)
  .handler(
    withAuth(async (ctx, userId) => {
      const data = {
        ...ctx.data,
        index: ctx.data.index || 0,
        description: ctx.data.description || null,
        authorId: userId,
      };
      return beatRepository.updateBeat(ctx.data.id, data);
    })
  );

export const createBeatServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator(createBeatInput)
  .handler(async (ctx) => {
    const { userId } = await requireDomainUser();
    return beatRepository.createBeat(ctx.data, userId);
  });

export const copyBeatServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator(copyBeatInput)
  .handler(async (ctx) => {
    const { userId } = await requireDomainUser();
    return beatRepository.copyBeat(ctx.data.id, ctx.data.moduleId, userId);
  });

const getBeatWithPerformancesServerFnArgs = z.strictObject({
  beatId: z.string(),
});

export const getBeatWithPerformancesServerFn = createServerFn({ method: 'GET', response: 'data' })
  .validator(getBeatWithPerformancesServerFnArgs)
  .handler(async (ctx) => {
    const { userId } = await requirePracticeUser();
    return beatRepository.getBeatWithPerformances(ctx.data.beatId, userId);
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
