# Local factory UI

Run `npm run factory:ui -- --project /absolute/path/to/timey` from a checkout
containing this adapter. Open the printed loopback URL. The project must already
have its local issue queue and factory registry; the UI never initializes or
replaces either. The selected checkout is the integration target, so choose the
authoritative project rather than an old worker checkout. Use `--port NUMBER`
only when a fixed local port is needed.

The queue and issue screens read actual reports and the dispatch ledger through
the existing factory helper. Refreshing and filtering are read-only. Lifecycle
stages come from the configured role mapping. Human input remains separate from
stage, worker completion and code integration. Links use the report's Parent,
Blocked by and Related sections; reverse links are computed from those explicit
references. Reports are displayed as escaped text, never executable HTML.

The issue screen shows every configured lifecycle stage as a numbered expandable
step. The current stage opens by default. Saved assignments and worker results
appear under their matching stage; worker commits and manual integration have
separate steps. Opening a step does not advance the issue. Stage expansion is
preserved while live results refresh. Earlier stages are not marked complete
merely because the issue currently sits later in the lifecycle. Saved timestamps
and report notes provide history where it exists; missing historical transitions
are not reconstructed. Unmatched assignment kinds stay visible under Other work.
New lifecycle stages use the same step layout without requiring another screen.

## Separate manual actions

1. **Review queue with Codex** starts one read-only coordinator chat. It proposes
   work but does not change recommendations or launch workers.
2. **Save these recommendations** saves the reviewed assignments using the existing
   ledger helper. A changed queue or source revision requires another review.
3. **Start worker** shows the saved scope, checks, integration policy, current
   revision and human obligations. Confirmation reserves exactly that assignment,
   creates an isolated Git checkout at its saved base, and starts one CLI chat.
4. **Review integration** appears for completed code actions. Its separate
   confirmation starts a coordinator chat for that exact candidate. Human-first
   actions require explicit approval. The server independently reruns combined
   verification and the strict saved-base audit before recording integration.

Even the saved `automatic` merge policy requires the explicit integration action
in this UI. No worker completion, saved answer or refresh starts a follow-up action.
Nothing in this interface accepts or closes issues. Handle human answers,
hardware checks and acceptance in the coordinator chat using the installed
human-input protocol. The UI invokes that protocol's operation-specific structural
guards before dispatch and integration; those checks do not replace semantic
review of the answers and candidate scope.

## CLI connection and recovery

