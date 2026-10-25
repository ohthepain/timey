# Codebase map

Timey is a MIDI rhythm-practice app. Read the code for current signatures and
configuration; this map explains responsibilities and the useful starting points.

| Area                     | Start reading                                                                                      | Responsibility                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| App shell and navigation | `src/routes/__root.tsx`, `src/router.tsx`                                                          | Shared UI, authentication context, route restoration              |
| Practice interaction     | `src/components/BeatViewer.tsx`, `Transport.tsx`, `TempoInput.tsx`                                 | Display the beat and control practice                             |
| Timing and MIDI          | `src/lib/TempoService.ts`, `MidiService.ts`, `MetronomeService.ts`                                 | Clock pulses, MIDI input/output, metronome                        |
| Capture and feedback     | `src/lib/BeatRecorder.ts`, `PerformanceFeedback.ts`                                                | Turn performed notes into timing/velocity feedback                |
| Event replay             | `src/lib/EventRecorderService.ts`, `EventList.ts`                                                  | Capture/replay clock and note events; CSV import/export           |
| Domain objects           | `src/types/Method.ts`, `Module.ts`, `Beat.ts`, `BeatNote.ts`, `Performance.ts`                     | Practice hierarchy and recorded performance                       |
| Persistence              | `src/repositories/`, `src/services/`, `prisma/schema.prisma`                                       | Repository calls, server operations, relational storage           |
| Authentication           | `src/contexts/KeycloakContext.tsx`, `src/config/keycloak.ts`, `src/utils/authenticatedServerFn.ts` | Browser identity and protected server access                      |
| Verification checkpoints | `scripts/verify.mjs`, `scripts/audit-result.mjs`, `.githooks/pre-commit`                           | Isolated staged/working snapshots, strict audit and step evidence |
| Factory controls         | `scripts/factory.mjs`, `scripts/factory-interface.mjs`, [interface guide](factory.md)              | Issue focus/listing, manual decisions and guarded worker dispatch |

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

The local queue/issue interface is `scripts/factory-ui.mjs`; its HTTP, CLI,
human-input and result-checking modules are in `scripts/factory-ui/`. See
[its operating guide](factory-ui.md). `scripts/factory-ui.check.mjs` exercises
disposable queues, chat protocol fixtures and manual action boundaries.

Current-stage recommendations and dispatch are in `scripts/factory-ui/next-action.mjs`
and `progress.mjs`. `worker-history.mjs` reads the original worker through CLI RPC;
`review-result.mjs` defines the bounded read-only review and guarded report update.

Factory lifecycle presentation uses `scripts/factory-ui/stage-state.mjs` for
recorded/future/current states, `readiness.mjs` for explicit action readiness,
`lifecycle.mjs` for routes and stage records, and `stage-transition.mjs` with
`skip-policy.mjs` for guarded optional skips. The workflow contract and storage
boundaries are documented in [factory UI](factory-ui.md).

`factory-ui/reconcile.mjs` reviews already finished work and validates a consecutive
set of evidence-backed stage outcomes before updating a stale issue. It never
launches workers, merges code or accepts issues.

`factory-ui/issue-decision.mjs` owns explicit final-review acceptance/closure and
reopening, with current report/evidence guards and preserved historical outcomes.

`factory-ui/worker-connection.mjs` restores missing task/chat connections using
validated existing conversations and the original ledger attach operation.

`factory-ui/plan-document.mjs` reads Markdown plans for the issue screen’s document
viewer, restricted to canonical regular files under the selected project’s docs/plans.

`factory-ui/plan-outline.mjs` locates issue-linked implementation plans and original
work sections/version groups. `plan-check-schema.mjs` describes the bounded
read-only review; `plan-review.mjs` records its guarded findings. `plan-checks.mjs`
validates checklist criteria, evidence and freshness, while `plan-approval.mjs`
records only explicit existing human-check decisions. These records do not advance
the lifecycle or authorize worker launches/integrations.

