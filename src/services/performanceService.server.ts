import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { performanceRepository } from '~/repositories/performanceRepository';
import { getWebRequest } from '@tanstack/react-start/server';
import { getAuth } from '@clerk/tanstack-react-start/server';
import { BeatNote } from '~/types/BeatNote';
import { Performance } from '~/types/Performance';

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
    userId: z.string(),
    notes: z.array(beatNoteSchema),
  }),
});

export const savePerformanceServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator((data: unknown) => savePerformanceArgs.parse(data))
  .handler(async (ctx) => {
    const request = getWebRequest();
    const { userId } = await getAuth(request!);
    if (!userId) {
      throw new Error('User not authenticated');
    }
    const { performance } = ctx.data;
    const savePerformanceArgs = {
      ...performance,
      userId,
      notes: performance.notes.map(
        (note) =>
          new BeatNote({
            id: note.id,
            index: note.index,
            noteString: note.noteString,
            barNum: note.barNum,
            beatNum: note.beatNum,
            divisionNum: note.divisionNum,
            subDivisionNum: note.subDivisionNum,
            numSubDivisions: note.numSubDivisions,
            velocity: note.velocity,
            microtiming: note.microtiming,
            duration: note.duration,
          })
      ),
      toJSON() {
        return {
          beatId: this.beatId,
          index: this.index,
          notes: this.notes,
        };
      },
    };
    await performanceRepository.deletePerformancesByBeatIdAndUserId(performance.beatId, performance.userId);
    const saved = await performanceRepository.createPerformance(performance.toJSON()  , userId);
    return saved;
  });

const fetchUserPerformancesForBeatArgs = z.object({
  beatId: z.string(),
});

export const fetchUserPerformancesForBeat = createServerFn({ method: 'GET', response: 'data' })
  .validator((data: unknown) => fetchUserPerformancesForBeatArgs.parse(data))
  .handler(async (ctx) => {
    const request = getWebRequest();
    const { userId } = await getAuth(request!);
    if (!userId) {
      throw new Error('User not authenticated');
    }
    const { beatId } = ctx.data;
    const prismaPerformances = await performanceRepository.fetchPerformancesByBeatIdAndUserId(beatId, userId);
    return prismaPerformances.map((perf) => perf.toJSON());
  });

const deleteUserPerformancesForBeatArgs = z.object({
  beatId: z.string(),
});

export const deletePerformancesByBeatIdAndUserId = createServerFn({ method: 'POST', response: 'data' })
  .validator((data: unknown) => deleteUserPerformancesForBeatArgs.parse(data))
  .handler(async (ctx) => {
    const request = getWebRequest();
    const { userId } = await getAuth(request!);
    if (!userId) {
      throw new Error('User not authenticated');
    }
    const { beatId } = ctx.data;
    const deleted = await performanceRepository.deletePerformancesByBeatIdAndUserId(beatId, userId);
    return deleted;
  });
