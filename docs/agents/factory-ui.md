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
Final review offers explicit Review result, Close issue and Reopen issue buttons.
Close records the user’s acceptance after current evidence and human-input guards
pass; reopening preserves prior outcomes and returns to investigation. Human
answers and hardware checks continue to use the installed human-input protocol. The UI invokes that protocol's operation-specific structural
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
and operation locks invalidate readiness when changed. Time alone does not expire
a completed check. Dispatch independently rechecks the original chat and current
operation requirements; readiness never establishes that a whole stage passed.
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

## Updating a stale issue

When a focused review finds no new worker needed, Progress offers **Record finished
work and continue**. A separate read-only coordinator review inspects the actual
repair, current source, original and current checks, commit history and human
requirements. The server records the consecutive steps already satisfied in one
report update, stopping at missing work or final review. It can record existing
integration without performing another merge or changing an old investigation's
merge policy. Completed work is recorded as completed; only genuinely optional
work is skipped. Required custom stages remain in the configured path.

Existing verification must match the exact current tree and include full and
step checkpoints with passing raw audit results. Existing implementation commits
must be ancestors of the selected target. Structural human-input reads are fresh
for each operation and transition; the reviewer assesses their meaning. The UI
never infers human acceptance. A failed unchanged reconciliation stays disabled
with the specific reason instead of offering repeated identical reviews.

## Final review actions

**Review result** opens and scrolls to the latest recorded issue/worker result in
Recorded issue notes, retaining its original text. **Close issue** presents an
explicit acceptance confirmation and then closes only the selected final-review
issue. It rechecks the exact displayed queue, current source revision, recorded
evidence, outstanding workers and manual requirements. Missing/stale evidence or
required human checks leave the issue open. It never marks human checks passed.

**Reopen issue** accepts an optional reason and returns a final-review or closed
issue to the configured investigation stage. It preserves source, commits and
all report history, records a human reopening event, and starts no worker. Prior
completed stages remain in history but do not count as current outcomes after a
reopening. Duplicate/stale submissions cannot close or reopen a different state.

## Finding an existing worker chat

Continuing a worker conversation does not change its task identity. Before
searching, result review uses original-worker references retained by earlier UI
reviews. Each recovered reference must start with the exact original assignment
and belong to the same Git project. Search considers assignment headers, not
conversations that merely mention the action ID. It does not choose a review
chat as a worker or silently pick between multiple actual workers.

When the task/chat link is missing, **Find existing chat** restores a confirmed
connection. If several matches remain, the user can select one or paste its Codex
chat link. Connection rechecks the displayed queue and assignment before using
the existing ledger attach operation. It records neither work completion nor
issue advancement and starts no conversation. Progress then reviews the existing
result. Opening an issue remains read-only.

Earlier stages without a recorded outcome also use the compact expandable shape;
their neutral colour and help text retain the missing-history distinction. Current
assignments and old reviews are grouped under Task details and earlier reviews,
with a notice that old instructions may have been superseded. Final-only human
checks stay collapsed until needed. Plan references in saved reports/assignments
open a read-only document viewer restricted to project Markdown plans. The current
step keeps Progress visible when a new readiness check is needed, and preserves
successful checks while their inputs remain unchanged.

## Implementation checklist

Verify displays work items from the selected issue's linked implementation plan,
not another copy of the issue lifecycle. A plan may have any number of items;
version headings such as First version group a work increment. Numbered plan
headings retain their source lines and version groups. A read-only review
translates their requirements into plain-language names and acceptance criteria,
including required deliverables and constraints. Each criterion retains an exact
original requirement and inspected supporting file pointers.

**Check implementation steps** starts one bounded read-only Codex review of the
actual plan, existing work and saved raw results. It runs no assignments or tests,
launches no worker, merges nothing and does not advance or close the issue. Passed
means inspected evidence supports a criterion; failed means a check found an
actual problem. Missing or stale evidence is Not checked, and known unfinished
work is To do. Skipped requires a recorded applicable scope decision. The review
provides a concrete next action for incomplete checks. An unchanged completed
review is disabled; relevant changes allow another check, using the existing
review chat where available. Opening/refreshing an issue creates no review.

