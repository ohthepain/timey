# Codebase map

Timey is a MIDI rhythm-practice app. Read the code for current signatures and
configuration; this map explains responsibilities and the useful starting points.

| Area                     | Start reading                                                                                                       | Responsibility                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App shell and navigation | `src/routes/__root.tsx`, `src/router.tsx`                                                                           | Shared UI, authentication context, route restoration                                                                                                                                                                |
| Practice interaction     | `src/components/BeatViewer.tsx`, `Transport.tsx`, `TempoInput.tsx`                                                  | Display the beat and control practice                                                                                                                                                                               |
| Timing and MIDI          | `src/lib/TempoService.ts`, `MidiService.ts`, `MetronomeService.ts`                                                  | Clock pulses, MIDI input/output, metronome                                                                                                                                                                          |
| Capture and feedback     | `src/lib/BeatRecorder.ts`, `PerformanceFeedback.ts`                                                                 | Turn performed notes into timing/velocity feedback                                                                                                                                                                  |
| Event replay             | `src/lib/EventRecorderService.ts`, `EventList.ts`                                                                   | Capture/replay clock and note events; CSV import/export                                                                                                                                                             |
| Domain objects           | `src/types/Method.ts`, `Module.ts`, `Beat.ts`, `BeatNote.ts`, `Performance.ts`                                      | Practice hierarchy and recorded performance                                                                                                                                                                         |
| Persistence              | `src/repositories/`, `src/services/`, `prisma/schema.prisma`                                                        | Repository calls, server operations, relational storage                                                                                                                                                             |
| Authentication           | `src/contexts/KeycloakContext.tsx`, `src/config/keycloak.ts`, `src/utils/authenticatedServerFn.ts`                  | Browser identity and protected server access                                                                                                                                                                        |
| Auth foundation          | `src/server/auth.ts`, `src/server/auth-runtime/`, `src/server/domain-session.ts`, `auth/`                           | Server-only Better Auth handler, validated session/profile boundary, separate auth migrations; private practice and method/module writes cut over; beat create/copy cut over; editing/moves cut over; admin pending |
| Auth screens             | `src/routes/auth.$screen.tsx`, `src/components/auth/AuthScreen.tsx`, `AuthForm.tsx`, `AuthSession.tsx`              | Better Auth forms and session/cache control, including method/module create/edit and beat create/copy/edit; deferred content paths retain Keycloak                                                                  |
| Verification checkpoints | `scripts/verify.mjs`, `scripts/audit-result.mjs`, `.githooks/pre-commit`                                            | Isolated staged/working snapshots, strict audit and step evidence                                                                                                                                                   |
| Factory controls         | `scripts/factory.mjs`, `scripts/factory-interface.mjs`, `scripts/factory-status.mjs`, [interface guide](factory.md) | Issue focus/listing, saved progress, manual decisions and guarded worker dispatch                                                                                                                                   |

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

Transport state belongs to `TempoService`: `getTransportState` provides a stable,
read-only snapshot and `subscribeTransportState` releases its listener on cleanup.
`Transport` reads it through `useSyncExternalStore`; UI and MIDI invoke the same
play/record/stop/continue transitions. `stateChange` still drives recorder reset,
playback and metronome listeners. Replay enters recording with a simulated clock
inside `TempoService.replay`, then stops and restores the prior clock mode in
`finally`. `BeatRecorder.replay` orchestrates beat reset and supplies timing/note
callbacks to `EventRecorderService.replay`, which owns event iteration. Selecting
or cancelling a replay file does not change transport state. See the
[transport plan and evidence](../plans/transport-state-ownership.md).

Dependencies flow from `BeatRecorder` to MIDI/tempo, feedback and recorded events;
tempo and recorded events do not import each other or capture. Tempo's pulse
contains its interval; capture logs it with the current note index before index
advancement. `EventRecorderService` receives explicit timestamp/index context,
retains CSV serialization, and replays original timing/note inputs through the
supplied callbacks. `PerformanceFeedback.addBeatNote` receives BPM explicitly and
only calculates/accumulates feedback; capture logs derived feedback before
publishing it. This preserves event ordering without singleton lookups in the
calculation or event data. Tests in `TempoService.test.ts`,
`EventRecorderService.test.ts` and `Transport.test.tsx` exercise those interfaces,
including exact live/replay CSV parity and lifecycle cleanup.

