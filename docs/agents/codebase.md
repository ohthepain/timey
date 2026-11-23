# Codebase map

This repository implements the Timey MIDI rhythm-practice app in `src/` and the
Factory development app in `scripts/factory-ui/`. The project Home, Issues,
Discuss, and Admin tabs belong to Factory. Factory UI is application code in this
repository. Read the code for current signatures and configuration; this map
explains responsibilities and the useful starting points.

Project-local quick capture lives in `scripts/factory-ui/local-notes.mjs` and
`local-notes-ui.js`. The store resolves Git worktrees to their owning project,
keeps notes excluded from Git, and serializes writes with stale-edit protection.
`local-note-routes.mjs` joins notes to project discussion and existing issue
creation. `ProjectDiscuss.prepareNote` records quiet context and a draft;
`project-discuss-provider.mjs` passes that context on a later user turn.
`scripts/local-note.mjs`, project chat tools and the bundled `local-note` skill
share the store. See the [local notes design](../plans/local-notes.md).

| Area                     | Start reading                                                                                                                                                                                                         | Responsibility                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App shell and navigation | `src/routes/__root.tsx`, `src/router.tsx`, `vite.config.ts`, `src/start.ts`                                                                                                                                           | Shared UI, authentication context, route restoration, Vite+ and Start setup                                                                                                                                         |
| Practice interaction     | `src/components/BeatViewer.tsx`, `Transport.tsx`, `TempoInput.tsx`                                                                                                                                                    | Display the beat and control practice                                                                                                                                                                               |
| Timing and MIDI          | `src/lib/TempoService.ts`, `MidiService.ts`, `MetronomeService.ts`                                                                                                                                                    | Clock pulses, MIDI input/output, metronome                                                                                                                                                                          |
| Capture and feedback     | `src/lib/BeatRecorder.ts`, `PerformanceFeedback.ts`                                                                                                                                                                   | Turn performed notes into timing/velocity feedback                                                                                                                                                                  |
| Event replay             | `src/lib/EventRecorderService.ts`, `EventList.ts`                                                                                                                                                                     | Capture/replay clock and note events; CSV import/export                                                                                                                                                             |
| Domain objects           | `src/types/Method.ts`, `Module.ts`, `Beat.ts`, `BeatNote.ts`, `Performance.ts`                                                                                                                                        | Practice hierarchy and recorded performance                                                                                                                                                                         |
| Persistence              | `src/repositories/`, `src/services/`, `domain/schema.ts`                                                                                                                                                              | Repository calls, server operations, relational storage in the `domain` PostgreSQL schema                                                                                                                           |
| Authentication           | `src/server/auth-runtime/client.ts`, `src/components/auth/UserMenu.tsx`, `LoginButton.tsx`, `src/utils/authenticatedServerFn.ts`                                                                                      | Better Auth browser client (`/api/auth`), header sign-in/menu, cookie-backed `withAuth` via `requireDomainUser`                                                                                                     |
| Auth foundation          | `src/server/auth.ts`, `src/server/auth-runtime/`, `src/server/domain-session.ts`, `auth/`                                                                                                                             | Server-only Better Auth handler, validated session/profile boundary, separate auth migrations; private practice and method/module writes cut over; beat create/copy cut over; editing/moves cut over; admin pending |
| Auth screens             | `src/routes/auth.$screen.tsx`, `src/components/auth/AuthScreen.tsx`, `AuthForm.tsx`, `AuthSession.tsx`                                                                                                                | Better Auth forms and session/cache control, including method/module create/edit and beat create/copy/edit                                                                                                          |
| Verification checkpoints | `scripts/verify.mjs`, `scripts/audit-result.mjs`, `.githooks/pre-commit`                                                                                                                                              | Isolated staged/working snapshots, strict audit and step evidence                                                                                                                                                   |
| Factory controls         | `scripts/factory.mjs`, `scripts/factory-ledger.mjs`, `scripts/factory-interface.mjs`, `scripts/factory-status.mjs`, `scripts/factory-ui/index.html`, [interface guide](factory.md), [factory UI guide](factory-ui.md) | Issue listing and responsive navigation, ledger CLI, saved progress, timers, manual decisions, explicit strategy verification retries and guarded worker dispatch                                                   |

The Flow sidebar's In progress and Blocked pseudo-folders derive membership from
its project index in `scripts/factory-ui/flow-ui.js`. In progress contains running
issues. Blocked contains blocked, interrupted and confirmation-waiting issues,
excluding unapproved issues. Explicit
Pause excludes an issue from both collections until execution resumes. This pause
marker shares the existing in-memory autoplay lifetime and resets on server restart.
The collections never write issue folder assignments.

Factory UI folder organization is implemented in `scripts/factory-ui/issue-folders.mjs`;
it stores folder assignments independently from report content and lifecycle metadata.

The default Flow page opens **Project home** when no issue or folder is selected.
`scripts/factory-ui/project-home.mjs` composes project statistics, investigations,
and Automate me behind the authenticated project-home routes in `http.mjs`.
`project-home-ui.js` owns the home page, create-only investigation dialog, and
Automate me tab and dialog. Its tab controller also handles the sidebar Home,
Issues, Discuss, and Reports links. `project-investigations.mjs` owns reusable inquiry settings
and runs. `flow-ui.js` renders the ordinary investigation workspace;
`investigation-flow-controls-ui.js` supplies its reusable settings and direct
archive controls above the graph region. The controls attach before
`#graph-region`, keeping them outside its horizontal graph/overlay container.
`investigation-history.mjs` projects retained runs and linked
current issue states. Legacy custom layouts retain their original execution path
until explicitly rebuilt.
`investigation-snapshot.mjs` creates temporary detached copies and removes them
after the executor retains results; it creates no source-project worktrees or
branches. `investigation-records.mjs` supplies shared classification for Flow and
archive/publication. Investigations archive directly and restore open, with
ordinary issue closure and archive rules retained for other types.
`project-home-stats.mjs` reads open, closed, and archived reports; shared closure
history is preserved by `scripts/factory-completion.mjs`.

`project-automate-me.mjs` owns saved sessions and reviewed skill application.
`project-automate-history.mjs` gathers timestamped project conversations and
checks native thread project membership before reading content.
`project-automate-provider.mjs` adapts the installed PStack skill to a read-only
Codex interview. Apply owns filesystem writes and optional activation through
project settings. See the [project home design](../plans/project-home.md).

Follow the pulse/note path through MIDI → timing/capture → feedback before changing
timestamp semantics. Replay uses these same services; test their interaction, not
just the display. Services use singleton state, so tests must reset ownership and
timers. Server repositories obtain a checked Drizzle client from `getServerDb`
or the typed `safeQuery` callback in `src/config/db.ts`. Acquire it when executing
a query, not at repository module scope: browser imports must not attempt database
access. `safeQuery` retains one reconnect-and-retry for transient pool failures.
Authenticated handlers preserve their result types through `withAuth`;
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

`scripts/factory-ui/project-settings.mjs` presents the trusted human-input policy
from `guard.mjs` and provides explicit setup of a missing lifecycle file from the
pinned local-issues template. The Flow header's gear opens the categorized Settings window.
`project-settings-overview.mjs` projects lifecycle sources, connection references
and supported storage options without exposing secrets. `project-settings-ui.js`
owns direct page URLs and draft navigation. `project-preferences.mjs` owns project
chat prompt overrides and hotkey validation in `user/factory-preferences.json`.
The settings endpoint does not accept changes to the trusted human-input policy.
See [project Settings](../plans/project-settings.md).

