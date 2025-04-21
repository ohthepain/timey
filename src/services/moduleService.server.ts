import { createServerFn } from '@tanstack/react-start';
import { moduleRepository } from '~/repositories/moduleRepository';
import { z } from 'zod';
import { getAuth } from '@clerk/tanstack-react-start/server';
import { getWebRequest } from '@tanstack/react-start/server';

export const getAllModulesServerFn = createServerFn({ method: 'GET', response: 'data' }).handler(async () => {
  return moduleRepository.getAllModules();
});

export const getModuleByIdServerFn = createServerFn({ method: 'GET', response: 'data' })
  .validator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(async (ctx) => {
    return moduleRepository.getModuleById(ctx.data.id);
  });

const createModuleServerFnArgs = z.object({
  title: z.string(),
  description: z.string().optional(),
  index: z.number(),
  methodId: z.string(),
});

export const createModuleServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator((data: unknown) => {
    return createModuleServerFnArgs.parse(data);
  })
  .handler(async (ctx) => {
    const request = getWebRequest();
    const { userId } = await getAuth(request!);
    if (!userId) {
      throw new Error('User not authenticated');
    }
    return moduleRepository.createModule({
      ...ctx.data,
      description: ctx.data.description || null,
      authorId: userId,
    });
  });

export const updateModuleServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator((data: unknown) =>
    z
      .object({
        id: z.string(),
        data: z.object({
          title: z.string().optional(),
          description: z.string().optional(),
          index: z.number().optional(),
          authorId: z.string().optional(),
          methodId: z.string().optional(),
        }),
      })
      .parse(data)
  )
  .handler(async (ctx) => {
    return moduleRepository.updateModule(ctx.data.data);
  });

export const deleteModuleServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(async (ctx) => {
    return moduleRepository.deleteModule(ctx.data.id);
  });
