import { safeQuery } from '~/config/db';

type ContentKind = 'method' | 'module' | 'beat';

// Deliberately coarse locks: ordinary writers (including legacy direct SQL) need
// ROW EXCLUSIVE on these tables. Acquire before reading the descendant set, so
// inserts, moves, ownership changes and new history cannot race cleanup.
export function deleteContent(kind: ContentKind, id: string, userId: string) {
  return safeQuery((prisma) =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE "Method", "Module", "Beat", "BeatNote", "Performance", "BeatProgress", "ModuleProgress", "MethodProgress", "User" IN SHARE ROW EXCLUSIVE MODE`;
        const selected = await (kind === 'method'
          ? tx.method.findUnique({ where: { id } })
          : kind === 'module'
            ? tx.module.findUnique({ where: { id } })
            : tx.beat.findUnique({ where: { id } }));
        if (!selected) throw new Response('Content not found', { status: 404 });
        if (selected.authorId !== userId)
          throw new Response('Only the author can delete this content', { status: 403 });
        const methodIds = kind === 'method' ? [id] : [];
        const moduleIds =
          kind === 'module'
            ? [id]
            : kind === 'method'
              ? (await tx.module.findMany({ where: { methodId: id }, select: { id: true } })).map((row) => row.id)
              : [];
        const beatIds =
          kind === 'beat'
            ? [id]
            : (await tx.beat.findMany({ where: { moduleId: { in: moduleIds } }, select: { id: true } })).map(
                (row) => row.id
              );
        // Performance ownership wins for dual-linked notes: remove notes owned by
        // deleted performances; detach surviving performances' notes from content.
        await tx.beatNote.deleteMany({ where: { Performance: { beatId: { in: beatIds } } } });
        await tx.beatNote.updateMany({
          where: { beatId: { in: beatIds }, performanceId: { not: null } },
          data: { beatId: null },
        });
        await tx.performance.deleteMany({ where: { beatId: { in: beatIds } } });
        await tx.beatProgress.deleteMany({ where: { beatId: { in: beatIds } } });
        await tx.user.updateMany({ where: { currentModuleId: { in: moduleIds } }, data: { currentModuleId: null } });
        // This string stores Method.id (setCurrentMethodForModule), not MethodProgress.id.
        await tx.moduleProgress.updateMany({
          where: { currentMethodId: { in: methodIds } },
          data: { currentMethodId: null },
        });
        await tx.moduleProgress.deleteMany({ where: { moduleId: { in: moduleIds } } });
        await tx.methodProgress.deleteMany({ where: { methodId: { in: methodIds } } });
        await tx.beat.deleteMany({ where: { id: { in: beatIds } } });
        await tx.module.deleteMany({ where: { id: { in: moduleIds } } });
        await tx.method.deleteMany({ where: { id: { in: methodIds } } });
        return { success: true };
      },
      { timeout: 15000, maxWait: 15000 }
    )
  );
}
