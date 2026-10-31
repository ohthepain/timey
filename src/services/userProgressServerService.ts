import { beatProgressRepository } from '~/repositories/beatProgressRepository';
import { beatRepository } from '~/repositories/beatRepository';
import { moduleProgressRepository } from '~/repositories/moduleProgressRepository';
import { userRepository } from '~/repositories/userRepository';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { requirePracticeUser } from '~/server/practice-session';

export interface BeatProgressView {
  beatId: string;
  bestTempo: number | null;
}

const beatArgs = z.strictObject({ beatId: z.string() });

export const startBeatServerFn = createServerFn({ method: 'POST' })
  .validator(beatArgs)
  .handler(async (ctx) => {
    const { userId } = await requirePracticeUser();
    const beat = await beatRepository.getBeatWithModuleAndMethod(ctx.data.beatId);
    if (!beat?.module?.method) throw new Error('Beat hierarchy not found');
    await moduleProgressRepository.setCurrentMethodForModule(userId, beat.module.id, beat.module.method.id);
    await userRepository.setCurrentModule(userId, beat.module.id);
    return { success: true };
  });

const passBeatTempoArgs = z.strictObject({ beatId: z.string(), tempo: z.number().int().positive() });

export const passBeatTempoServerFn = createServerFn({ method: 'POST' })
  .validator(passBeatTempoArgs)
  .handler(async (ctx) => {
    const { userId } = await requirePracticeUser();
    return beatProgressRepository.setBeatBestTempo(userId, ctx.data.beatId, ctx.data.tempo);
  });

const moduleArgs = z.strictObject({ id: z.string() });

export const getBeatProgressForModuleServerFn = createServerFn({ method: 'GET' })
  .validator(moduleArgs)
  .handler(async (ctx): Promise<BeatProgressView[]> => {
    const { userId } = await requirePracticeUser();
    const beats = await beatProgressRepository.getBeatProgressForModule(userId, ctx.data.id);
    return beats.map((beat) => ({ beatId: beat.id, bestTempo: beat.beatProgress[0]?.bestTempo ?? null }));
  });