The issue report owns structured `plan_verification` findings and retains appended
review notes. UI runs retain the reviewed input fingerprint. Plan content, source,
report, lifecycle, related actions and supporting file content must still match
before a result is shown as current. A changed or missing input makes previous
results Not checked. Checklist findings are evidence, not lifecycle completion,
integration, or human acceptance. Existing Progress keeps its independent guards.

Blue checked circles mean Passed, red X circles Failed and empty green circles To
do. Grey question circles mean Not checked, grey minus circles Skipped and a green
ellipsis means Checking. Every state also has a visible text label. Expand an item
for acceptance criteria, result, exact requirement and supporting files. Those
files open as inert text after matching the reviewed hash; arbitrary paths cannot
be read through the viewer.

Ordinary criteria pass without per-item approval. Only existing human checks get
Approve result / Needs changes controls; evidence checks instead ask for the
person's actual observation. Closure-only judgment is requested at Final review,
after the non-human implementation criteria pass. A decision records the person's
actual result for the current revision without closing the issue. It cannot invent
new obligations, silently pass a human check, or stand in for explicit acceptance.
Final closure also rejects an existing stale or incomplete checklist.

## User overrides for implementation checks

Technical criteria describe work Codex can do; they are not instructions for the
user to reproduce internal test procedures. **Skip** on an unfinished ordinary
criterion and **Skip all remaining checks** let the user explicitly decide those
checks are no longer required. The confirmation shows the exact selection and a
short editable reason. Passed checks and separate human requirements are excluded.

The server checks the displayed report, current checklist and idle operation
locks before recording a skip. Each skipped criterion retains the previous
result, reason, human actor, time, plan hash and exact source context. A skip is
never counted as a pass. Mixed steps say Finished with skips. Overrides remove
those criteria's checklist completion requirement but do not run tests, advance
stages, change human checks, integrate or close the issue. Independent project
verification and final acceptance rules remain in force.

A subsequent evidence review retains matching user overrides for the same plan
and source context. Changed plan requirements or source require a new decision;
old overrides remain in the saved issue/review history. Bulk skipping does not
silently approve the final result or waive a human observation.

## Review file handling and recovery

Progress captures the project's agent guides and installed skill instructions
before reviewing work. Installed skill links may point to the shared skills
checkout: exact SKILL.md and reference Markdown files inside the resolved installed
skill directory are recognized without granting access to the whole checkout.
Each receipt records the project path, resolved target, hash and retained copy.
Escaping references are excluded, and changed instruction links/content invalidate
the input. Instruction copies are recorded separately from work and test evidence.
The same handling is used by implementation-checklist and reconciliation reviews.

A supporting-file failure keeps the complete structured review and all other
inspected file receipts. The issue screen names each unavailable file, explains
why it was cited, and distinguishes an internal recording restriction from a real
Codex permission request. A genuinely new external supporting file requires an
explicit exact-file decision for this review; it grants no folder-wide access.
Approval retains a verified copy and refreshes the same review chat. Actual Codex
permission requests show the requested paths and reason, with technical details
collapsed. Missing evidence never becomes a pass.

A historical blocked review without sufficient input receipts gets one fresh
read-only turn in its existing chat. New reviews retain the queue/source basis,
original worker turn, instruction receipts, completed response and checked evidence
hashes before recording. An unchanged recording failure can retry saving without
another model turn; changed inputs require a fresh turn in the same chat. Native
worker assignments, launches, integrations and human acceptance remain separate.
Events for a resumed chat belong to its current connected run, preserving old run
history. A file failure releases the operation lock and blocks only the affected
review's completion; retained findings remain visible.

Explicitly continuing a saved review also reopens that exact chat if Codex reports
it archived. The UI retries the read-only resume once using the installed
thread/unarchive operation; it creates no replacement chat and does not unarchive
unrelated workers or conversations.
