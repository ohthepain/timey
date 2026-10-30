import { deleteContent } from '~/repositories/contentDeletion';
import { deleteContentInput } from '~/types/contentDeletion';
import { createServerFn } from '@tanstack/react-start';
import { moduleRepository } from '~/repositories/moduleRepository';
import { z } from 'zod';
import { Module } from '~/types/Module';
import { requireDomainUser } from '~/server/domain-session';
import { createModuleInput, updateModuleInput } from '~/types/contentWrites';

export const getAllModulesServerFn = createServerFn({ method: 'GET' }).handler(async () => {
  const data = await moduleRepository.getAllModules();
  return data.map((module) => new Module(module).toJSON());
});

export const getModuleByIdServerFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(async (ctx) => {
    const data = await getModuleById(ctx.data.id);
    if (!data) return null;
    const module = new Module(data);
    return {
      ...module.toJSON(),
      method: data.method,
    };
  });

const getModuleById = async (id: string) => {
  const data = await moduleRepository.getModuleById(id);
  if (!data) return null;
  const module = new Module(data);
  return {
    ...module.toJSON(),
    method: data.method,
  };
};

export const createModuleServerFn = createServerFn({ method: 'POST' })
  .validator(createModuleInput)
  .handler(async (ctx) => {
    const { userId } = await requireDomainUser();
    const data = await moduleRepository.createModule(ctx.data, userId);
    return new Module(data).toJSON();
  });

export const updateModuleServerFn = createServerFn({ method: 'POST' })
  .validator(updateModuleInput)
  .handler(async (ctx) => {
    const { userId } = await requireDomainUser();
    const result = await moduleRepository.updateModule(ctx.data.id, ctx.data.data, userId);
    return new Module(result).toJSON();
  });

export const deleteModuleServerFn = createServerFn({ method: 'POST' })
  .validator(deleteContentInput)
  .handler(async (ctx) => {
    const { userId } = await requireDomainUser();
    return deleteContent('module', ctx.data.id, userId);
  });