The experimental native handoff starts at `scripts/factory-native-chat.mjs` and
the `/native-chat?issue=FULL_ID` factory page. It uses the existing shared progress
record owner for pending requests and home-chat bindings; its local CLI needs no
factory server or model connection. The [proof record](../plans/codex-native-handoff-proof.md)
distinguishes tested HTTP/record behavior from the pending native smoke test.

Read [verification](verification.md) before exercising behavior and
[operating rules](operating.md) before coordinating work. Domain meanings belong
in `GLOSSARY.md`; architecture rationale belongs in relevant `docs/adr/` records.
Update this map when responsibilities, boundaries, or starting points change.

The [authentication foundation](../../AUTH_SETUP.md) owns `/api/auth/$` and
`/api/session`; private progress/performance functions use `requireDomainUser`,
and method/module create/edit plus beat create/copy/edit operations use `requireDomainUser`. Profile creation uses the trusted auth primary key and blocks
dependent domain work on failure. Auth and domain database clients have no shared transaction.
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
reach the domain database; authorship never changes on edit. `MethodsAdminPage` and `AddModule`
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
`factory-ui/issue-numbers.mjs` persists monotonic local issue numbers separately
from report IDs; queue views and issue references present the number while saved
records retain their existing IDs, branches and workspace associations. The issue
detail header places the number in smaller muted text before the full-size title.
`factory-ui/guard.mjs` invokes the pinned human-input helper for dispatch checks;
subprocess failures retain exit status or signal and bounded structured helper
diagnostics while omitting raw process output. The guard remains fail-closed.
The header's running-action list is served by `scripts/factory-ui/server-control.mjs`
and `server-action.mjs`, rendered by `server-control-ui.js`, with focused output
links routed by `scripts/factory-ui/index.html`. Active Flow entries come from
`FlowService.active`, with saved block status and output links to the Flow issue.
Flow controls remain on the issue page. Cards name the operation, its triggering
block or issue control, and its purpose separately from the linked issue. Flow
building and branch repair also appear as operations outside blocks. The open
list refreshes with server status at most every two seconds without overlapping
requests. Refresh feedback retains its height and unchanged cards retain drafts. `issue-action-cancellation.mjs`
cancels stopped actions directly or when an issue closes, preserving work history
and leaving actions shared with another open issue untouched. It also cancels
an exact disconnected strategy preparation with no saved worker thread.
The issue detail's retro button runs the installed `retro` skill through
`issue-chat.mjs`, retaining its request and result in the issue's saved
conversation. `discussion.mjs` and `discussion-ui.js` hold only the temporary
selection panel; checked recommendations go through `issue-capture.mjs`.

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

`factory-ui/issue-decision.mjs` owns direct human acceptance/closure independently of lifecycle stages and
reopening, with current report/evidence guards and preserved historical outcomes.
`factory-ui/issue-cleanup.mjs` returns saved resource identities immediately for
the close dialog, checks resources independently, persists cleanup as an Action,
and rechecks each selected resource before removal/archive. Interrupted actions are
retained for identity reconciliation before retry. Issue
closure also archives eligible idle issue chats while preserving active or unknown
threads. It keeps
durable per-resource outcomes outside the removable workspace and supports retry
without reopening the issue.

`factory-ui/worker-connection.mjs` restores missing task/chat connections using
validated existing conversations and the original ledger attach operation.

`factory-ui/plan-document.mjs` reads Markdown plans for the issue screen’s document
viewer, restricted to canonical regular files under the selected project’s docs/plans.
`factory-ui/shown-file.mjs` reads one regular text file for a filename the issue screen
already shows. The path must resolve inside the project. It rejects symlinks, folders,
binary content, and files of 2 MB or larger. `file-link-ui.js` turns those displayed
paths into buttons for the same read-only dialog.

`factory-ui/report-document.mjs` reads the full current saved report by issue ID from
the authoritative project queue, requiring a contained regular file with matching
frontmatter identity and rejecting symlinks. Its authenticated issue-report resource
shares the escaped read-only dialog without widening the plans-only resource.

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
existing chats for bounded corrections. The issue screen renders the complete
“What happened” lifecycle event history with inline timestamps and role-transition
labels. See the UI guide for consent boundaries.

`factory-ui/issue-progress-ui.js` derives the default Progress tab from existing
issue, run, input and conversation records, including a saved PR link independent
of the PR's current status. `runs.mjs` persists phase timing for issue-work runs;
the Progress view shows the current phase and accumulated run time without adding a
separate workflow record. Its manual Refresh progress control requests the current
queue snapshot and issue conversation through the shared refresh path, without a
page reload or a new workflow operation. `index.html` renders that projection, reuses existing
input handlers and overlays transient Continue acknowledgment until fresh evidence
arrives.
`factory-ui/output-history.mjs` reads earlier public JSONL events using stable byte
cursors through the authenticated read-only output-history endpoint.
`factory-ui/activity.mjs` projects and bounds the sanitized live output stream;
`approval-options.mjs` exposes native approval choices and binds replies to pending
requests. `lifecycle-planning.mjs` separates actual human questions from unfinished
work and stopped operations. `lifecycle-stop.mjs` owns the meaningful-work fingerprint
and bounded planning recovery, so administrative notes cannot reset a failed review.
`recommendation-refresh.mjs` refreshes an unstarted approved assignment in place.
The ledger checks expected identity, clean source, original approval and retained
scope evidence atomically, preserves prior starting snapshots in its history, and
updates launch freshness without cancelling the assignment or replanning.
`factory-assignment-scope.mjs` binds semantic assignment fields to an actual plan
approval, the latest answer and an unchanged supporting receipt. Source revision
changes alone do not require a new scope decision; changed scope or altered evidence does.
`queue-selection.mjs` selects an eligible issue in code: saved implementation
order first, with priority, age and issue ID as the default order for unranked issues.
`implementation-order.mjs` reads and validates the project-local persisted order;
`implementation-order-route.mjs` writes it through a stale-basis-guarded endpoint. Running, blocked, failed, paused,
waiting and finished issues are excluded, including active or blocked assignments.
Selection never calls a model. Optional queue discussion still uses the coordinator UI. Selected-issue planning and reviews
use the issue's owning chat through `reviewIssue` and `lifecycleReview`.
The browser retains keyed expansion, draft and scroll state around live refreshes.
`view-state.js` owns keyed DOM reconciliation, matching text selections, and
same-tab expansion, editor dimensions, and scroll restoration. It defers affected
renders during pointer gestures. Disclosures whose open state is controlled by
application state use `data-view-controlled-open`; other disclosures retain the
person's choice independently of refreshed markup. Flow, Discuss, issue chat,
investigation results, Automate me messages, and repair output use this boundary.
Classic retains full replacement and event binding with shared view and selection
restoration. Draft owners save their text separately and clear it after submission.
See [the refresh-state plan](../plans/preserve-interface-state.md).
Conversation state is captured before DOM replacement, including reading position,
textarea scroll/caret and selected conversation text. Readers at the bottom keep
following new output; readers above it keep their position. Other issue text panels
restore internal scroll after focus and caret restoration. The rendered regression
is `scripts/factory-browser-refresh.mjs`.

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
`factory-ui/model-settings.mjs` exposes schema-validated tracked project defaults
and per-issue overrides used for newly started agent conversations. It delegates inherited
values to the folder settings owner and preserves legacy explicit issue preferences.
`issue-execution-settings.mjs` resolves issue overrides and saved execution snapshots;
`codex.mjs` applies the chosen model at `thread/start` and accepts model and effort
on each explicitly configured turn. Native sessions keep their owning agent;
project discussion provider changes use an explicit handoff. The issues-page
gear and per-issue selectors live in `factory-ui/index.html`. Focused behavior is
covered by `factory-model-settings.check.mjs` and
`factory-browser-model-settings.mjs`.