`factory-ui/plan-skips.mjs` records explicit individual/bulk user overrides for
ordinary implementation criteria; `plan-overrides.mjs` retains applicable skips
when the same plan and source are reviewed again.
`factory-ui/plan-decision-record.mjs` shares idle checks and atomic checklist
recording between read-only results and explicit user decisions.

`factory-ui/review-instructions.mjs` snapshots known installed instruction inputs
and exact approved supporting files. `review-recovery.mjs` reuses review chats and
validates recording checkpoints. `worker-review.mjs` retains the selected worker
result and corrects accidental raw-session citations in the same review chat.
`review-file-access.mjs` records narrow explicit
consent for an external supporting file and continues its original review.

`scripts/factory-ui/commit.mjs` records the existing verified commit and advances
only the Commit stage, without a model review or changes to source.

`scripts/factory-ui/closure-approval.mjs` records final checklist judgments supplied
by the explicit Accept and close action, retaining unchanged verification inputs.

`scripts/factory-ui/closure-registry.mjs` retains the changing factory task log as
administrative context during final acceptance, preserving its earlier hash.

`scripts/factory-ui/closure-result.mjs` checks recorded modern completion or existing
legacy integration records for explicit final acceptance, without inventing history.

`scripts/factory-ui/record-update.mjs` applies reviewed updates to one local issue
record and retains preservation receipts. `record-update-policy.mjs` limits that
path to excluded records and configured ordinary stages, ending at Final review.

The issue-level Progress controller is `factory-ui/lifecycle-control.mjs` and
`lifecycle-loop.mjs`; it composes existing operation handlers rather than replacing
their guards. `lifecycle-store.mjs` adapts the shared durable progress store.
`lifecycle-assessment.mjs`, `lifecycle-authorization.mjs` and `lifecycle-review.mjs`
review saved answers, original plan approval and assignment scope. Inline responses
route through `lifecycle-input.mjs` and `lifecycle-human.mjs`; native shared requests
retain guarded owner updates. `lifecycle-work.mjs` waits for child runs and reuses
existing chats for bounded corrections. See the UI guide for consent boundaries.

`factory-ui/activity.mjs` projects and bounds the sanitized live output stream;
`approval-options.mjs` exposes native approval choices and binds replies to pending
requests. `lifecycle-planning.mjs` separates actual human questions from unfinished
work and stopped operations. `lifecycle-stop.mjs` owns the meaningful-work fingerprint
and bounded planning recovery, so administrative notes cannot reset a failed review.
The browser retains keyed expansion, draft and scroll state around live refreshes.

`scripts/factory-ledger.mjs` owns assignment inspection and guarded ledger
transitions; `factory.mjs` is its command entry point. `factory-progress.mjs` owns
the shared issue progress ledger and implementation-check receipts.
`factory-completion.mjs` atomically records issue notes, criteria and stage history
for both front doors. `factory-checks.mjs` retains reviewed report copies and
freshness receipts. `factory-record.mjs` exposes native coordinator completion and
check recording using the same validation as the UI. `factory-authorization.mjs`
describes actual user actions, approved-plan continuation and coordinator work;
it grants no new authority. See [shared records](factory-records.md).

`factory-ui/lifecycle-continuation.mjs` validates and executes structured same-worker
continuations from issue planning. It checks current scope/answers and freshness,
then uses the existing resume transport; the lifecycle loop prioritizes it over
reviewing an unfinished result.

`factory-ui/worker-health.mjs` checks tracked turns through their owning Codex
connection and provides activity/status timestamps. It reconciles only confirmed
terminal turns, preserving pending input, newer activity and unknown state.
`factory-ui/codex.mjs` selects native automatic approval review for workspace-write
chats while keeping the sandbox. `approval-activity.mjs` projects public automatic
approval results into live output; it never grants access or reports test success.

`factory-inputs.mjs` defines selected decision inputs shared by issue planning and
ledger reservations. It follows report/action dependencies and linked plans while
excluding unrelated queue entries; full-queue grouping keeps its original guard.
