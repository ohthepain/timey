# Codebase map

Timey is a MIDI rhythm-practice app. Read the code for current signatures and
configuration; this map explains responsibilities and the useful starting points.

| Area                     | Start reading                                                                                                                                                                        | Responsibility                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App shell and navigation | `src/routes/__root.tsx`, `src/router.tsx`                                                                                                                                            | Shared UI, authentication context, route restoration                                                                                                                                                                |
| Practice interaction     | `src/components/BeatViewer.tsx`, `Transport.tsx`, `TempoInput.tsx`                                                                                                                   | Display the beat and control practice                                                                                                                                                                               |
| Timing and MIDI          | `src/lib/TempoService.ts`, `MidiService.ts`, `MetronomeService.ts`                                                                                                                   | Clock pulses, MIDI input/output, metronome                                                                                                                                                                          |
| Capture and feedback     | `src/lib/BeatRecorder.ts`, `PerformanceFeedback.ts`                                                                                                                                  | Turn performed notes into timing/velocity feedback                                                                                                                                                                  |
| Event replay             | `src/lib/EventRecorderService.ts`, `EventList.ts`                                                                                                                                    | Capture/replay clock and note events; CSV import/export                                                                                                                                                             |
| Domain objects           | `src/types/Method.ts`, `Module.ts`, `Beat.ts`, `BeatNote.ts`, `Performance.ts`                                                                                                       | Practice hierarchy and recorded performance                                                                                                                                                                         |
| Persistence              | `src/repositories/`, `src/services/`, `prisma/schema.prisma`                                                                                                                         | Repository calls, server operations, relational storage                                                                                                                                                             |
| Authentication           | `src/server/auth-runtime/client.ts`, `src/components/auth/UserMenu.tsx`, `LoginButton.tsx`, `src/utils/authenticatedServerFn.ts`                                                     | Better Auth browser client (`/api/auth`), header sign-in/menu, cookie-backed `withAuth` via `requireDomainUser`                                                                                                     |
| Auth foundation          | `src/server/auth.ts`, `src/server/auth-runtime/`, `src/server/domain-session.ts`, `auth/`                                                                                            | Server-only Better Auth handler, validated session/profile boundary, separate auth migrations; private practice and method/module writes cut over; beat create/copy cut over; editing/moves cut over; admin pending |
| Auth screens             | `src/routes/auth.$screen.tsx`, `src/components/auth/AuthScreen.tsx`, `AuthForm.tsx`, `AuthSession.tsx`                                                                               | Better Auth forms and session/cache control, including method/module create/edit and beat create/copy/edit                                                                                                          |
| Verification checkpoints | `scripts/verify.mjs`, `scripts/audit-result.mjs`, `.githooks/pre-commit`                                                                                                             | Isolated staged/working snapshots, strict audit and step evidence                                                                                                                                                   |
| Factory controls         | `scripts/factory.mjs`, `scripts/factory-ledger.mjs`, `scripts/factory-interface.mjs`, `scripts/factory-status.mjs`, [interface guide](factory.md), [factory UI guide](factory-ui.md) | Issue focus/listing, ledger CLI, saved progress, manual decisions and guarded worker dispatch                                                                                                                       |

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
`MidiService` emits slave transport commands and external clock pulse/loss events;
`wireMidiTransportToTempo` (mounted from `Transport`) applies them through
`midiTransportPolicy` and `TempoService` so the MIDI adapter does not call tempo
directly.

Dependencies flow from `BeatRecorder` to MIDI/tempo, feedback and recorded events;
tempo and recorded events do not import each other or capture. Tempo's pulse
contains its interval; capture logs it with the current note index before index
advancement. `EventRecorderService` receives explicit timestamp/index context,
retains CSV serialization, and replays original timing/note inputs through the
supplied callbacks. `PerformanceFeedback.addBeatNote` receives BPM explicitly and
only calculates/accumulates feedback; capture logs derived feedback before
publishing it. This preserves event ordering without singleton lookups in the
calculation or event data. Tests in `TempoService.test.ts`, `wireMidiTransportToTempo.test.ts`,
`EventRecorderService.test.ts` and `Transport.test.tsx` exercise those interfaces,
including exact live/replay CSV parity and lifecycle cleanup.