`factory-inputs.mjs` defines selected decision inputs shared by issue planning and
ledger reservations. It follows report/action dependencies and linked plans while
excluding unrelated queue entries; full-queue grouping keeps its original guard.

Issue decision review lives in `scripts/factory-ui/discussion.mjs` (bounded
sessions and clicked intents), `issue-discussion.mjs` (saved issue queue adapter),
`discussion-grilling.mjs` (stage interviews and exact human-quote validation),
`discussion-record.mjs` (guarded reviewed-output append), and `discussion-ui.js`
(review panel within Issue thread). The native issue conversation retains their
turns. `skills.mjs` validates enabled skills; the shared slash selector and chips
live in `issue-chat-ui.js`. See [reviewing issue discussion](factory-ui.md#reviewing-issue-discussion).

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
`factory-ui/issue-git.mjs` reads the selected issue's working branch and HEAD
from its worker or delivery checkout, independently of the server source;
full saved runs remain available through the authenticated on-demand endpoint.
`queue-human-input.mjs` batches shared display-only human-input reads within one
snapshot. Issue-specific readiness facts keep separate reads, and each new snapshot
reads fresh state. Execution guards remain independent. This avoids per-issue
synchronous helper launches starving the server's GitHub authentication requests.

The Flow sidebar's GitHub counter reads installation-wide metadata from
`github-call-history.mjs`. Its local SQLite store keeps totals and the latest
30 requests. `github-http.mjs` observes Timey's direct requests, while
`github-cli.mjs` reads individual attempts from GitHub CLI traces and discards
the trace content. Saved history excludes headers, bodies, and query strings.

The Pulse button opens **Codex API requests and usage** in a popup beside the header
without moving sidebar content. Its count and recent Codex records can be reset
independently of GitHub history, quota windows, and other diagnostic activity. The panel reads bounded local observations from
`diagnostic-activity.mjs`. `codex-diagnostics.mjs` attributes the protocol's
cumulative usage changes to the current turn and fingerprints supplied context.
Store timing records are batched. Flow supplies issue, block, and attempt labels
through the execution context. `codex-quota.mjs` reads usage windows through a
separate read-only app-server connection and retains the latest snapshot in memory.

Flow, Classic, and project Home display reads use the last confirmed store
snapshot. `stores/runtime.mjs` performs initial synchronization when no snapshot
exists, explicit refresh, and fresh mutation admission. Cached startup uses saved
state and does not start a background refresh. Storage status retains its last
confirmed check time and an explicit null warning after recovery. Failed refreshes
retain saved data and do not restart from display polling. See
[ADR 0024](../adr/0024-refresh-github-state-on-demand.md).
The Close-menu context is also a display read
from the saved snapshot; confirming closure still requires fresh state and the
existing acceptance checks. Confirmed report publications use the existing scoped
snapshot refresh for the affected issue; snapshot installation preserves other
saved issues. Flow and Classic creation initialize and validate the configured
stores without reloading existing reports, then refresh only the newly created
issues after confirmed publication. Cold startup still builds the initial snapshot.
Completed Flow capture retries refresh their saved issue before checking whether
another runner deleted or moved it. `FlowService.storageView` consumes that status
without repeating the project refresh. Selected-issue evidence loads once and
can reload on explicit Refresh. Explicit file reads await evidence hydration.
Selected Classic views reuse hydration for each confirmed snapshot generation. Flow persists
observed PR changes in the background and shows merged issues read-only immediately.
Flow actions reuse the fresh admission already performed by the authenticated
HTTP handler; direct controller callers still perform their own admission.
The Git record provider reads listing contents with `cat-file --batch` in groups
of at most 128 records and reuses those raw records across prefixes within a pinned snapshot.
Later snapshots rediscover the remote revision and read its records independently.
Selecting another issue forces a display load even while an earlier block check
is pending. That check retains the action lock and cannot replace another issue's view.

`factory-ui/strategy-publication.mjs` creates new strategy PRs through the App-authenticated
`StrategyProvider` after independent verification. Workers return the prepared
description and a null PR number. Publication reconciles open PRs on retry and
validates App authorship, the pushed candidate and approved target; saved existing
PRs retain their identity and history.
`factory-ui/issue-strategy.mjs` resolves the configured remote target before creating
a new issue checkout. It records coordinator commits absent from that target and
imports them only when each exact revision and reason is supplied in the start
instruction; existing issue checkouts retain their saved base.

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
retains messages and native identity. `conversation-events.mjs` projects sourced
Factory outcomes; `conversation-view.mjs` combines these with actual conversation
records. `conversation-context.mjs` supplies the same full timeline to model and
skill turns. `issue-chat-runtime.mjs` resumes the owning thread, using read-only
access for discussion and the issue checkout for editable requests.
`discussion-codex.mjs` owns isolated temporary model sessions. Project callers
supply the project root for native file/search/Git inspection under a read-only
sandbox with no approval escalation. `discussion-evidence.mjs` writes complete
context and large-input files with lengths and digests; temporary files are
removed with the session. `flow-retro.mjs` instead retains its full redacted
report, timeline, attempts and linked thread sections outside the issue worktree,
sends a small index and links that index from its saved result. Model reads are
selective; available evidence and inspected evidence remain distinct.
`flow-retro-thread.mjs` exports ordered public native items, including tool calls,
outcomes and permission decisions, for `flow-retro.mjs`. Each export retains turn
IDs, available timestamps and linked attempt IDs. Exact turn ownership requires
a saved turn ID. Missing timing, results, decisions and unsupported payloads are
explicitly unavailable. Private reasoning is excluded and public values are redacted.
`flow-retro-proof.mjs` supplies Retro only timeline-linked artifacts with recorded
SHA-256 digests. It verifies checkout containment and digest before adding a
bounded redacted excerpt; missing, changed and out-of-checkout artifacts carry
status only. Each artifact keeps its originating event and attempt reference.
`flow-source-evidence.mjs` supplies follow-ups with their explicit source
issue's saved report and ordered attempts from coordinator storage. It retains a
sanitized input snapshot and verifies GitHub response artifact digests before
including them. Snapshots larger than 64,000 characters are supplied to the model
as a path and digest with instructions to read the retained JSON. This keeps
source history out of the provider's text input limit without discarding it.
Retry replaces a conversation only when retained evidence confirms its oversized
first input was rejected with no accepted receipt or model output; other failed
conversations retain their existing recovery guards.
Investigation follow-ups select their recorded `source_attempt`;
Retro follow-ups retain the complete available attempt history. Workers do not
need the source queue copied into their checkout.
`issue-prompt-queue.mjs` owns durable prompt identities, revisions and attempt
receipts. `issue-prompt-scheduler.mjs` coordinates FIFO dispatch, pause, stop,
steer, uncertain receipt recovery and operation leases. `issue-operation.mjs`
places boundaries around existing Factory owners; verification and GitHub remain
with those owners. `issue-chat-ui.js` preserves drafts, selected skills and queued
entry controls while polling. Chat, native-chat, history and browser checks cover
persistence, provenance, cancellation, recovery and issue isolation.

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

`factory-ui/server-control.mjs` counts live actions, unfinished saved runs, cleanup
and temporary chats. It blocks new
UI work while paused or draining and requests coordinator pauses. `restart-process.mjs`
hands the installed listener to a replacement process and resumes saved paused
controllers through normal guards. `server-control-ui.js` owns the header controls
and reconnects without replacing the page or its draft. Disposable process and
transport tests live in `factory-server-control.check.mjs`.

`factory-ui/closure-reasons.mjs` reads project closure choices from the local
lifecycle Markdown. `issue-decision.mjs` keeps accepted fixes separate from
explicit user decisions to stop work; `factory-completion.mjs` preserves the
closure record without marking unfinished stages complete. `issue-cleanup.mjs`
retains cleanup previews and partial results under `.issues/factory-ui/cleanup/`.

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

Queue sort values are projected from saved records in `factory-ui/queue-sort.mjs`
before transport trims run events. `queue-sort-ui.js` owns presentation ordering
and accessible controls, including the default merged/running/queued status order.
Manual implementation ordering is persisted separately; the other view sorts do not
affect scheduling or issue records.

Queue human-input sorting consumes the shared reader's availability and revision-bound
deferral projection through `factory-ui/queue-human-input.mjs`. Saved delivery
contributions supply readiness facts; unavailable facts remain unavailable. This
read-only presentation does not change dispatch checks or human results.

Description-only issue capture is owned by `factory-ui/issue-capture.mjs`. It
separates no-tools semantic assessment (`capture-assessment.mjs`), configured
initial routing (`capture-routing.mjs`) and exclusive recoverable publication.
`issue-capture-ui.js` owns the persistent dialog, draft identity and toast outside
the list's replaceable DOM. HTTP dispatch retains existing mutation guards; this
boundary calls no worker or lifecycle dispatch. See [factory UI](factory-ui.md#create-an-issue-from-the-list).

`factory-ui/verification-recovery.mjs` retains completed implementation across
failed independent checks, records the transition into Verify, and owns explicit
retries and branch updates in isolated checkouts. It retains selection receipts,
original bases, recorded source-branch defaults and approval boundaries.
`verification-merge.mjs` owns merge identity checks and a bounded conflict-resolution
turn in the existing issue chat, retaining the original implementation turn before
independent checks. It does not create replacement chats or publish/accept work. `checks.mjs`
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
Completion routing and server readiness use `completionStage` in
`scripts/issue-delivery-policy.mjs`. This shared role-based policy lets assembled
Implement candidates reach pre-publication review without first requiring target
integration. Stage advancement, custom-stage obligations and publication/merge
permissions remain separate gates.

`factory-ui/completion-repair.mjs` defines the completion-review repair schema;
retained repair work stays on the completion-review run until later commit-stage
routing saves or launches it. `issue-verification-start.mjs` validates both
verification-only starts and approved-plan repair starts against the issue branch.
`factory-ui/run-stream.mjs` restores output after the last history checkpoint.
Stream fragments append immediately to the existing per-run log; the full run
history is checkpointed at most once per second during streaming and immediately
for state transitions. Reload replays the uncheckpointed complete log records.

[Issue execution](issue-execution.md) owns the short-path and reuse contracts.
`issue-work-chat.mjs` selects the primary conversation without replacing uncertain
work; `chat-name.mjs` gives threads a role-first title and a conservative activity
marker; `direct-task.mjs` saves approved assessment tasks through existing guards.
`scope-coverage.mjs` retains input-specific scope decisions; `candidate-cache.mjs`
validates immutable automated evidence before reuse. `combined-completion.mjs`
applies final independent review findings through `completion-contract.mjs` and
the original delivery validator.

`worker-turn.mjs` pins assignment results and selects them from a shared chat;
`worker-history.mjs` validates their original checkout and recorded candidate.
`worker-result-recovery.mjs` observes disconnected original turns, bounds report-only
JSON correction, and retains unverified committed work for existing draft handoff.
`planning-revalidation.mjs` rechecks source-only changes against retained proposals
and enumerates actual eligible worker continuations. Recovery cases are covered by
`scripts/factory-worker-result-recovery.check.mjs` and the focused UI lifecycle tests.

`factory-ui/evidence-staging.mjs` retains declared supplemental artifacts and
resolves contribution-bound indexes for completion compilation. It does not
interpret logs as a pass. `verify-preflight.mjs` checks installed dependencies and
actual listener capability before checks; `verify-process.mjs` owns cancellation
of its child group. `factory-ui/input-change.mjs` compares captured input hashes
and reports coordinator-owned recovery without changing approval policy.

Browser verification uses `scripts/factory-browser.mjs` and its
`browser-fixture.mjs` disposable data server. It discovers tracked
`factory-browser-*.mjs` scenarios and the legacy sorting replay, reads actual
candidate assets, and retains CLI logs and screenshots.
`browser-scenario-policy.mjs` keeps drag-and-drop scenarios opt-in through
`pnpm run test:browser:drag-and-drop`; ordinary and full regression exclude them. `verify.mjs` invokes it
before the other behavior/type/build checks and records artifact hashes in the
full summary. `factory-ui/checks.mjs`, candidate caching and issue delivery retain
and validate this browser evidence against the same candidate tree.

Clarification and grilling remain human input independently of lifecycle position.
`capture-routing.mjs` validates explicit lifecycle transitions while allowing
projects to omit the optional `ready-for-grilling` role; old reports and custom
stages retain their saved states. `capture-grilling.mjs` starts opt-in
post-capture conversations through the existing persistent chat owner after durable
creation; capture identities deduplicate retries. See [ADR 0001](../adr/0001-human-input-separate-from-lifecycle.md).
The create dialog's Grill, Go and Merge choices are independent and initially off.
`issue-capture.mjs` stores the selected intent on each report before the browser
starts Go or grilling; when both are selected, the issue page retains the chosen
strategy for an explicit Continue after grilling answers and plan approval.

`factory-ui/turn-failure.mjs` formats structured provider failures for both
`codex.mjs` errors and retained `activity.mjs` output. Issue output shows explicit
connected/idle status; retryable progress keeps its stopped reason and next action
as separate fields rather than substituting a generic availability message.

Default delivery routing lives in `scripts/factory-ui/delivery-mode.mjs`, which
preserves saved route decisions and supplies post-PR skip defaults. Worker runs
freeze their delivery mode at launch. `handoff-checks.mjs` retains one attempt per
unchanged candidate, including failures. `scripts/issue-draft-handoff.mjs` prepares
the manual handoff report; shared delivery publication retains provider identity
and recovery guards. `pr-publication.mjs` finishes Progress at a draft handoff;
verified delivery still uses the existing completion and merge protocol. See
[the default handoff contract](issue-delivery.md#default-draft-pr-handoff).

The shared queue coordinator is owned by `factory-ui/coordinator.mjs`;
`coordinator-store.mjs` retains its operation, conversation history and source
references. `coordinator-notes.mjs` validates bounded computed findings against
source hashes; current-context usage controls early rotation rather than billing
or turn counts. Predecessor archival follows successful replacement attachment. `coordinator-ui.js` renders its dedicated page and compact activity strip.
Only optional queue discussion uses its separate connection. Issue planning and
reviews use the owning issue chat; queue scheduling uses no chat. Failed or interrupted
legacy operations retain their results and stop for manual attention. They do not trigger AI
recovery reviews, automatic worker continuations, completion repair assignments or
replanning when inputs change. Explicit retry controls retain their approval guards.
Workers and independent reviews retain their existing connections. The explicit
strategy path below permits bounded blocker repair within its active owning run.
Behavioral coverage is in `scripts/factory-coordinator.check.mjs`.

Factory verification recovery is covered by `scripts/factory-recovery.check.mjs`:
unchanged failures, explicit retries, evidence integrity, live logs and new-chat
model selection. `scripts/factory-test-service.mjs` supplies protocol fixtures
with an explicitly shared stub transport for both coordinator and worker calls;
production retains separate connections.

`factory-ui/issue-strategy.mjs` owns explicit Full Stop/Full Send starts, typed scope
receipts, reuse of the issue checkout/chat, and final candidate checks. It does not
use lifecycle role planning or completion manifests. `strategy-prompt.mjs` bounds
the owning assignment; `strategy-review.mjs` implements optional bounded Sol review;
`strategy-provider.mjs` reads live PR readiness through `strategy-readiness.mjs`
and submits an exact-head merge. Flow Merge and Full Send follow GitHub's
readiness decision. Full Stop handoff evaluates its configured review bypass
and independent strict CI ruleset.
`github-request-failure.mjs` preserves bounded, sanitized GitHub validation fields
without raw process output or credentials. Flow publication retains those fields
with its exact proposed head and target, including failures after a branch push.
`strategy-inclusion.mjs` inspects the original base against the fetched target,
records exact branch/checkout/commit evidence, and blocks unreviewed earlier work
before owner turns and PR publication while preserving the original base. Its PR
comparison records the target SHA, checkout HEAD, merge base, and changed paths;
target updates, issue commits, and repair commits are listed separately.
Full Send binds the human-input merge guard's candidate tuple to the UUID of the
active strategy run, the exact verified head and current PR target; the issue
label remains display identity only.
`github-app.mjs` owns repository-scoped installation authentication, in-memory token
refresh and project-local credential configuration shared with worktree providers.
The issue screen shows strategy/status, keeps a configured-target merge action visible
throughout issue work, and collapses legacy roles into disabled history. The action
continues the saved strategy in the owning chat so target conflicts stay with that
work. `factory-strategy.check.mjs` covers handoff, merge boundaries, preservation,
failures, explicit starts and missing review capabilities.

`strategy-repair.mjs` owns the active run's bounded repair ledger and infrastructure
retries; `strategy-target.mjs` fetches/merges the configured target and preserves
conflicts for the owner. `strategy-readiness.mjs` classifies PR blockers, observes
pending CI and reconciles an externally merged candidate. The controller preserves
the checked PR head across Continue and reuses verification only when the confirmed
merge has the same tree; changed merge content remains on the repair path. It retains
implementation and independent verification before later delivery can fail;
repair turns reuse a completed owner's chat without replaying chat creation.
The policy is recorded in each explicit start receipt and never wakes inactive work.

`factory-ui/strategy-closure.mjs` validates saved strategy verification and step
summaries against their recorded candidate and retains their evidence for explicit
acceptance. `strategy-delivery-recovery.mjs` can recover a blocked or cancelled
strategy's published PR at Fixed acceptance by checking its saved branch, live
merge, current target ancestry and passing checks with GitHub, then retaining a
durable receipt. Recovery never restarts the worker or performs merge or acceptance.

`factory-restart.mjs` is the external `pnpm factory:restart` launcher. It restarts
the current checkout as-is, including WIP, and carries that source-changed state
through readiness. It uses deployment transport/readiness probes and restarts only
an owned, drained listener. Its disposable server checks live in
`factory-restart.check.mjs`.

The explicit [flow workspace](../adr/0013-explicit-issue-flows.md) starts at
`scripts/factory-ui/flow.html`, `flow-ui.js`, and `flow.css`. `flow-store.mjs`
owns the graph and revision-checked edits. `flow-service.mjs` owns flow mutations,
explicit attempts, invalidation, route rebuilding, capture, and artifact listing.
Active attempt updates read the persisted graph directly through `FlowStore`.
They retain revision checks without rediscovering folder settings or rebuilding
the display. Group eligibility rejects issues with existing work before resolving
their settings.
Each Flow view shares a folder settings snapshot across its issue rows. The
snapshot lasts for that view only; mutation checks resolve current settings.
`merged-issue.mjs` identifies retained merged delivery and defines the read-only
policy. Flow operations and HTTP mutation guards enforce it; metadata helpers
also reject changes to saved merged issues. The observer refreshes linked PRs
before edits, and `flow-delivery.mjs` validates retained merge proof for Close.
See [ADR 0020](../adr/0020-freeze-merged-issues.md).
`execution-permissions.mjs` supplies native permission guidance for model-run
checks. `work-progress.mjs` separates bounded unfinished-work continuations from
check repairs and stops for concrete human, permission or external blockers.
`flow-repair-evidence.mjs` copies Merge failure records and failed-check logs into
the issue checkout before its repair worker starts.
`branch-repair.mjs` owns issue-page branch repair runs and approval.
`branch-repair-workspace.mjs` snapshots the source without changing its index and
applies only an approved patch. `branch-repair-runner.mjs` runs the block prompt
and Work prerequisite checks in the isolated candidate. `branch-repair-ui.js`
renders the header button and retained progress and review dialog.
`flow-ui.js` offers catalog blocks, including user-added Retro blocks; the distinct
`closure-retro` block remains managed by the issue's closing settings.
The project landing area has Home, Issues, Discuss and Admin tabs. Issues sits
between Home and Discuss and embeds the shared issue workspace for project-wide
and folder views. `project-issues-bulk.mjs` applies selected shared fields with
per-issue outcomes. Tapping an issue opens its normal Flow workspace in the top-level page.
Open-issue checkbox selections use the shared bulk editor, including one checked issue.
Always-visible Open/Closed controls scope the list and clear selection when switching.
Selections containing only closed issues hide the detail column and offer Archive all
through the guarded issue-storage operation; archiving reports per-issue outcomes.
The embedded list opts into closed reports from the Closed folder.
The project-wide queue iframe starts when the Issues tab is first opened;
Request embeds do not start another hidden queue, and investigation routes retain
the Request inspector inside that embed. Its selected-issue view skips the full
project index and branch catalog while actions retain their existing checks.
Saving Your words acknowledges the saved wording and admitted Request attempt
before clarification finishes. The browser clears its global busy state and
polls the retained attempt for progress and failure. Direct callers can still
await the derived Request fields without selecting background completion.
The [Issues tab
design](../plans/project-issues.md) records the three-column workspace behavior.
`project-discuss.mjs` owns independent project conversation persistence,
per-message settings, queued prompts,
attachment snapshots and explicit Stop/Resume/Retry/Steer. It never enters the issue
scheduler. `project-discuss-provider.mjs` connects those conversations to native
Codex turns in the current project folder, handles permissions and conditional
clarification, and registers the guarded tools in `project-discuss-tools.mjs`.
These tools call the existing Home and issue controls and return direct results.
The `issue_edit` tool changes only original request wording and issue type; a
wording change reruns Request clarification, while a type change applies that
type's default flow. To start an issue's saved route from Discuss, query it with
`issues_list` and call `issue_control` with `action: play`. `action: start` is
for an explicitly selected runnable block and cannot start Request directly.
Issue activity is not streamed back into Discuss.
`project-discuss-ui.js` and
`project-discuss.css` own the composer, single-visible-conversation history,
horizontal conversation tabs, message alignment and hover actions, settings,
attachments, dictation, and suggested prompts. Dictation recognizes the final
[spoken send command](../../GLOSSARY.md#language) and submits through the existing
composer form after removing it. The composer overlays the bottom
of the scrollable history with enough trailing space to keep the final message
visible. First opening a conversation scrolls the loaded history to the bottom,
including after initial images settle. Interacting with the history cancels that
opening scroll. Polling, same-tab reload, and returning to Discuss preserve the
reader's position. Expanded activity and editor dimensions also survive these
updates. New events within an existing message retain its activity expansion.
Its settings and attachment
controls share a row with Send. Discuss hides
the shared Flow footer. The shared skill composer, message envelope, send icon, and dictation handler
live in `issue-chat-ui.js`. Project, report, and Classic issue chats reuse these
controls. Flow conversation entries reuse the same message envelope.
`activity-indicator-ui.js` supplies the shared three-dot activity indicator for
chat histories, Automate me, Classic decision review, coordinator conversations,
and active issue work. `project-discuss.css` owns its animation and reduced-motion
styles. Flow places the issue indicator outside `graph-scroll`, in an overlay
anchored to `graph-region`, so blocks scroll behind it. Agent permissions and
human-input waits suppress activity. Active branch updates and repairs also show
the issue indicator. The [activity indicator design](../plans/chat-and-issue-activity-indicators.md)
records the agreed behavior and duration-estimate limits.
Open conversation tabs stay in creation order; closing a tab marks its conversation
closed and retains its saved history.

`ai-text-ui.js` and `ai-text.css` provide shared top-right Copy, Bro and Dictate
controls for AI text. Renderers mark AI content with `data-ai-text`, a stable
`data-ai-key` and its exact `data-ai-source`. Bro preserves the original and shows
the simplified version until toggled off. `ai-text-bro.mjs` loads the installed bro
skill and rewrites in a separate read-only model conversation. Dictating into an
output opens a local editable copy. It does not rewrite retained AI evidence.
Alt+D targets the hovered dictatable field, then the focused field, then the
Discuss composer. Dictation preserves an existing caret or appends at the end.
Editable AI drafts use their existing field and save controls. The shared
`chatMessageMarkup` envelope accepts AI source text and a stable key, so project
and report conversations retain these controls. Shared chat dictation uses the
same caret tracking as the hover controls.
`skills.mjs` retains invocation policy and discovers installed
`factory/system/skills` as Factory skills alongside `user/skills` wrappers.
The factory's `archive` skill submits issue numbers to the existing archive tool
in one batch. Storage controls resolve numbers from one registry read, deduplicate
the selection, and retain per-issue outcomes and existing publication safeguards.
`investigation-execution.mjs` binds output attempts to successful inquiry snapshots.
`investigation-adoption.mjs` recognizes idle standard legacy layouts and preserves
original inquiry IDs and saved creation receipts. Execution order uses the saved
block array. Output dependencies point to the inquiry, so report presentation
changes do not invalidate issue creation.
`investigation-reports.mjs` retains immutable publications and evidence under the
project's ignored runtime directory. Publication identity survives Retry; a new
explicit generation gets another identity. `investigation-outputs.mjs` owns
approval-needed issue capture and per-finding receipts shared across skills.
`investigation-output-execution.mjs` binds these guarded tools to the active output
and retains returned saved-result references before snapshot cleanup.
The default `factory/system/skills/generate-report/SKILL.md` uses `/bro` for
user-facing copy and its linked `report-design.md` for a self-contained editorial
HTML document. Internal issue records and machine-readable outputs keep their
existing formats. The Generate report block delegates copy and layout to the
selected skill.
`project-reports-ui.js` owns the Reports library and full-width reader. Complete
HTML reports render in a script-disabled iframe with isolated styles and a
restrictive resource policy. Evidence links resolve to verified retained copies;
unavailable evidence stays explicit. The reader preserves HTML scroll position
and continues to render existing Markdown publications. Its lower
panel reuses `project-discuss-ui.js`; `report-discussion.mjs` binds that conversation
to the investigation and copies selected report context into each message.
Archived inquiry execution stays guarded while retained report discussion remains
available. `investigation-flow-controls-ui.js` supplies reusable settings, Run again,
and direct Archive alongside the ordinary graph.
`flow-followups.mjs` owns reviewed follow-ups from completed Understand results.
`investigation-proposals.mjs` prepares proposals in a read-only discussion;
`investigation-followups-ui.js` owns selection and editing. Retained findings bind
each review to its source attempt, and stable capture identities prevent duplicate
creation after restart or partial publication. This is independent of Retro.
Read-only flow views show saved reports while the shared queue refreshes in the
background. Report reads reuse parsed metadata only when the exact frontmatter
matches and read the current body each time. Mutation freshness checks remain
independent of this display cache. A selected report missing locally waits for
its first shared copy. `shared-issue-queue.mjs` reuses the archive preflight's
target snapshot for initial claim validation, then fetches again after claiming
to validate the report. A direct archive prepares its publication from that
verified commit and requires the remote branch to retain the same hash. The
candidate must be a direct child of the verified commit. A changed remote head
requires a fresh read and revalidation before retrying.
`shared-issue-transport.mjs` owns a private, reusable SSH connection for each
shared queue. Claims, publication reads and background refresh share that
connection. Custom SSH commands and non-SSH remotes retain their existing
transport. Server shutdown closes the owned connection and removes its private
socket directory.
`.oxfmtrc.json` owns formatter options for Vite and issue reports.
`issue-report-format.mjs` passes that file explicitly to the formatter, so report
writes do not load the application's Vite plugins.
`shared-issue-config.mjs` owns the metadata path allowlist.
The [Issue, Coordination, and Artifact store specification](../plans/issue-stores.md)
and [ADR 0022](../adr/0022-separate-issue-coordination-and-artifact-stores.md)
describe the storage roles and shared-provider contracts.
[ADR 0023](../adr/0023-select-issue-and-artifact-storage-per-issue.md) defines
per-issue storage profiles and project storage modes.
`stores/config.mjs` validates the version-2 registry, named destination pairs,
project mode, and secret references. Its legacy normalization preserves existing
destinations without rewriting registry files. `stores/settings.mjs` resolves
project and folder profile defaults into actual Issue and Artifact store IDs;
`stores/runtime.mjs` opens providers lazily, imports verified legacy data, follows
confirmed role migrations, backfills saved Artifact destinations through checked
activation, and registers canonical report access.
`stores/project-stores.mjs` owns the catalog, numbers, attempts, claims, logs,
remote Stop requests, and migrations. Catalog entries retain `storeId` and
`artifactStoreId`; mutable profile names do not route saved issues.
Issue-bound artifact routers write to those saved destinations. Provider overflow
and operation receipts use the project's Coordination artifact store, selected
by the registry's `artifacts` field. `stores/migrations.mjs` verifies issue records
and owned artifact copies before switching a complete group's catalog destinations.
Issue moves preserve immutable proof JSON and do not install global digest
redirects. Historical physical references remain readable. `stores/providers.mjs` supplies Issue and
record contracts for files/Git, Postgres, and DynamoDB. `stores/artifacts.mjs`
supplies files/Git, Postgres, and S3 bytes. `stores/snapshots.mjs` installs
validated local display projections and preserves report drafts; report writers
enter `stores/report-access.mjs` for authoritative checks. `stores/evidence.mjs`
retains and resolves immutable evidence without rewriting hashed proof JSON.
A view shares its observed folder catalogue and field choices across issue
settings and folder forms. The next view reads a new snapshot; mutation helpers
retain fresh discovery. Evidence display metadata is bounded by bytes so large
issue histories can remain warm without retaining their file bodies.
Flow and report display reads reuse bounded parsed file generations, returning
isolated values and observing replacements, edits, and deletions. Evidence-list
reuse also follows resolver registration changes; evidence actions retain fresh
integrity checks. Git environment cleanup reuses executable-defined variable
names while rebuilding and filtering the current environment for every command.
`stores/providers/records.mjs` keeps overflow decoding within the active read
snapshot for the exact record provider. Artifact relocation lookups reuse that
Coordination snapshot across nested Issue snapshots. Ordinary reads and mutations
retain fresh authority checks, and completed snapshot scopes cannot be reused.
When the Issue and Coordination roles share a store, ordinary unowned report
edits publish the report, its history, and the confirmed operation in one checked
transaction. Catalog, flow, claim, migration, and report revisions guard the write.
Other publications retain the existing claim and recovery protocol.
Approval admission requests only its selected issue; the store runtime tracks
full and selected refresh coverage so a narrow refresh cannot satisfy a broader
authoritative read. Cold initialization retains a complete display snapshot.
`stores/coordination.mjs` returns the exact records supplied by confirmed
operation commits. Opening, updating, and confirming an operation do not reread
those records over the network; admission reads, revision checks, and recovery
after an uncertain commit retain their existing authority checks.
`stores/classic-operation.mjs` admits Classic workers, lifecycle loops, strategy
jobs, and queued work prompts through the same ownership and journal protocol.
It acquires every issue claim before grouped work and retains RunStore events
before display truncation. `stores/classic-snapshot.mjs` projects shared legacy
history locally, removes foreign transport pointers, and restores committed
source checkpoints after admission. A storage barrier keeps downstream Classic
publication and merge waiting when shared confirmation is unavailable.
`issue-store-ui.js` shares required profile choices, saved-destination readback,
and checked moves across creation, follow-up, issue settings, destination, and
bulk controls. `project-settings-ui.js` edits profile names, pairs, retirement,
and defaults. Project mode is read-only. Retained move operations can resume their
original pair after a profile edit or retirement. See the
[setup and migration guide](issue-stores.md).
The following modules support the legacy Git queue before verified bootstrap.
`shared-issue-paths.mjs` validates claim documents and their canonical paths.
`shared-issue-git.mjs` owns private-index commits, App pushes, and claim snapshots. `shared-issue-claims.mjs` stores version 2 claim files
on the queue branch. Its expected-tip updates preserve unrelated metadata and
exact-owner release. `shared-issue-app-push.mjs` enforces the configured dedicated
queue, metadata-only paths, regular files, and the expected parent.
`detach-issue-reports.mjs` verifies authoritative copies before untracking source
reports while preserving local files. `source-issue-separation.mjs`, invoked by
the staged formatter, prevents shared metadata from returning to source commits.
Direct checkpoints publish report updates and the exact owned claim's deletion
in one queue commit. Publication retains a commit-bound acknowledgment and still
confirms the resulting commit and its exact claim removal before clearing local claim metadata. Missing or
interrupted acknowledgments use the existing remote release and recovery path.
`shared-issue-queue.mjs` reconciles a released flow claim during explicit block
recovery and reacquires through the existing ownership and report guards.
`issue-folder-drag-ui.js` handles issue drag events in the Issues sidebar.
The sidebar uses the existing revision-checked `folder` action to save moves,
including assignments to configured project folders. `flow-browser-issue-folders.mjs`
checks folder visibility and drag moves through the real browser and HTTP routes.
`issue-folder-settings.mjs` owns stable folder identity, settings discovery,
revision-checked YAML edits, project-default migration, and parent inheritance.
`folder-settings-schema.mjs` derives supported fields and choices from the installed
`factory/system/folder.md` reference. Root `folder.md` supplies tracked project
defaults. `folder-settings-routes.mjs` binds settings operations to validated sidebar
locations. `folder-settings-ui.js` renders the shared settings form and repair UI.
Both Flow and Classic capture save the selected folder ID on each new report.
The issue read path projects older reports without membership into Inbox using
a stable ID. It does not create tracked files. Flow startup and explicit setup
initialize real folder settings; queue and model-selection snapshots only read
them, preserving source cleanliness and review fingerprints.
Folder landing pages share the workspace in `flow-ui.js`. `SidebarFiles`
validates deletion paths and directory identity. `flow-service.mjs` checks
folder membership before deletion. `folder-trash.mjs` uses macOS Trash and
prevents assignments or file writes into a directory while it is being moved.
`flow-folder-selection.mjs` evaluates folder selections and checks reviewed moves
against current issue records. `flow-grouping.mjs` owns master issue grouping.
`folder-strategies.mjs` owns strategy prompt reads, explicit copies to user Markdown,
and folder strategy selection. `folder-operations.mjs` runs scoped AI searches and
preview-bound per-issue Start and Archive actions, retaining individual outcomes.
`flow-overnight.mjs` runs the approved folder selection to the Merge confirmation
and retains the run report. After Request completes, its owning run can adopt
the clarified route while manual route changes remain blocked. `flow-block-data.mjs` resolves block addresses, declared inputs and
retained outputs. `flow-request.mjs` derives the Request fields through
`createTextDiscussionRuntime`, which uses an isolated temporary workspace,
disables shell tools, and supplies context and wording inline. Repository-aware
discussions retain their separate evidence-reading capability. Failed Request
attempts retain bounded stage, transport, and item-count diagnostics without
prompts or provider text. `flow-executor.mjs` runs model blocks in their own
Codex conversations and uses the protected operation adapters for delivery.
Command file artifacts select the latest evidence entry with the declared key.
Merge selects the final delivery log while preserving earlier failed verification
checkpoints in their original evidence order.
`flow-observer.mjs` reads local Git state and separately cached PR facts.
`flow-branches.mjs` lists local refs and snapshots the chosen commit for a new checkout.
`project-worktree-cleanup.mjs` owns the Admin and `$prune-worktrees` preview and
batch removal, including open issue checks and the reviewed branch revisions.
`project-remote-branch-cleanup.mjs` owns the Admin remote branch preview and
confirmation. It reads GitHub branch and pull request facts, checks ancestry
against the configured delivery revision, and submits an atomic GitHub ref
deletion conditioned on each reviewed tip. The GitHub read checks for open pull
requests and protection run before the mutation and are not part of its ref
transaction.
`project-local-branch-cleanup.mjs` owns the Admin preview and conditional local
ref deletion. It uses `project-branch-resources.mjs` to inspect Git worktrees and
Factory issue references in open and unarchived closed reports.
`project-archive-deletion.mjs` owns the Admin archive deletion preview and batch.
It binds deletion to the archived report contents and uses the same local branch
cleanup for explicitly selected branches associated with the deleted reports.
`flow-delivery.mjs` reads live destination branches, prepares the publication
preview, and validates or refreshes independent verification evidence.
`flow-reconciliation.mjs` checks disconnected blocks' original provider
conversations or retained input rejections before a manual update can release
their ownership. It starts no model turn and preserves the failed attempts.
`codex-input.mjs` rejects oversized text before provider dispatch.
`flow-update-branch.mjs` owns the local branch update used by the Branch button
and the Update Branch block, using the starting branch’s upstream. Conflict resolution makes up to three attempts in the owning conversation, retaining each failure for the next attempt. Unresolved merges feed the issue header’s Fix Branch state and its guarded update retry. An explicit
update aborts a pending merge before fetching and retains the other Git-operation
guards. `flow-merge-state.mjs` reads the pending local merge for the header
control, whose explicit abort action is guarded by the flow service.
`flow-merge.mjs` shares the Git fetch and merge helpers for Destination, budgets recovery per blocker, stops repeated failing source trees, waits for GitHub checks, and binds approval to the exact issue commit
and target revision. `flow-merge-github.mjs` bounds transient GitHub observation
and merge retries, reconciling uncertain writes before repeating them. Merge
checks GitHub first and retains matching verification across request failures.
`flow-human-input.mjs` describes required PR review and derives the outstanding
request from retained attempts, including legacy review blockers. Flow views and
sidebar rows expose it separately from execution status; the UI offers explicit
Continue through the existing guarded operation.
The original factory page remains at `/classic`. See the
[implementation plan](../plans/number-2/README.md) for current verification.

`factory-ui/block-catalog.mjs` resolves and renders block Markdown from the
bundled and project directories and fingerprints the effective definition. Each directory's `catalog.json` holds skill
defaults, ordering, and other settings. `flow-store.mjs` saves the label and
default skill when it creates a block. Project-defined blocks use the existing
Work operation.

The block document's `# Skill list` section defines suggested skills. Its
`# User extensions` section gives the project-relative path to the optional file under
`user/flow/extensions/blocks/`, which the catalog appends as display content.

`factory-ui/flow-definitions.mjs` loads Markdown flow definitions and project
defaults, computes the definition checksum, and writes exported definitions.
`factory-ui/flow-builder.mjs` runs one optional prompt or skill in a temporary
discussion to produce the block list. The controller applies the list or
links an export through the existing revision-checked flow store.

The shared Flow UI owns the card layout, inspector sections, and controls.
Selecting a block renders its saved details without an automatic mutation
request. Start and explicit definition updates retain their server-side freshness
and ownership checks. `flow-observer.mjs` retains PR observations under the local
store-runtime directory across navigation and restart. Explicit Refresh updates
only the current view; missing observations can fetch once. Authentication
sessions in `github-app.mjs` share token caching and in-flight authentication
across providers with the same project, repository, and credential identity.
`factory-ui/view-sources.mjs` exposes the catalog's source locations to
**Inspect UI**, **View index**, and `pnpm run factory ui find`. It also compiles
the editor's tab labels. See
[Edit the Factory UI from Markdown](../../README.md#edit-the-factory-ui-from-markdown).

`flow-ci-evidence.mjs` downloads failed GitHub verification artifacts through the
configured provider, validates the run's commit, and rewrites command-log paths
to retained local files. It falls back to failed job output when artifacts are
unavailable. `flow-repair-evidence.mjs` copies that evidence into the repair
worker's checkout and derives blocker identities from failed checks and logs.

`shared-chat-tools.mjs` supplies Classic and retained native conversations with the
project Discuss tool registry. `CodexConnection` starts an authenticated,
connection-owned `chat-tool-mcp.mjs` adapter before launching app-server. Its CLI
configuration overrides apply only to that process. They expose the guarded
registry when an existing thread resumes, preserving its identity and history
without changing global Codex configuration. Calls require an active native turn;
closing the connection closes the adapter. Output blocks retain their separate
dynamic tool registrations. Loading the application starts no conversation or turn.

## Native coding agents

`factory/system/folder.md` retains the legacy model choices and built-in defaults.
Once provider settings are initialized, `folder-settings-schema.mjs` and
`model-settings.mjs` expose enabled, advertised, currently usable models from the
native catalog. Saved unavailable selections retain their identity and reason.
`agent-models.mjs` preserves exact native provider/model identities and keeps
native session identities distinct from Codex threads.

`issue-chat-runtime.mjs` selects `NativeAgentConnection` for native models and
retained native sessions. `native-agent.mjs` adapts Claude Code streaming control
and Gemini CLI ACP into the chat and Flow event interface. `agent-process.mjs`
owns JSON-line framing, request correlation, and the child process group. Native
agents retain their own authentication, tools, and session history. The shared
`chat-tool-mcp.mjs` bridge exposes guarded Timey tools only during an active turn.
Selected skill content and applicable root project instructions reach each agent;
ordinary Flow approvals remain attached to the running block and attempt.

`agent-recovery.mjs` retains explicit recovery decisions after the original process
group ends. Recovery sends no prompt. Project discussion provider changes retain
the original conversation and supply a handoff with the history location. Existing
issue execution settings remain frozen after execution starts. Background helpers
and the explicitly named Sol reviewer retain their Codex execution path.

## AI provider settings

`provider-config.mjs` owns project-scoped choices and quota thresholds in
`user/ai-providers.json`. Initialization preserves referenced default, issue,
frozen execution and helper model choices. `provider-runtime.mjs` owns local
native observations, availability, monitoring and interruption watches; its
observations live under `.issues/factory-ui/` and contain no credentials.

`provider-setup.mjs` discovers native metadata without a model prompt and separates
missing executables, startup errors and sign-in. `provider-installation.mjs` owns
fixed vendor install/sign-in recipes and explicit native-terminal launches.
`native-agent-command.mjs` resolves the same PATH and user install locations for
inspection and execution. Install commands are displayed and copyable before an
explicit Install action; missing npm gets prerequisite instructions. `codex-account.mjs`
is a metadata-only transport shared by discovery and `codex-quota.mjs`; it cannot
start a turn or change sign-in. Claude quota events provide scoped observations,
but cannot establish a complete fresh account snapshot. Gemini ACP context usage
is not account allowance. Both remain unknown unless supported allowance data
exist; the explicit unmonitored-work option governs admission.

`provider-settings-ui.js` renders the provider controls and persistent warning
banner in Flow and Classic. `project-settings-ui.js` retains the shared Factory
settings Save and unsaved-change handling. The execution adapters check policy
before turns and interrupt affected work. Flow also checks each block, aborts
cancellable work, and lets protected Git/publication operations retain an outcome
before pausing the route. Quota recovery restores eligibility, never autoplay.
