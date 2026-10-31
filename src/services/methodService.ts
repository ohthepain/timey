import { deleteContent } from '~/repositories/contentDeletion';
import { deleteContentInput } from '~/types/contentDeletion';
import { createServerFn } from '@tanstack/react-start';
import { methodRepository } from '~/repositories/methodRepository';
import { z } from 'zod';
import { Method } from '~/types/Method';
import { requireDomainUser } from '~/server/domain-session';
import { createMethodInput, updateMethodInput } from '~/types/contentWrites';

export const getAllMethodsServerFn = createServerFn({ method: 'GET' }).handler(async () => {
  const methods = await methodRepository.getAllMethods();
  return methods.map((method) => new Method(method).toJSON());
});

export const createMethodServerFn = createServerFn({ method: 'POST' })
  .validator(createMethodInput)
  .handler(async (ctx) => {
    const { userId } = await requireDomainUser();
    const method = await methodRepository.createMethod(ctx.data, userId);
    return new Method(method).toJSON();
  });

const getMethodByIdServerFnArgs = z.object({
  id: z.string(),
});

export const getMethodByIdServerFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => getMethodByIdServerFnArgs.parse(data))
  .handler(async (ctx) => {
    const method = await methodRepository.getMethodById(ctx.data.id);
    if (!method) {
      return null;
    }
    return new Method(method).toJSON();
  });

export const updateMethodServerFn = createServerFn({ method: 'POST' })
  .validator(updateMethodInput)
  .handler(async (ctx) => {
    const { userId } = await requireDomainUser();
    const method = await methodRepository.updateMethod(ctx.data.id, ctx.data, userId);
    return new Method(method).toJSON();
  });

export const deleteMethodServerFn = createServerFn({ method: 'POST' })
  .validator(deleteContentInput)
  .handler(async (ctx) => {
    const { userId } = await requireDomainUser();
    return deleteContent('method', ctx.data.id, userId);
  });