Read [verification](verification.md) before exercising behavior and
[operating rules](operating.md) before coordinating work. Domain meanings belong
in `GLOSSARY.md`; architecture rationale belongs in relevant `docs/adr/` records.
Update this map when responsibilities, boundaries, or starting points change.

The [authentication foundation](../../AUTH_SETUP.md) owns `/api/auth/$` and
`/api/session`; private progress/performance functions use `requireDomainUser`,
and method/module create/edit plus beat create/copy/edit operations use `requireDomainUser`; deferred user paths retain legacy helpers until their coordinated cutover. Profile creation uses the trusted auth primary key and blocks
dependent domain work on failure. Auth and Prisma clients have no shared transaction.
The [ownership decision](../adr/0002-auth-domain-ownership.md) records migration boundaries.

The `/auth/$screen` routes use the browser-only `auth-runtime/client.ts`; they do
not import auth configuration, PostgreSQL or SMTP. `auth-runtime/mail.ts` supplies
server-owned SMTP reset delivery. `authDestination` constrains browser return
paths and `urlPersistence` leaves explicit auth navigation alone. These screens
do not replace server authorization or the app-wide Keycloak content context. `scripts/auth-fixture.py --browser` runs the existing foundation checks
plus rendered interactions through `auth-browser.py` and loopback SMTP capture.

Private practice uses `PracticeSession` (mounted beside the legacy Login button),
`state/privatePractice.ts`, `useBeatPractice` and the module route's progress hook.
The navigation store holds the current practice cache owner and generation; late
responses are discarded after identity changes. `BeatRecorder.savePerformance`
caches only successful server results. `PracticeFeedback` keeps the existing
last-eight-note grading calculation with the rendered feedback panel.
`performanceRepository` owns transactional recording replacement/deletion and
performance-owned note cleanup. See [setup and proof](../../AUTH_SETUP.md#private-practice-verification).

Method/module writes share strict schemas in `src/types/contentWrites.ts` across
server functions and `/api/modules` POST/PUT. Repositories own locked author and
destination checks plus writes in the same domain transaction. Only editable fields
reach Prisma; authorship never changes on edit. `MethodsAdminPage` and `AddModule`
use the existing validated browser session observer; keyed forms clear drafts on
identity changes. The method route reloads after creation and account switches.
The module update has no rendered editor; the fixture invokes its compiled server
function and API directly. See [write inventory and remaining legacy paths](../../AUTH_SETUP.md#methodmodule-write-verification).

Beat creation/copy contracts live in `src/types/beatWrites.ts`; repositories lock
and authorize the destination module through the nested insert transaction.
`createBeatServerFn` and existing-beat `saveBeatServerFn` use the same validated domain session boundary.
`CopyBeat` owns public-source destination selection and account-keyed state;
`ModuleViewer` gates new drafts by validated session/profile and module ownership.
See [inventory and proof](../../AUTH_SETUP.md#beat-creation-and-copy-verification).

Existing-beat editing shares strict `beatWrites.ts` contracts between the server
function and `/api/beats` PUT. `BeatRepository.updateBeat` locks the beat and any
move destination before author/parent checks and content replacement in one
transaction. It never updates authorship or practice history; performance-owned
notes are excluded from replacement and public content loading, including the
module route and copy sources. `BeatViewer` exposes editing to the ordinary
author independently of Admin mode; identity-keyed viewers/editors clear drafts. Save callbacks refresh the public
module data through the existing creation refresh path.
The designated-admin exception remains missing and explicitly deferred, along
with retirement. See [inventory and proof](../../AUTH_SETUP.md#existing-beat-editing-verification).

Ordinary-author deletion is centralized in `src/repositories/contentDeletion.ts`.
All five server/API entry points require the Better Auth domain identity. The
transaction locks domain tables before authorization/descendant selection, removes
all affected users' history and clears content references, returning success only.
`src/components/deleteContent.ts` shares the confirmation and cache reset across
MethodsAdminPage, ModuleList and BeatViewer. See the
[deletion proof and concurrency tradeoff](../../AUTH_SETUP.md#ordinary-author-deletion-verification).