The adapter uses the installed `codex app-server --listen stdio://`, its existing
login and configured model. It does not change authentication or model settings.
The protocol boundary was checked against CLI 0.164.0 and its generated JSON
schemas. The app-server interface is marked experimental by that CLI; retest this
adapter after upgrades. See the [official app-server protocol](https://learn.chatgpt.com/docs/app-server).
CLI-created chats have durable IDs; their appearance in the desktop sidebar is
not established by this adapter. Chat-tool launches continue to use the existing
native transport. The UI does not resume unknown native chats. Progress can discover and review an existing worker result using its exact saved action identity, as described below.

Permission requests from a connected chat are shown for an explicit allow or
decline decision, scoped to the pending request. Unsupported requests fail closed.
A missing CLI, failed setup or disconnected conversation retains its saved claim,
checkout and ID. Do not retry creation blindly. Known interrupted chats can be
continued explicitly within the original assignment; no resumption occurs on
page load. A server restart displays saved runs as disconnected. The UI refuses
uncertain setup and leaves it for coordinator reconciliation.

Local history and transcripts live under ignored `.issues/factory-ui/`. A server
ownership lock prevents concurrent UI writers. A previous ownership lock must be
reconciled after an abnormal exit: inspect its PID and saved runs before removing
only a confirmed dead server lock. Never remove an integration lock as routine
cleanup. Failed integrations retain that lock and the actual checkout state;
continue the owning run only after reviewing it, or reconcile in the coordinator
chat. No reset, stash, forced merge or automatic lock recovery is performed.

The HTTP service binds to 127.0.0.1, validates Host and Origin, requires its local
session cookie and explicit JSON action headers, and exposes a fixed set of
operations. It has no arbitrary command endpoint or cross-origin API. Keep it
local. Closing the server disconnects CLI work; inspect retained history before
continuing.

## Progress on the current stage

Only the issue's current stage has action buttons: **Check readiness**, then **Progress** when ready. Earlier and later steps
show history without dispatch controls. The panel names the recommended action;
its confirmation shows the scope before doing one action. It can start an existing
saved recommendation, review an existing worker's result in a separate coordinator
chat, select a completed code candidate for the separate integration action, or
start an issue-focused read-only recommendation chat. Recommendations still need
a separate save and worker launch. There is no automatic next iteration.

The server derives the action from the current report, lifecycle and ledger. It
rejects an unexpected stage, changed queue/source/action, reused confirmation or
concurrent review. Active work stays visible in the current stage. Progress
checks an unfinished worker without starting a replacement. Ambiguous or missing
original chat references stop with a reconciliation explanation.

For result review, the installed CLI reads the original chat by its saved ready
ID, or discovers one exact original action UUID in the initial chat preview. The
worker checkout must share the project's Git repository. The newest completed
turn is read and checked again after review. The coordinator gets a read-only chat
and reviews actual reports and raw logs; it cannot perform the original assignment
or edit the authoritative queue. The server validates evidence files and freshness,
rechecks operation-specific human-input guards, attaches the discovered original
worker reference if needed, and records only the warranted completion/reconciliation.
Code results additionally need the existing independent saved-base checks.

Reviewed notes append to the selected report, preserving existing prose and human
obligations. A proposed stage advance must follow the configured Next state, have
its exit condition reviewed, pass a fresh target-specific human-input guard, and
leave a clean source checkout. Progress cannot accept or close an issue. Failed or
uncertain reviews retain their history and explain what needs coordinator attention.
The `.issues/factory-progress.lock` serializes these reviews and excludes target
integration while records are being reviewed. A dead/uncertain lock requires
inspection rather than automatic deletion.

Review cards distinguish the server's recorded outcome from a model's completion
claim. Remaining work stays visible; transcripts and structured data are collapsed
under technical details. Evidence may include actual project or worker source and
temporary artifacts, with canonical directory, regular-file, size and hash checks.
After a blocked review, Progress explicitly offers a fresh read-only review of the
original worker, never an automatic retry or repeated worker assignment. A recorded
assignment can leave the issue at its current stage; the next Progress action can
recommend the remaining work. Chat links use `codex://threads/<id>`, the local
desktop app's copied chat-link format; opening depends on that app being installed.

## Recorded stage states and planned routes

Blue means a recorded stage completion, grey means a recorded skip or planned
future skip, green means ready or working, red means blocked, and white means
future or not checked. Labels distinguish every state without relying on colour.
The current step is larger and opens by default. Completed and skipped steps are
small centred nodes; tapping one expands the complete view. Short centre lines
connect the steps. Every step has a keyboard/touch accessible information panel,
with a hover explanation, the actual reason and what must happen next. Opening
steps or explanations performs no action. Empty historical sections are omitted.

Past outcomes use explicit `lifecycle_history` report metadata, with state,
outcome (`completed` or `skipped`), next state, time, reason, revision, chat and
evidence. Guarded UI advancement appends these records while preserving report
content and human input. Old assignments and worker completion do not invent
stage completion. Manual integration retains its independent verified ledger
record as the outcome for that separate step. A reopened current stage takes
precedence over an older completion record.

Queue/issue reviews propose `routes`: issue ID and current/future steps with exact
state, `take`/`skip`/`undecided` and a reason. `@integration` names the separate
manual integration step. Routes are only persisted as `savedRoutes` in the review
run after explicit Save recommendations and route. A route-only review can be
saved without adding an assignment. Missing plans say Not decided; later saved
plans replace earlier future plans, without changing historical outcomes.

A saved route is not authority to skip required work. Reviewed advancement follows
every configured Next link and may record a saved planned skip only when policy
permits it: optional prototype, investigation for an enhancement, or commit when
commits are explicitly disabled. Every target gets its own fresh human advance
guard. Required verification, custom stages, acceptance and closure are not
bypassed. A planned integration skip is rejected if unintegrated code work exists
or is being recommended. Skipped events need reviewed reasons and actual evidence.

## Explicit readiness checks

An unchecked current step offers Check readiness with an explanation. The check
reads the queue, operation-specific guards and original worker status where
needed. Ambiguous worker identity stops before any chat creation or ledger edit.
Required semantic review can open a separate read-only chat, with pending
permission requests visible. The result concerns the next selected action, not
completion of the whole stage. Final-only human checks do not block earlier work.

Checks create durable UI readiness records; they reserve no assignments, record no
worker completion, advance no report and start no worker or integration. A ready
result enables Progress; required human-first integration approval remains a
blocked requirement with an explicit Review required approval action. Existing
manual confirmation, freshness and execution checks still run before dispatch.

Source, reports/configuration, saved actions, relevant UI worker/review statuses
and operation locks invalidate readiness when changed. Checks also expire after
one minute because external native chat changes are not continuously polled.
Disconnected records do not establish live activity. A stopped native worker is
blocked; a confirmed active worker is green Working and can be checked again.

## Finished review feedback

An issue-focused review's conclusion, next-step instruction and suggested
assignments appear above the current action controls. The proposed route remains
inspectable, with any validation problem explained. The issue must not suggest
that already completed required work was skipped. Existing old review output is
preserved; missing next-step fields use a conservative prompt to read the
conclusion and ask the coordinator to record needed decisions or issue updates; the read-only review chat retains supporting details.

Progress consumes a completed unchanged review instead of offering the identical
planning chat again. A valid unsaved proposal offers Save recommendations and
route with a concrete preview. Saving starts no worker; after saving, applicable
saved work offers the separate launch or integration action. A route-only save,
no-action conclusion or invalid proposal disables Progress with a reason. Invalid
routes require correction or evidence-backed issue bookkeeping by the coordinator, not silent acceptance or a duplicate worker. Full-queue save freshness and
one-use confirmation checks still apply.

New focused reviews retain a scoped input fingerprint (source, selected report,
lifecycle, preferences and declared dependencies/actions). Relevant changes allow
a fresh review. An unrelated report or another readiness check does not reset a
completed review. Older records fall back to their existing whole-queue basis.
Saving updates the fingerprint for its own newly saved actions only, so a valid
save is shown as saved rather than stale. Planning completion also invalidates
readiness. Review result display never changes the authoritative issue, registry,
route or human acceptance on page load.