Read [verification](verification.md) before exercising behavior and
[operating rules](operating.md) before coordinating work. Domain meanings belong
in `GLOSSARY.md`; architecture rationale belongs in relevant `docs/adr/` records.
Update this map when responsibilities, boundaries, or starting points change.

The [authentication foundation](../../AUTH_SETUP.md) owns `/api/auth/$` and
`/api/session`; private progress/performance functions use `requireDomainUser`,
and method/module create/edit plus beat create/copy/edit operations use `requireDomainUser`. Profile creation uses the trusted auth primary key and blocks
dependent domain work on failure. Auth and Prisma clients have no shared transaction.
The [ownership decision](../adr/0002-auth-domain-ownership.md) records migration boundaries.

The `/auth/$screen` routes and header auth UI use the browser-only `auth-runtime/client.ts`; they do not import auth
configuration, PostgreSQL or SMTP. `auth-runtime/mail.ts` supplies server-owned SMTP reset
delivery. `authDestination` constrains browser return paths and `urlPersistence` leaves
explicit auth navigation alone. These screens do not replace server authorization.
`scripts/auth-fixture.py --browser` runs the existing foundation checks plus rendered
interactions through `auth-browser.py` and loopback SMTP capture.

Private practice uses `PracticeSession` (mounted beside the header sign-in control),
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

The local queue/issue interface is `scripts/factory-ui.mjs`; its HTTP, CLI,
human-input and result-checking modules are in `scripts/factory-ui/`. See
[its operating guide](factory-ui.md). `scripts/factory-ui.check.mjs` exercises
disposable queues, chat protocol fixtures and manual action boundaries.

Current-stage recommendations and dispatch are in `scripts/factory-ui/next-action.mjs`
and `progress.mjs`. `worker-history.mjs` reads the original worker through CLI RPC;
`review-result.mjs` defines the bounded read-only review and guarded report update.

Factory lifecycle presentation is computed in `scripts/factory-ui/lifecycle-view.mjs`
(stage rows and queue strip in one pass). `readiness.mjs` covers explicit action readiness;
`lifecycle.mjs` for routes and stage records, and `stage-transition.mjs` with
`skip-policy.mjs` for guarded optional skips. The workflow contract and storage
boundaries are documented in [factory UI](factory-ui.md).

`factory-ui/stage-skip.mjs` records a saved optional current-stage skip through the
shared completion policy and human advance guards, then saves any deferred
issue-focused recommendations against the resulting stage. Route planning alone
records no outcome and launches no work.

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

`scripts/factory-ui/recorded-result.mjs` retains acceptance of a recorded result independently of later source changes; it supports modern completion and existing
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
`recommendation-refresh.mjs` offers and executes approved-plan recovery for unused
stale recommendations. `data.mjs` supplies structured launch blockers; the ledger
checks expected proposal identity and staleness atomically before retirement.
The lifecycle replans unfinished work, preserving normal replacement scope checks.
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

