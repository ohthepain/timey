import { createServerFn } from '@tanstack/react-start';
import { moduleRepository } from '~/repositories/moduleRepository';
import { z } from 'zod';
import { getAuth } from '@clerk/tanstack-react-start/server';
import { getWebRequest } from '@tanstack/react-start/server';
import { Module } from '~/types/Module';

export const getAllModulesServerFn = createServerFn({ method: 'GET', response: 'data' }).handler(async () => {
  const data = await moduleRepository.getAllModules();
  return data.map((module) => new Module(module).toJSON());
});

export const getModuleByIdServerFn = createServerFn({ method: 'GET', response: 'data' })
  .validator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(async (ctx) => {
    const data = await moduleRepository.getModuleById(ctx.data.id);
    return new Module(data).toJSON();
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
    const data = await moduleRepository.createModule({
      ...ctx.data,
      description: ctx.data.description || undefined,
      authorId: userId,
    });
    return new Module(data).toJSON();
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
