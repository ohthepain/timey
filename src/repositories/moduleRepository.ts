import { eq, sql } from 'drizzle-orm';
import { beatNotes, beats, methods, modules, type DomainMethod, type DomainModule } from '../../domain/schema';
import { newId } from '~/db/ids';
import { contentNotes } from '~/db/beats';
import { pgRows } from '~/db/pg-rows';
import { safeQuery } from '~/config/db';
import type { ModuleChanges } from '~/types/contentWrites';
import { Module } from '~/types/Module';

export const moduleRepository = {
  async getAllModules(): Promise<Module[]> {
    const data = await safeQuery((db) => db.select().from(modules));
    return data.map((m) => new Module(m));
  },

  async getModulesForMethod(methodId: string): Promise<Module[]> {
    const data = await safeQuery((db) => db.select().from(modules).where(eq(modules.methodId, methodId)));
    return data.map((m) => new Module(m));
  },

  async getModuleById(id: string): Promise<Module | null> {
    const [row] = await safeQuery((db) => db.select().from(modules).where(eq(modules.id, id)).limit(1));
    if (!row) return null;
    const [method] = await safeQuery((db) => db.select().from(methods).where(eq(methods.id, row.methodId)).limit(1));
    const moduleBeats = await safeQuery((db) => db.select().from(beats).where(eq(beats.moduleId, id)));
    const beatsWithNotes = await Promise.all(
      moduleBeats.map(async (beat) => {
        const notes = await safeQuery((db) => db.select().from(beatNotes).where(eq(beatNotes.beatId, beat.id)));
        return { ...beat, beatNotes: contentNotes(notes) };
      })
    );
    return new Module({ ...row, method, beats: beatsWithNotes });
  },

  async createModule(data: ModuleChanges & { title: string; methodId: string }, userId: string): Promise<Module> {
    const row = await safeQuery((db) =>
      db.transaction(async (tx) => {
        const parent = pgRows<DomainMethod>(
          await tx.execute(sql`SELECT * FROM domain."Method" WHERE id = ${data.methodId} FOR UPDATE`)
        )[0];
        if (parent?.authorId !== userId) throw new Response('You must own the destination method', { status: 403 });
        const [created] = await tx
          .insert(modules)
          .values({
            id: newId(),
            title: data.title,
            description: data.description ?? '',
            index: data.index ?? 0,
            methodId: data.methodId,
            authorId: userId,
          })
          .returning();
        return created;
      })
    );
    return new Module(row);
  },

  async updateModule(id: string, data: ModuleChanges, userId: string): Promise<Module> {
    const row = await safeQuery((db) =>
      db.transaction(async (tx) => {
        const current = pgRows<DomainModule>(
          await tx.execute(sql`SELECT * FROM domain."Module" WHERE id = ${id} FOR UPDATE`)
        )[0];
        if (current?.authorId !== userId) throw new Response('Only the module author can edit it', { status: 403 });
        if (data.methodId !== undefined) {
          const parent = pgRows<DomainMethod>(
            await tx.execute(sql`SELECT * FROM domain."Method" WHERE id = ${data.methodId} FOR UPDATE`)
          )[0];
          if (parent?.authorId !== userId) throw new Response('You must own the destination method', { status: 403 });
        }
        const [updated] = await tx
          .update(modules)
          .set({
            title: data.title,
            description: data.description,
            index: data.index,
            methodId: data.methodId,
          })
          .where(eq(modules.id, id))
          .returning();
        return updated;
      })
    );
    return new Module(row);
  },
};
