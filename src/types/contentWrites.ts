import { z } from 'zod';

const fields = {
  title: z.string().trim().min(1),
  description: z.string().optional(),
  index: z.number().int().optional(),
};
export const createMethodInput = z.strictObject(fields);
export const updateMethodInput = createMethodInput.partial().extend({ id: z.string().min(1) });
export const createModuleInput = z.strictObject({ ...fields, methodId: z.string().min(1) });
const moduleChanges = createModuleInput.partial();
export const updateModuleInput = z.strictObject({ id: z.string().min(1), data: moduleChanges });
export const updateModuleApiInput = moduleChanges.extend({ id: z.string().min(1) });
export type MethodChanges = z.infer<typeof createMethodInput>;
export type ModuleChanges = z.infer<typeof moduleChanges>;
