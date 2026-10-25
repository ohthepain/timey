import { deleteContent } from '~/repositories/contentDeletion';
import { deleteContentInput } from '~/types/contentDeletion';
import { createServerFn } from '@tanstack/react-start';
import { beatRepository } from '~/repositories/beatRepository';
import { z } from 'zod';
import { requirePracticeUser } from '~/server/practice-session';
import { Beat } from '~/types/Beat';
import { requireDomainUser } from '~/server/domain-session';
import { createBeatInput, copyBeatInput, editBeatInput } from '~/types/beatWrites';

export const deleteBeatServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator(deleteContentInput)
  .handler(async (ctx) => {
    const { userId } = await requireDomainUser();
    return deleteContent('beat', ctx.data.id, userId);
  });

export const saveBeatServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator(editBeatInput)
  .handler(async (ctx) => {
    const { userId } = await requireDomainUser();
    return beatRepository.updateBeat(ctx.data.id, ctx.data, userId);
  });

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
