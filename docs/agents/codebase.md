# Codebase map

Timey is a MIDI rhythm-practice app. Read the code for current signatures and
configuration; this map explains responsibilities and the useful starting points.

| Area                     | Start reading                                                                                      | Responsibility                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| App shell and navigation | `src/routes/__root.tsx`, `src/router.tsx`                                                          | Shared UI, authentication context, route restoration               |
| Practice interaction     | `src/components/BeatViewer.tsx`, `Transport.tsx`, `TempoInput.tsx`                                 | Display the beat and control practice                              |
| Timing and MIDI          | `src/lib/TempoService.ts`, `MidiService.ts`, `MetronomeService.ts`                                 | Clock pulses, MIDI input/output, metronome                         |
| Capture and feedback     | `src/lib/BeatRecorder.ts`, `PerformanceFeedback.ts`                                                | Turn performed notes into timing/velocity feedback                 |
| Event replay             | `src/lib/EventRecorderService.ts`, `EventList.ts`                                                  | Capture/replay clock and note events; CSV import/export            |
| Domain objects           | `src/types/Method.ts`, `Module.ts`, `Beat.ts`, `BeatNote.ts`, `Performance.ts`                     | Practice hierarchy and recorded performance                        |
| Persistence              | `src/repositories/`, `src/services/`, `prisma/schema.prisma`                                       | Repository calls, server operations, relational storage            |
| Authentication           | `src/contexts/KeycloakContext.tsx`, `src/config/keycloak.ts`, `src/utils/authenticatedServerFn.ts` | Browser identity and protected server access                       |
| Verification checkpoints | `scripts/verify.mjs`, `scripts/audit-result.mjs`, `.githooks/pre-commit`                           | Isolated staged/working snapshots, strict audit and step evidence  |
| Factory controls         | `scripts/factory.mjs`, `.agents/skills/factory/SKILL.md`                                           | Manual decisions, guarded dispatch ledger; no background scheduler |

Follow the pulse/note path through MIDI → timing/capture → feedback before changing
timestamp semantics. Replay uses these same services; test their interaction, not
just the display. Services use singleton state, so tests must reset ownership and
timers. Server repositories obtain a checked Prisma client from `getServerPrisma`
or the typed `safeQuery` callback in `src/config/db.ts`. Acquire it when executing
a query, not at repository module scope: browser imports must not attempt database
access. `safeQuery` retains one reconnect-and-retry for existing connection-error
conditions. Authenticated handlers preserve their result types through `withAuth`;
browser callers receive the framework's serialized data contract. A jsdom mock is
not database evidence.

Read [verification](verification.md) before exercising behavior and
[operating rules](operating.md) before coordinating work. Domain meanings belong
in `GLOSSARY.md`; architecture rationale belongs in relevant `docs/adr/` records.
Update this map when responsibilities, boundaries, or starting points change.
