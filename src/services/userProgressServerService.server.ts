import { beatProgressRepository } from '~/repositories/beatProgressRepository';
import { beatRepository } from '~/repositories/beatRepository';
import { moduleProgressRepository } from '~/repositories/moduleProgressRepository';
import { userRepository } from '~/repositories/userRepository';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { getWebRequest } from '@tanstack/react-start/server';

export interface BeatProgressView {
  beatId: string;
  bestTempo: number;
}

const startBeatServerFnArgs = z.object({
  beatId: z.string(),
});
export const startBeatServerFn = createServerFn({
  method: 'POST',
  response: 'data',
})
  .validator((data: unknown) => {
    return startBeatServerFnArgs.parse(data);
  })
  .handler(async (ctx) => {
    try {
      const { beatId } = ctx.data;
      console.log('Received request to start beat', beatId);

      // For now, use a default user ID since we removed authentication
      const defaultUserId = 'default-user';

      const beat = await beatRepository.getBeatWithModuleAndMethod(beatId);
      if (!beat) {
        throw new Error(`Beat not found with id ${beatId}`);
      }
      if (!beat.module) {
        throw new Error(`Module not found for beat with id ${beatId}`);
      }
      if (!beat.module.method) {
        throw new Error(`Method not found for module with id ${beat.module.id}`);
      }
      const moduleId = beat.module.id;
      const methodId = beat.module.method.id;

      // Set the user's current module
      await moduleProgressRepository.setCurrentMethodForModule(defaultUserId, moduleId, methodId);

      // Set the user's current method for the module
      await userRepository.setCurrentModule(defaultUserId, moduleId);
      return { success: true };
    } catch (error) {
      console.error('Error starting beat:', error);
      return { error: 'Failed to start beat' };
    }
  });

const passBeatTempoServerFnArgs = z.object({
  beatId: z.string(),
  tempo: z.number(),
});

export const passBeatTempoServerFn = createServerFn({
  method: 'POST',
  response: 'data',
})
  .validator((data: unknown) => {
    return passBeatTempoServerFnArgs.parse(data);
  })
  .handler(async (ctx) => {
    try {
      const { beatId, tempo } = ctx.data;
      console.log('Received request to pass beat tempo', beatId, tempo);

      // For now, use a default user ID since we removed authentication
      const defaultUserId = 'default-user';

      return beatProgressRepository.setBeatBestTempo(defaultUserId, beatId, tempo);
    } catch (error) {
      console.error('Error passing beat tempo:', error);
      return { error: 'Failed to pass beat tempo' };
    }
  });

const getBeatProgressForModuleServerFnArgs = z.object({
  id: z.string(),
});

export const getBeatProgressForModuleServerFn = createServerFn({
  method: 'GET',
  response: 'data',
})
  .validator((data: unknown) => {
    return getBeatProgressForModuleServerFnArgs.parse(data);
  })
  .handler(async (ctx) => {
    try {
      // For now, use a default user ID since we removed authentication
      const defaultUserId = 'default-user';

      const { id } = ctx.data;
      const moduleProgress = await beatProgressRepository.getBeatProgressForModule(defaultUserId, id);
      const beatProgress: BeatProgressView[] = moduleProgress.map((beat) => {
        const progress = (beat as any).beatProgress?.[0];
        return {
          beatId: beat.id,
          bestTempo: progress ? progress.bestTempo : null,
        };
      });
      console.log('Beat progress for module:', beatProgress);
      return beatProgress;
    } catch (error) {
      console.error('Error getting beat progress for module:', error);
      return [];
    }
  });
