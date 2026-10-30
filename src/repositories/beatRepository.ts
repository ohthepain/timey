import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  beatNotes,
  beats,
  methods,
  modules,
  performances,
  type DomainBeat,
  type DomainModule,
} from '../../domain/schema';
import { newId } from '~/db/ids';
import { contentNotes, loadContentBeat } from '~/db/beats';
import { pgRows } from '~/db/pg-rows';
import { type NewBeat, musicalNote, copiedBeatName } from '~/types/beatWrites';
import { safeQuery, type DomainDb } from '~/config/db';
import { Beat } from '~/types/Beat';
import { Performance } from '~/types/Performance';
import { Method } from '~/types/Method';
import { Module } from '~/types/Module';

class BeatRepository {
  async getBeatById(id: string) {
    const data = await safeQuery((db) => loadContentBeat(db, id));
    return data ? new Beat(data) : null;
  }

  async getBeatWithModuleAndMethod(beatId: string) {
    const data = await safeQuery((db) => loadContentBeat(db, beatId));
    if (!data) return null;
    const [moduleRow] = await safeQuery((db) =>
      db.select().from(modules).where(eq(modules.id, data.moduleId)).limit(1)
    );
    const [methodRow] = moduleRow
      ? await safeQuery((db) => db.select().from(methods).where(eq(methods.id, moduleRow.methodId)).limit(1))
      : [];
    const method = methodRow ? new Method(methodRow) : undefined;
    const module = moduleRow ? new Module({ ...moduleRow, method }) : undefined;
    return new Beat({ ...data, module });
  }

  async getBeatWithPerformances(beatId: string, userId: string) {
    console.log('Fetching beat with performances for user:', userId);
    console.log('Fetching beat with performances for beatId:', beatId);
    const data = await safeQuery((db) => loadContentBeat(db, beatId));
    if (!data) return null;
    const performanceRows = await safeQuery(async (db) => {
      const latest = await db
        .select()
        .from(performances)
        .where(and(eq(performances.beatId, beatId), eq(performances.userId, userId)))
        .orderBy(desc(performances.createdAt))
        .limit(1);
      if (!latest.length) return [];
      const notes = await db.select().from(beatNotes).where(eq(beatNotes.performanceId, latest[0].id));
      return [{ ...latest[0], notes }];
    });
    return {
      ...new Beat(data).toJSON(),
      performances: performanceRows.map((performance) => new Performance(performance).toJSON()),
    };
  }

  async getBeatsByUser(userId: string) {
    const data = await safeQuery(async (db) => {
      const rows = await db.select().from(beats).where(eq(beats.authorId, userId));
      return Promise.all(
        rows.map(async (beat) => {
          const notes = await db.select().from(beatNotes).where(eq(beatNotes.beatId, beat.id));
          return { ...beat, beatNotes: contentNotes(notes) };
        })
      );
    });
    return data.map((b) => new Beat(b));
  }

  async getBeatByName(name: string) {
    const [row] = await safeQuery((db) => db.select().from(beats).where(eq(beats.name, name)).limit(1));
    if (!row) return null;
    const data = await safeQuery((db) => loadContentBeat(db, row.id));
    return data ? new Beat(data) : null;
  }

  async createBeat(data: NewBeat, userId: string) {
    return safeQuery((db) =>
      db.transaction(async (tx) => {
        await lockDestination(tx, data.moduleId, userId);
        return insertBeat(tx, data, userId);
      })
    );
  }

  async copyBeat(id: string, moduleId: string, userId: string) {
    return safeQuery((db) =>
      db.transaction(async (tx) => {
        await lockDestination(tx, moduleId, userId);
        const source = await loadContentBeat(tx, id);
        if (!source) throw new Response('Beat not found', { status: 404 });
        return insertBeat(
          tx,
          {
            name: copiedBeatName(source.name),
            description: source.description,
            index: source.index + 1,
            moduleId,
            beatNotes: source.beatNotes.map(musicalNote),
          },
          userId
        );
      })
    );
  }

  async updateBeat(id: string, data: NewBeat, userId: string) {
    return safeQuery((db) =>
      db.transaction(async (tx) => {
        const current = pgRows<DomainBeat>(
          await tx.execute(sql`SELECT * FROM domain."Beat" WHERE id = ${id} FOR UPDATE`)
        )[0];
        if (!current) throw new Response('Beat not found', { status: 404 });
        if (current.authorId !== userId) throw new Response('Only the beat author can edit it', { status: 403 });
        if (data.moduleId !== current.moduleId) await lockDestination(tx, data.moduleId, userId);
        await tx.delete(beatNotes).where(and(eq(beatNotes.beatId, id), isNull(beatNotes.performanceId)));
        if (data.beatNotes.length) {
          await tx.insert(beatNotes).values(
            data.beatNotes.map((note) => ({
              id: newId(),
              ...musicalNote(note),
              beatId: id,
            }))
          );
        }
        await tx
          .update(beats)
          .set({
            name: data.name,
            description: data.description,
            index: data.index,
            moduleId: data.moduleId,
          })
          .where(eq(beats.id, id));
        return loadContentBeat(tx, id);
      })
    );
  }
}

async function lockDestination(tx: DomainDb, moduleId: string, userId: string) {
  const row = pgRows<DomainModule>(
    await tx.execute(sql`SELECT * FROM domain."Module" WHERE id = ${moduleId} FOR UPDATE`)
  )[0];
  if (row?.authorId !== userId) throw new Response('You must own the destination module', { status: 403 });
}

async function insertBeat(tx: DomainDb, data: NewBeat, userId: string) {
  const beatId = newId();
  await tx.insert(beats).values({
    id: beatId,
    name: data.name,
    description: data.description,
    index: data.index,
    moduleId: data.moduleId,
    authorId: userId,
  });
  if (data.beatNotes.length) {
    await tx.insert(beatNotes).values(
      data.beatNotes.map((note) => ({
        id: newId(),
        ...musicalNote(note),
        beatId,
      }))
    );
  }
  return loadContentBeat(tx, beatId);
}

export const beatRepository = new BeatRepository();
