import { z } from 'zod';

export const deleteContentInput = z.strictObject({ id: z.string().min(1) });