Issue discussion lives in `scripts/factory-ui/discussion.mjs` (memory-only
sessions, issue context, expiry and one-use clicked intents),
`discussion-codex.mjs` (dedicated ephemeral model process),
`discussion-record.mjs` (guarded selected-output append), and `discussion-ui.js`
(temporary panel DOM, excluded from generic draft restoration). `http.mjs` exposes
only fixed discussion operations; `service.mjs` owns shutdown. These modules do
not use worker recovery or RunStore. See [temporary discussion](factory-ui.md#temporary-issue-discussion).

`factory-ui/site-review.mjs` owns Verify review targets, available browser choices,
open receipts and guarded human results. `site-review-ui.js` renders Open site,
feedback and review controls. Open receipts are memory-only; explicit results
retain the candidate and opening evidence in the issue's existing append path.
Worker-status snapshot decoration forwards the requesting owner so it cannot
lose the receipt required to enable a decision.

`factory-ui/delivery.mjs` owns resumable delivery receipts and issue-stage
finalization; `delivery-integration.mjs` invokes it after checked UI integration.
`factory-delivery.mjs` exposes the separate-checkout coordinator command.
`factory-ui/runtime.mjs` and `factory-runtime.mjs` identify the running UI source
and issue project. `factory-ui/queue-response.mjs` projects bounded polling data;
full saved runs remain available through the authenticated on-demand endpoint.

`scripts/factory-workflow-fixture.mjs` supplies shared disposable delivery fixtures;
`factory-workflow.check.mjs` owns the cross-format issue-decision compatibility
matrix. `CODING_STANDARDS.md` guides semantic review of workflow gates.
`scripts/verify-process.mjs` streams verifier subprocess output and retains channels.
`scripts/factory-deploy.mjs` validates candidates and manages local restart/recovery;
`factory-deploy-transport.mjs` owns HTTP preparation, listener draining and startup.
`factory-ui/deployment.mjs` blocks new mutations while an idle server drains.

`scripts/factory-refresh.check.mjs` exercises the browser polling/render handoff,
including deferred form/dialog updates and questions arriving while chat has focus.

Persistent issue chat is owned by `factory-ui/issue-chat.mjs`; `conversation-store.mjs`
retains user messages and native thread identity. `conversation-view.mjs` combines
that history with role results and actual answer receipts without rewriting those
owners. `conversation-context.mjs` supplies selected-issue context and full timeline
snapshots to execution/review turns. `issue-chat-runtime.mjs` keeps the conversational
model read-only and separate from worker/review connections; `issue-chat-ui.js`
preserves the composer while polling role updates. `scripts/factory-chat.check.mjs`
checks persistence, provenance, routing, isolation, pagination and UI drafts.

Queue lifecycle squares read the strip from `issueLifecycleView` on each issue snapshot.
`queue-lifecycle-ui.js` renders
the accessible strip with links to expanded issue steps; `route-toggle.mjs` guards
future-only route choices and persists them through the existing run store.
`factory-lifecycle.check.mjs` exercises the disposable persistence and
authorization boundaries.

`factory-deploy-readiness.mjs` records bounded, sanitized candidate/recovery
readiness observations. `factory-ui/runtime.mjs` exposes response metadata to the
probe without response bodies or cookies; `factory-deploy-transport.mjs` retains
its boolean readiness contract. Deployment receipts link observations persisted
by the unchanged candidate/recovery polling flow. Disposable deployment fixtures
cover HTTP/transport/decode failures, identity mismatches, successful readiness,
bounded retention and failed-recovery lock preservation.

`factory-ui/server-control.mjs` counts live actions and temporary chats, blocks new
UI work while paused or draining and requests coordinator pauses. `restart-process.mjs`
hands the installed listener to a replacement process and resumes saved paused
controllers through normal guards. `server-control-ui.js` owns the header controls
and reconnects without replacing the page or its draft. Disposable process and
transport tests live in `factory-server-control.check.mjs`.

`factory-ui/closure-reasons.mjs` reads project closure choices from the local
lifecycle Markdown. `issue-decision.mjs` keeps accepted fixes separate from
explicit user decisions to stop work; `factory-completion.mjs` preserves the
closure record without marking unfinished stages complete.

`factory-ui/priorities.mjs` reads the project’s ordered priority definitions and
projects default Major values without backfilling reports. `issue-priority.mjs`
records one-level user changes through the shared report writer and queue lock.

The issue view passes its visible lifecycle activity to `lifecycle-view.mjs`
before projecting the queue strip, so running work and pending input use the
same state on both screens. Disposable deployment fixtures retain explicit
commit preferences; refresh fixtures supply the routing helper used by the
actual polling function.

Browser MIDI and transport classes import the `events` package directly. Keep it
as an explicit root dependency so pnpm does not resolve these imports to an
unsupported Node built-in during browser builds.

Issue delivery is owned by `scripts/issue-delivery.mjs`, with immutable records and
locks in `issue-delivery-store.mjs`, local evidence/merge policy in
`issue-delivery-policy.mjs`, ledger receipt guards in `issue-delivery-records.mjs`
and GitHub transport in `issue-delivery-provider.mjs`. The CLI and UI delivery
handlers share these operations; `issue-delivery-fixture.mjs` supplies deterministic
protocol proof only. See [the delivery contract](issue-delivery.md) and
[ADR 0004](../adr/0004-issue-pr-delivery.md).

`factory-ui/verification-recovery.mjs` retains completed implementation across
failed independent checks, records the transition into Verify, and owns explicit
retries and branch updates in isolated checkouts. It retains selection receipts,
original bases and approval boundaries; it starts no model chats. `checks.mjs`
uses the summary paths returned by each verifier command rather than scanning
shared evidence for unrelated reports. `verify-scope.mjs` is safe for tests to
import; importing the verifier CLI starts verification.

`factory-ui/integration-recovery.mjs` recovers already-merged historical work during
approved lifecycle progress and owns the explicit recovery retry. It validates
command-owned reports, retains blocked reasons and resumes partial bookkeeping.
`factory-legacy-integration.mjs` validates the original run/reservation, current
Git ancestry, exact reports and human guards for the ledger's narrow historical
completion operation; normal record transitions retain the PR-delivery requirement.

`integration-reservation.mjs` supplies read-only eligibility for older stopped
coordinators. It enables Continue without changing queue state or clearing locks.

Delivery setup recovery lives in `scripts/factory-ui/delivery-setup.mjs`; it applies
matching human target decisions and connects them to lifecycle freshness and
in-issue input. `assembly-recovery.mjs` owns stopped-operation explanations and
stale-safe retries. `scripts/issue-delivery-assembly.mjs` retains/reuses the exact
merged assembly before verification. The delivery service still owns locking,
guards, contribution records and all remote effects.

`scripts/issue-verification-start.mjs` validates the narrow approved-plan start for
verification of assembled same-issue work. The ledger's `bindVerification` method
records it atomically. `scripts/factory-ui/verification-handoff.mjs` selects that
handoff, records its existing plan authority and supplies issue-branch retry inputs.
The ordinary launch guards and worker transport still execute the saved task;
implementation-start approval requirements remain separate.

`scripts/factory-ui/completion-review.mjs` selects and runs issue completion
reviews, compiles evidence-backed manifests and retains their normal delivery
validation. `pr-publication.mjs` presents and records the exact publication
approval, rejects stale results and delegates remote effects to the existing
idempotent delivery operations. Both use lifecycle progress; the browser supplies
no completion manifest or invented evidence hashes.
`completion-choice.mjs` keeps read-only delivery selection and freshness inputs
separate from review execution, avoiding a dependency from queue decisions back
into lifecycle model calls.

`factory-ui/completion-repair.mjs` turns a completion finding into one durable,
plan-linked repair recommendation. `issue-verification-start.mjs` validates both
verification-only starts and approved-plan repair starts against the issue branch.
`factory-ui/run-stream.mjs` restores output after the last history checkpoint.
Stream fragments append immediately to the existing per-run log; the full run
history is checkpointed at most once per second during streaming and immediately
for state transitions. Reload replays the uncheckpointed complete log records.

[Issue execution](issue-execution.md) owns the short-path and reuse contracts.
`issue-work-chat.mjs` selects the primary conversation without replacing uncertain
work; `direct-task.mjs` saves approved assessment tasks through existing guards.
`scope-coverage.mjs` retains input-specific scope decisions; `candidate-cache.mjs`
validates immutable automated evidence before reuse. `combined-completion.mjs`
applies final independent review findings through `completion-contract.mjs` and
the original delivery validator.

`worker-turn.mjs` pins assignment results and selects them from a shared chat;
`worker-history.mjs` validates their original checkout and recorded candidate.
