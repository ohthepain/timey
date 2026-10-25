import { createServerFn } from '@tanstack/react-start';
import { methodRepository } from '~/repositories/methodRepository';
import { z } from 'zod';
import { Method } from '~/types/Method';
import { requireDomainUser } from '~/server/domain-session';
import { createMethodInput, updateMethodInput } from '~/types/contentWrites';

export const getAllMethodsServerFn = createServerFn({ method: 'GET', response: 'data' }).handler(async () => {
  const methods = await methodRepository.getAllMethods();
  return methods.map((method) => new Method(method).toJSON());
});

export const createMethodServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator(createMethodInput)
  .handler(async (ctx) => {
    const { userId } = await requireDomainUser();
    const method = await methodRepository.createMethod(ctx.data, userId);
    return new Method(method).toJSON();
  });

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

export const updateMethodServerFn = createServerFn({ method: 'POST', response: 'data' })
  .validator(updateMethodInput)
  .handler(async (ctx) => {
    const { userId } = await requireDomainUser();
    const method = await methodRepository.updateMethod(ctx.data.id, ctx.data, userId);
    return new Method(method).toJSON();
  });

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
