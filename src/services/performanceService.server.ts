import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { performanceRepository } from '~/repositories/performanceRepository';
import { BeatNote } from '~/types/BeatNote';
import { Performance } from '~/types/Performance';
import { ensureKeycloakUser } from '~/lib/ensureKeycloakUser';
import { withAuth } from '~/utils/authenticatedServerFn';

const beatNoteSchema = z.object({
  id: z.string(),
  index: z.number(),
  noteString: z.string(),
  barNum: z.number(),
  beatNum: z.number(),
  divisionNum: z.number(),
  subDivisionNum: z.number(),
  numSubDivisions: z.number(),
  velocity: z.number(),
  microtiming: z.number(),
  duration: z.number(),
});

const savePerformanceArgs = z.object({
  performance: z.object({
    beatId: z.string(),
    index: z.number(),
    notes: z.array(
      z.object({
        id: z.string(),
        index: z.number(),
        noteString: z.string(),
        barNum: z.number(),
        beatNum: z.number(),
        divisionNum: z.number(),
        subDivisionNum: z.number(),
        numSubDivisions: z.number(),
        velocity: z.number(),
        microtiming: z.number(),
        duration: z.number(),
      })
    ),
  }),
});

export const savePerformanceServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator(savePerformanceArgs)
  .handler(
    withAuth(async (ctx, userId) => {
      const { performance } = ctx.data;

      // Delete existing performances for this beat and user
      await performanceRepository.deletePerformancesByBeatIdAndUserId(performance.beatId, userId);

      // Create new performance
      const saved = await performanceRepository.createPerformance(performance, userId);
      return saved;
    })
  );

const fetchUserPerformancesForBeatArgs = z.object({
  beatId: z.string(),
  token: z.string(),
});

export const fetchUserPerformancesForBeatServerFn = createServerFn({ method: 'GET', response: 'data' })
  .validator(fetchUserPerformancesForBeatArgs)
  .handler(
    withAuth(async (ctx, userId) => {
      const { beatId } = ctx.data;
      const prismaPerformances = await performanceRepository.fetchPerformancesByBeatIdAndUserId(beatId, userId);
      return prismaPerformances.map((perf) => perf.toJSON());
    })
  );

const deleteUserPerformancesForBeatArgs = z.object({
  beatId: z.string(),
});

export const deletePerformancesByBeatIdAndUserId = createServerFn({ method: 'POST', response: 'data' })
  .validator((data: unknown) => deleteUserPerformancesForBeatArgs.parse(data))
  .handler(async (ctx) => {
    // Get the authenticated user ID
    const userId = await ensureKeycloakUser();
    if (!userId) {
      throw new Error('Authentication required');
    }

    const { beatId } = ctx.data;
    const deleted = await performanceRepository.deletePerformancesByBeatIdAndUserId(beatId, userId);
    return deleted;
  });
