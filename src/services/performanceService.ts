import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { performanceRepository } from '~/repositories/performanceRepository';
import { requirePracticeUser } from '~/server/practice-session';

const beatNoteSchema = z.strictObject({
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

const savePerformanceArgs = z.strictObject({
  performance: z.strictObject({
    beatId: z.string(),
    index: z.number(),
    notes: z.array(beatNoteSchema),
  }),
});

export const savePerformanceServerFn = createServerFn({ method: 'POST' })
  .validator(savePerformanceArgs)
  .handler(async (ctx) => {
    const { userId } = await requirePracticeUser();
    const saved = await performanceRepository.replacePerformance(ctx.data.performance, userId);
    return saved.toJSON();
  });

const fetchUserPerformancesForBeatArgs = z.strictObject({
  beatId: z.string(),
});

export const fetchUserPerformancesForBeatServerFn = createServerFn({ method: 'GET' })
  .validator(fetchUserPerformancesForBeatArgs)
  .handler(async (ctx) => {
    const { userId } = await requirePracticeUser();
    const performances = await performanceRepository.fetchPerformancesByBeatIdAndUserId(ctx.data.beatId, userId);
    return performances.map((performance) => performance.toJSON());
  });

const deleteUserPerformancesForBeatArgs = z.strictObject({
  beatId: z.string(),
});

export const deletePerformancesByBeatIdAndUserId = createServerFn({ method: 'POST' })
  .validator((data: unknown) => deleteUserPerformancesForBeatArgs.parse(data))
  .handler(async (ctx) => {
    const { userId } = await requirePracticeUser();
    const { beatId } = ctx.data;
    const deleted = await performanceRepository.deletePerformancesByBeatIdAndUserId(beatId, userId);
    return deleted;
  });
