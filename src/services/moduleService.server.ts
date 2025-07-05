import { createServerFn } from '@tanstack/react-start';
import { moduleRepository } from '~/repositories/moduleRepository';
import { z } from 'zod';
import { getWebRequest } from '@tanstack/react-start/server';
import { Module } from '~/types/Module';
import { withAuth } from '~/utils/authenticatedServerFn';

export const getAllModulesServerFn = createServerFn({ method: 'GET', response: 'data' }).handler(async () => {
  const data = await moduleRepository.getAllModules();
  return data.map((module) => new Module(module).toJSON());
});

export const getModuleByIdServerFn = createServerFn({ method: 'GET', response: 'data' })
  .validator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(async (ctx) => {
    const data = await moduleRepository.getModuleById(ctx.data.id);
    if (!data) return null;
    const module = new Module(data);
    return {
      ...module.toJSON(),
      method: data.method,
    };
  });

const createModuleServerFnArgs = z.object({
  title: z.string(),
  description: z.string().optional(),
  index: z.number(),
  methodId: z.string(),
  token: z.string().optional(),
});

export const createModuleServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator(createModuleServerFnArgs)
  .handler(
    withAuth(async (ctx, userId) => {
      const data = await moduleRepository.createModule({
        title: ctx.data.title,
        description: ctx.data.description || '',
        index: ctx.data.index,
        methodId: ctx.data.methodId,
        authorId: userId,
      });
      return new Module(data).toJSON();
    })
  );

const updateModuleServerFnArgs = z.object({
  id: z.string(),
  data: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    index: z.number().optional(),
    authorId: z.string().optional(),
    methodId: z.string().optional(),
  }),
  token: z.string().optional(),
});

export const updateModuleServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator((data: unknown) => updateModuleServerFnArgs.parse(data))
  .handler(async (ctx) => {
    const result = await moduleRepository.updateModule(ctx.data.data);
    return new Module(result).toJSON();
  });

export const deleteModuleServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator((data: unknown) => z.object({ id: z.string(), token: z.string().optional() }).parse(data))
  .handler(async (ctx) => {
    const result = await moduleRepository.deleteModule(ctx.data.id);
    return new Module(result).toJSON();
  });
