import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  beatNotes,
  beatProgress,
  beats,
  methodProgress,
  methods,
  moduleProgress,
  modules,
  performances,
  users,
} from '../../domain/schema';
import { safeQuery } from '~/config/db';

type ContentKind = 'method' | 'module' | 'beat';

export function deleteContent(kind: ContentKind, id: string, userId: string) {
  return safeQuery((db) =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`LOCK TABLE domain."Method", domain."Module", domain."Beat", domain."BeatNote", domain."Performance", domain."BeatProgress", domain."ModuleProgress", domain."MethodProgress", domain."User" IN SHARE ROW EXCLUSIVE MODE`
      );
      const [selected] =
        kind === 'method'
          ? await tx.select().from(methods).where(eq(methods.id, id)).limit(1)
          : kind === 'module'
            ? await tx.select().from(modules).where(eq(modules.id, id)).limit(1)
            : await tx.select().from(beats).where(eq(beats.id, id)).limit(1);
      if (!selected) throw new Response('Content not found', { status: 404 });
      if (selected.authorId !== userId) throw new Response('Only the author can delete this content', { status: 403 });

      const methodIds = kind === 'method' ? [id] : [];
      const moduleIds =
        kind === 'module'
          ? [id]
          : kind === 'method'
            ? (await tx.select({ id: modules.id }).from(modules).where(eq(modules.methodId, id))).map((row) => row.id)
            : [];
      const beatIds =
        kind === 'beat'
          ? [id]
          : moduleIds.length
            ? (await tx.select({ id: beats.id }).from(beats).where(inArray(beats.moduleId, moduleIds))).map(
                (row) => row.id
              )
            : [];

      if (beatIds.length) {
        const performanceIds = (
          await tx.select({ id: performances.id }).from(performances).where(inArray(performances.beatId, beatIds))
        ).map((row) => row.id);
        if (performanceIds.length) {
          await tx.delete(beatNotes).where(inArray(beatNotes.performanceId, performanceIds));
        }
        await tx
          .update(beatNotes)
          .set({ beatId: null })
          .where(and(inArray(beatNotes.beatId, beatIds), isNotNull(beatNotes.performanceId)));
        await tx.delete(performances).where(inArray(performances.beatId, beatIds));
        await tx.delete(beatProgress).where(inArray(beatProgress.beatId, beatIds));
      }
      if (moduleIds.length) {
        await tx.update(users).set({ currentModuleId: null }).where(inArray(users.currentModuleId, moduleIds));
        await tx.delete(moduleProgress).where(inArray(moduleProgress.moduleId, moduleIds));
      }
      if (methodIds.length) {
        await tx
          .update(moduleProgress)
          .set({ currentMethodId: null })
          .where(inArray(moduleProgress.currentMethodId, methodIds));
        await tx.delete(methodProgress).where(inArray(methodProgress.methodId, methodIds));
      }
      if (beatIds.length) await tx.delete(beats).where(inArray(beats.id, beatIds));
      if (moduleIds.length) await tx.delete(modules).where(inArray(modules.id, moduleIds));
      if (methodIds.length) await tx.delete(methods).where(inArray(methods.id, methodIds));
      return { success: true };
    })
  );
}
