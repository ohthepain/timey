import { createServerFn } from '@tanstack/react-start';
import { methodRepository } from '~/repositories/methodRepository';
import { z } from 'zod';
import { Method } from '~/types/Method';
import { withAuth } from '~/utils/authenticatedServerFn';

export const getAllMethodsServerFn = createServerFn({ method: 'GET', response: 'data' }).handler(async () => {
  const methods = await methodRepository.getAllMethods();
  return methods.map((method) => new Method(method).toJSON());
});

const createMethodServerFnArgs = z.object({
  title: z.string(),
  description: z.string().optional(),
  index: z.number().optional(),
  token: z.string().optional(),
});

export const createMethodServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator(createMethodServerFnArgs)
  .handler(
    withAuth(async (ctx, userId) => {
      const method = await methodRepository.createMethod({
        title: ctx.data.title,
        index: ctx.data.index || 0,
        description: ctx.data.description || '',
        authorId: userId,
      });

      return new Method(method).toJSON();
    })
  );

const getMethodByIdServerFnArgs = z.object({
  id: z.string(),
});

export const getMethodByIdServerFn = createServerFn({ method: 'GET', response: 'data' })
  .validator((data: unknown) => getMethodByIdServerFnArgs.parse(data))
  .handler(async (ctx) => {
    const method = await methodRepository.getMethodById(ctx.data.id);
    if (!method) {
      return null;
    }
    return new Method(method).toJSON();
  });

const updateMethodServerFnArgs = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  index: z.number().optional(),
  token: z.string().optional(),
});

export const updateMethodServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator(updateMethodServerFnArgs)
  .handler(
    withAuth(async (ctx, userId) => {
      const method = await methodRepository.updateMethod(ctx.data.id, {
        title: ctx.data.title,
        description: ctx.data.description,
        index: ctx.data.index,
        authorId: userId,
      });

      return new Method(method).toJSON();
    })
  );

const deleteMethodServerFnArgs = z.object({
  id: z.string(),
  token: z.string().optional(),
});

export const deleteMethodServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator((data: unknown) => deleteMethodServerFnArgs.parse(data))
  .handler(async (ctx) => {
    const method = await methodRepository.deleteMethod(ctx.data.id);
    return new Method(method).toJSON();
  });
