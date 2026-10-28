# Local factory UI

Run `pnpm run factory:ui -- --project /absolute/path/to/timey` from a checkout
containing this adapter. Open the printed loopback URL. The project must already
have its local issue queue and factory registry; the UI never initializes or
replaces either. The selected checkout owns the issue records and delivery configuration, so choose the
authoritative project rather than an old worker checkout. In live mode the
server serves `scripts/factory-ui/` from that project path when present, and
restart handoffs relaunch through the project's `scripts/factory-ui.mjs` entry.
Use `--port NUMBER` only when a fixed local port is needed.

The queue and issue screens read actual reports and the dispatch ledger through
the existing factory helper. Each queue refresh projects saved run history once
and reuses that projection for lifecycle availability; dispatch still reads current
history and applies its guards. No history projection is cached across requests. Refreshing and filtering are read-only. Lifecycle
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

## Lifecycle Progress

The lifecycle header has one **Progress** button. Pressing it opts into continued
work for this selected issue, bounded by its approved implementation plan. The
server reads saved answers first and records completed clarification when the
actual discussion supports it. Missing structured grilling metadata does not
cause a repeated interview. Plan approval remains separate: an original human
approval must cover the exact current plan, otherwise the plan is shown inline
with **Approve plan and continue** and **Request changes**.

After approval, Progress recommends and saves bounded work, starts or reconnects
to its existing worker, waits for results, reviews evidence, checks implementation
criteria, records verified commits and integrates when the approved plan and saved
automatic merge policy permit. The scope of each saved assignment is reviewed
against the plan before dispatch. It never includes another issue implicitly.
Technical failures get one bounded same-worker correction when the approved plan
and current permissions cover it. Missing evidence is never called a pass.

The header separates the workflow stage from live work and pending input. A
Prototype stage label does not establish that a prototype exists or is being built.
When a response is pending, the header shows whether work on this issue is still
connected and puts the requested decision under **Waiting for you**. Answer errors
appear separately from the activity summary. Saving plan, scope and question answers
checks connected work for this issue, including grouped assignments, before retaining
any answer or approval. Work on other issues does not block saving the response.
Background updates deferred during form editing or an open dialog remain pending
and render once that interaction ends, even if later polls return unchanged data.
Temporary chat keeps its existing DOM and draft while lifecycle questions update.
Read-only Clarify questions are bound to the selected report, lifecycle and linked
plan contents. An unrelated source commit does not discard those questions. Results
that advance a stage or reuse implementation approval retain their source guards.
Report and question freshness checks still apply; native worker requests keep their
existing reply path.

Actual human questions and permission requests appear in the issue. Answers are
retained with provenance, reviewed for coverage and routed to the original owner:
shared human-input requests use the installed guarded helper, human checks update
the existing check, and native CLI requests reply to their existing chat. Partial
answers leave the obligation open. **Human-first integration** shows the exact
diff and needs explicit candidate/target approval. Changed inputs invalidate that
approval. Final review keeps **Review result**, **Close issue** and **Reopen issue**;
Progress never accepts or closes an issue.

The header shows the current activity and a short history. Pause takes effect
after the current action. The durable controller record is
`.issues/factory-ui/lifecycle.json`, separate from child chat runs. Duplicate
Progress clicks do not duplicate work. Refreshes and server restarts never replay
work; explicit Resume inspects saved runs and reconnects known workers. Unknown
ownership or an unchanged action without progress stops with its retained result.
A changed plan pauses before the next action. Old manual action endpoints remain
available for queue-level operation and compatibility; their individual guards
and exact-candidate checks remain enforced.

An optional stage can be planned as a skip while it is the current stage. An issue
with `prototype_required: true` must complete Prototype and cannot plan a skip.
A saved `prototype_preview.url` supplies an **Open prototype** link in the activity
header; only HTTP(S) preview links are rendered.
Saving that route does not advance the issue or claim the stage was completed.
Progress records the saved reason as **Skipped**, checks the configured next stage
and human advance requirements, then continues. Existing unfinished work takes
precedence over a skip. An issue-focused implementation recommendation following
those skips stays deferred until the complete consecutive skip chain is recorded,
then is saved with the final stage's launch inputs. Before each skip, Progress
checks the retained review against current report, source, policy and dependency
inputs. Only its own validated transition updates that retained review; external
changes still require review. This preserves the approved task without changing
its scope or weakening launch freshness checks.
A stopped review rejected by the former current-stage skip restriction can reuse
its still-current result through Continue without repeating the investigation.

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

Only the issue's current stage has a **Progress** action. A separate readiness check is not required. Earlier and later steps
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
run after saving recommendations and route, either manually or within approved lifecycle Progress. A route-only review can be
saved without adding an assignment. Missing plans say Not decided; later saved
plans replace earlier future plans, without changing historical outcomes.

A saved route is not authority to skip required work. Reviewed advancement follows
every configured Next link and may record a saved planned skip only when policy
permits it: optional prototype, investigation for an enhancement, or commit when
commits are explicitly disabled. Every target gets its own fresh human advance
guard. Required verification, custom stages, acceptance and closure are not
bypassed. A planned integration skip is rejected if unintegrated code work exists
or is being recommended. Skipped events need reviewed reasons and actual evidence.

## Action checks

Lifecycle Progress checks current inputs, ownership, permissions and human
requirements as part of execution. There is no separate readiness step or
per-stage Progress confirmation. The old readiness endpoint is a read-only
inspection for compatibility; its timestamps do not enable or disable Progress.

## Finished review feedback

An issue-focused review's conclusion, next-step instruction and suggested
assignments appear above the current action controls. The proposed route remains
inspectable, with any validation problem explained. The issue must not suggest
that already completed required work was skipped. Existing old review output is
preserved; missing next-step fields use a conservative prompt to read the
conclusion and ask the coordinator to record needed decisions or issue updates; the read-only review chat retains supporting details.

Progress consumes a completed unchanged review instead of offering the identical
planning chat again. A valid unsaved proposal offers Save recommendations and
route with a concrete preview. Manual saving starts no worker. An active approved lifecycle run continues to
the applicable launch or integration action itself. A route-only save,
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
step keeps Progress available without a separate readiness check. Saved
implementation results remain visible as the issue advances.

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

Worker reviews retain the selected chat ID, completed turn and result from the
Codex API as a redacted project-local `worker-result.json`. Reviewers cite that
receipt for the worker result, and actual reports/logs for technical evidence.
It does not establish a test pass or human approval. The UI does not copy or
request access to the raw Codex session log. If a reviewer cites the selected
worker's session path returned by Codex, it gets one correction turn in the same
review chat using the retained result and existing project evidence. A repeated
bad citation stops with an explanation, not a misleading file-permission request.
No worker assignment is repeated, no missing evidence is silently discarded, and
unrelated external supporting files still need an exact-file decision.

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
another model turn; changed inputs require a fresh turn in the same chat. Worker assignments retain separate run records; required human decisions remain explicit.
Events for a resumed chat belong to its current connected run, preserving old run
history. A file failure releases the operation lock and blocks only the affected
review's completion; retained findings remain visible.

Explicitly continuing a saved review also reopens that exact chat if Codex reports
it archived. The UI retries the read-only resume once using the installed
thread/unarchive operation; it creates no replacement chat and does not unarchive
unrelated workers or conversations.

Implementation checklists belong to Verify. After advancing, expand Verify to inspect
the saved steps and results; later stages do not repeat the checklist or offer its
editing controls. Earlier results retain their recorded status with explicit labels.

Commit records the existing commit identified by the completed Verify stage and
moves along the configured Next link. It opens no chat and does not repeat behavior
checks. The current source must still match that verified revision and be clean;
unrelated changes are never staged automatically. Required commit/advance human
guards remain enforced. No new empty commit, integration or acceptance is implied.

Accept and close records the user’s explicit final judgment for pending closure-only
judgments linked to the checklist, then closes the issue. It does not invent
observations, override failed checks or waive technical work. Unchanged plan and
evidence at the completed Verify revision can be retained across later bookkeeping
changes. Confirmation failures appear inside the open dialog; successful decisions
refresh the issue screen immediately.
The live factory task log is administrative context. If completing a review changed
it, final acceptance retains its current contents and earlier hash separately;
unchanged source, plan, behavioral evidence and no outstanding work are still required.

Close issue records explicit acceptance and closes in one tap, without a
confirmation dialog. The button disables during the request and the screen refreshes
after success. Reopen keeps its confirmation and optional reason.

Older issues already at Final review can be accepted without backfilling stage
history when the registry records integration and both worker and checked
integration commits are in the current branch. Original verification dates and
limitations remain explicit. Close failures appear beside the Close issue button.

## Finish record-only work

A review can return a structured record_update when existing corrections only need
to be recorded in the selected local issue. Progress finishes that update itself;
it starts no additional worker or review chat. The server retains supporting record
copies and measures that source, the registry and unrelated issue reports remain
unchanged. It completes the record update and its preservation check, marks Commit
skipped because the issue is excluded from Git, and stops at Final review. Custom
stages, outstanding assignments and required human checks still apply.

This path does not prove a self-healing exercise or any other unperformed test.
Those limits remain in the result for final acceptance. It cannot change source,
registry entries, other reports or human check outcomes, and never closes the issue.

The queue hides the configured Closed stage by default. Show closed issues includes
those records, and choosing Closed in the stage filter enables that option.
Search, stage and visibility choices survive live refreshes while the page is open.
Filtering is read-only; issue links and saved reports remain available.

## Live worker status

The activity header shows the last live update and the time of the latest status
check. Status checks use the same Codex app-server connection that owns the turn.
A separate connection can return unloaded or stale saved history and is not a
reliable health check for another connection's active work. Quiet command output
alone does not establish that a worker stopped; non-content event timestamps also
count as activity without exposing private reasoning.

The server checks tracked turns every 30 seconds, without starting or resuming
work. An active owning connection wins over contradictory saved history. Only an
idle owner with a terminal result for the exact tracked turn, no pending input and
no newer activity can recover a missed completion notification. Normal result
validation and checks still follow; unknown status or query errors never infer
failure or trigger duplicate work. The header distinguishes result checking from
worker activity and preserves its last update while answer fields have focus.

## Live activity and reusable permissions

The issue’s activity header names the current configured step and uses Working
while an action is active. A scrolling Live output panel shows assistant updates,
command starts/output/completion, file changes and exit codes across that issue’s
chats. Stream deltas are combined by item ID; the final item replaces its streamed
text rather than duplicating it. The recent window is bounded per chat, and the
sanitized event log remains on disk. Known credential values and common credential
formats are redacted before new events are retained or displayed. Internal reasoning
notifications are not part of the activity stream.

Output follows the tail until the person scrolls up. Follow latest resumes that
behavior; Copy output copies the visible recent output. Live updates continue in
the console while an answer field has focus. Expansion keys include the issue,
run, request or plan criterion and persist in this browser’s local storage.
Refreshes preserve reading positions and answer drafts in memory; a different
question gets a separate draft. Opening another issue does not collapse the saved
view of this one.

Approval buttons are projected from the exact current Codex request. Command
availableDecisions is authoritative: offer session approval or a persistent
command/host rule only when advertised. Native permissions can grant the requested
access for a turn or session; file changes can grant session approval for the same
files. Persistent options show their exact proposed command pattern or host.
Buttons submit an option identity, and the server reconstructs the native reply
from the pending request. Browser-supplied permission objects cannot broaden it.
Workspace-write worker and integration chats enable the installed Codex native
`request_permissions` tool through per-thread configuration, including when
resuming an existing chat. Read-only reviewers retain their existing sandbox and
configuration. Worker instructions group known file/network needs for related
checks into one native request, then use ordinary commands within the granted
access instead of asking again for each temporary script name.

Workspace-write chats route execution permission requests through Codex's native
automatic approval reviewer (`approvalsReviewer: auto_review`). The workspace
sandbox and on-request approval policy remain enabled. The reviewer evaluates
the actual command and the chat's authorized assignment; a command is not trusted
merely because it runs pnpm, Python or Playwright. This covers eligible local
database/browser tests that need process or shared-memory access beyond native
file/network grants. Read-only chats explicitly retain human approval review.
No global settings, blanket shell rules or automatic acceptance are installed.
New and resumed worker chats use this setting; an already active turn must finish
or be explicitly interrupted before changing it. Never restart a running backend
or create a replacement worker to apply the setting.

Automatic approval review status and the public reason appear in live output.
Refusal, timeout or an aborted review means the action did not run; it is not
silently approved or retried with weaker restrictions. Approval is permission to
execute, not evidence that a test passed. Human scope decisions, integration
candidate approval and final acceptance remain separate UI actions.

**Allow for this chat** on a native permission request grants exactly the listed
access for related commands and later turns in that connected Codex session.
It does not grant access to another chat or change permanent settings. Reconnection
may require a fresh grant; the UI does not save and replay grants itself. Network
grants cover network access, not only a host mentioned in the reason. The UI shows
the command, working folder, reason, read/write paths and actual network scope.
If the native tool is unavailable or cannot cover the operation, command approval
still applies; the UI never invents unadvertised command choices or allows all
Python scripts by interpreter prefix.
Older Allow/Decline replies remain compatible with the advertised choices.

## Continuing an existing worker

A planning review can return a structured continuation with the existing action ID,
a bounded instruction and its reason, instead of recommending a duplicate worker.
Within active lifecycle Progress, the server selects that continuation ahead of
reviewing the old unfinished result. It requires the selected issue's blocked
assignment and the same disconnected worker, checks the approved plan and latest
actual answer receipts, and rechecks queue and worker freshness before resuming.
Later explicit answers can authorize bounded changes to an earlier constraint;
old blocker text does not override those answers. Human checks and tool permissions
still apply. An unauthorised continuation asks the precise missing decision.

The existing chat, original comparison base, merge policy and authorization history
are preserved. After the worker returns a new result, normal verification, review
and any required human-first integration follow. A continuation records no completed
step or acceptance by itself. A stale proposal is replanned, not replayed. Loop
fingerprints include the latest recorded human-answer receipt and the concrete
continuation so new answers can unblock work without blindly repeating the same
correction. Administrative notes do not reset the stopped-work guard. The new
continuation protocol allows older stopped records one fresh planning attempt
with this dispatcher capability; it grants no scope or completion by itself.
Queue reviews remain read-only; continuation execution belongs to the approved
issue lifecycle loop, separately from the native factory command loop.

## Questions, failures and forward progress

Focused planning distinguishes unfinished work, completed-work bookkeeping, an
actual human question and a stopped technical operation. No recommendations is
not evidence that implementation exists. An actual question states the question,
why the answer is needed and what to supply. Technical failures have no answer
field, and unchanged stopped actions cannot be retried by appending “continue” to
the report. Old generic retry records are displayed as stopped actions; one
explicit Continue can recover them without recording a fictional answer.

A failed completion review may trigger one bounded planning recovery to identify
the unfinished task or precise human decision. It does not repeat that review.
The repeat guard uses the current step, source, plan and actual assignment state;
administrative notes do not reset it. Real answers can authorize new planning.
Stale no-work evaluations and older failed bookkeeping reviews do not override a newer task recommendation. Continue saves the fresh task and route, then starts its worker within the approved plan; saving is not another human approval. A new actionable recommendation can resume stopped progress, while the same attempted action remains guarded against repetition. A fresh approved prerequisite
such as dependency investigation can run during Implement without moving the issue
back to Investigate. Worker reuse, fresh dispatch guards, exact integration approval
and explicit final acceptance remain enforced.

The issue and chat coordinators share [progress and completion records](factory-records.md),
including check receipts independent of UI chat history. Their control loops remain separate.

## Issue-scoped decision freshness

Issue-focused planning and asynchronous result recording compare selected inputs,
not a hash of the entire queue. `factory-inputs.mjs` follows transitive Blocked by
reports, assignment dependencies and shared assignments, retaining linked plan
contents, policy, source revision and working-tree inputs. Ordering, captures,
priority changes or completed actions outside that scope do not invalidate the
selected decision. Source changes conservatively require checking the current
checkout; they do not erase previously recorded completion or test evidence.

Issue-focused recommendations can be saved after unrelated queue edits. New saved
assignments carry their selected input receipt, checked again under the ledger
lock at reservation. Conflicting claims, changed scope/dependencies, source,
plans, policy or approval requirements still block the affected operation. Old
recommendations without an input receipt retain their conservative legacy check;
no old decision is silently grandfathered. Queue-wide evaluations still require
whole-queue freshness before saving grouping and priority decisions. Completed
work, test receipts and human acceptance remain separate and are never reset by
an unrelated issue capture.

Approval buttons acknowledge a click immediately: the clicked control is disabled
and shows Approving… while the request is sent. Approved. Continuing… appears only
after the server accepts the request, while the updated queue is loading. Stable
request/issue-answer keys preserve that feedback across redraws, preventing a
stale approval from being submitted twice. Failed requests show the error and
restore the control for retry. Negative replies and answers use Sending…/Sent…
instead of claiming approval. This feedback changes no permission or acceptance
rules.

## Slow chat startup

Chat creation has a soft 30-second deadline. After it expires, the run says that
Codex is taking longer and is waiting for the original request. The connection
retains that exact RPC instead of discarding its response or creating another
chat. A late response records the exact chat ID durably before the original
assignment continues. New contribution assembly runs on the server through the shared issue-delivery operations; it opens no integration chat. Candidate, scope and evidence freshness remain server guards.
Read-only assessments, evidence reviews, readiness and plan reviews use the same
startup handling, retaining their read-only sandbox.

Run records retain startup progress and identity. Repeated starts for one run
share its pending request. An uncertain disconnected startup blocks replacement
creation for the same operation; it never guesses identity from a nearby timestamp.
A saved ready, empty, idle chat can be reconnected by its exact ID; a chat with
existing work must have its result reconciled rather than receive another assignment.
A restart before the creation response is retained remains uncertain and requires
reconciliation. Keep the owning server running while startup is pending. This
recovery changes neither integration approval nor acceptance policy.

## Persistent issue conversation

The issue's **Chat** is its persistent interactive conversation. Joined output and
full-width input retain the inset up-arrow; Enter sends and Shift+Enter adds a line.
Opening or refreshing reads history without starting a model turn. Reloads,
navigation and server restarts preserve sent messages. Each issue has its own
conversation and native conversational thread. Earlier expired temporary chats
cannot be imported; their surviving explicitly recorded outputs remain in reports.
Legacy temporary endpoints remain available only for older clients.

Human messages are retained under `.issues/conversations/ISSUE_ID/messages.jsonl`;
`chat.json` keeps the conversational model's identity and response status. The
conversation also projects actual role results, stage outcomes and original human
answer receipts from their existing owners. It preserves source IDs and labels
worker results as claims rather than verification. Pagination bounds polling;
old history remains available through Earlier messages. Model turns receive a
bounded recent context and `context.json` with the complete selected-issue timeline
and current report, available to later roles and retrospective review. Comments
and provider responses are persistent local records and go to the configured model
provider under the account's policies. This is a deliberate retention change from
the former temporary chat; sent messages no longer expire or disappear on reload.

The composer distinguishes **Comment**, **Request revision**, and **Reply and
continue**. Comments save during implementation and become available on subsequent
role turns; they do not interrupt an already executing instruction. A revision
request marks the plan for reconsideration, revokes approval reuse and asks active
Progress to pause at its next checkpoint. Progress then reviews the saved feedback;
implementation approval must be supplied for the resulting plan. It does not erase
existing questions or invent new implementation authority.

Pending questions and exact plan/candidate controls appear within the same chat.
Reply and continue uses the current question identity and original answer handler.
Stale replies remain unsent; comments never masquerade as answers. Plan and
integration approvals retain their exact candidate/plan checks, and closure remains
an explicit final decision. Implementation stays in isolated worker checkouts;
independent review stays in separate read-only chats and checks raw proof. Those
roles receive the selected issue conversation as context, never expanded permission.

Message IDs make transport retries idempotent. Responses are serialized per issue,
while comments can continue arriving. A failed response retains the user message
and displays an error; an uncertain native startup is not silently replaced. A
known chat reconnects only after checking that its native state is idle. The chat
assistant has read-only context access and cannot grant permissions or dispatch
workflow actions. Execution details remain expandable under lifecycle progress.

## Temporary issue discussion

Each issue has a collapsed **Chat** toggle above its lifecycle. The borderless
toggle opens joined conversation output and full-width input; an inset circular
up-arrow sends. Enter sends; Shift+Enter adds a line. Opening starts no model turn.
Sending starts a dedicated ephemeral process in an empty workspace, separate from
coordinator/worker recovery and RunStore. Its context contains the selected report
and lifecycle policy, not other reports or saved chats. Proposed skips remain
revisable plans, never historical outcomes or permission.

Discussion stays in page/server memory. It is excluded from generic draft storage
and saved factory activity. Navigation, reload, End chat, 15-minute inactivity,
the one-hour lifetime and shutdown clear it and stop its process. Server expiry
bounds cleanup if a page-close request is lost. **Temporary chat** discloses these
limits and contains End chat and the optional grilling control. Messages still go
to the configured model provider under the account's policies; local ephemeral
handling does not establish zero provider retention. The dedicated runtime uses
the configured default OpenAI model/login. Custom providers/profiles fail closed.

Select conversation text to reveal **Record selected text…**. Review the exact
text, selected issue and stated effect, then click **Record this text on the issue**.
A short-lived one-use token binds that selection to its session and current
issue/policy/source. Recording rechecks ownership and human-input guards and uses
the existing locked report append. It labels output human-approved and possibly
model-written, never human testimony, completed grilling, workflow approval or
acceptance. No transcript, context bundle or session identity is saved. Work on
another issue does not block conversation or recording; an active operation on
the selected issue blocks recording only. Integration also blocks recording.
After recording changes context, start a new chat for further questions.

Every configured lifecycle stage offers **Discuss this step**. It opens the temporary
chat and starts the installed `grilling` skill through a native skill input. An exact hash-checked copy is registered in
the isolated runtime’s temporary skill directory and verified through `skills/list`;
it is removed with that runtime. No unrelated skills or tools are enabled. The
chat names the selected stage, including earlier or future stages, without moving
the issue. The skill asks numbered rounds of currently answerable design questions;
project facts come from supplied context and missing evidence remains explicit.
The temporary runtime retains its existing no-tools/read-only policy. Grilling
cannot launch workers or perform the technical work being discussed.

**Review grilling results…** drafts decisions, unresolved questions and selected
exact quotes from actual user messages. The preview names the issue and stage.
**Save to [step]** confirms and appends only that reviewed package to the selected
stage and report. The transcript, runtime identity and unselected user text are
not saved. Saved interviews appear under their selected stage, without inventing
missing stage history. Confirmation of discussion results is separate from
implementation-plan approval, test evidence and final acceptance.

**Save and continue** is offered only for the current unfinished stage when the
summary has no open questions. It saves first, then invokes the usual lifecycle
controller with fresh inputs. Clarify answers are reassessed against their actual
exit condition; no stage advances merely because an interview ran. Existing human
requests, exact-plan and integration approvals remain required. If continuation
fails, the saved results remain and the UI reports that continuation stopped.
Saving ends the temporary interview; start a new one to use the updated context.
Stage/issue/source changes, additional answers, expiry and duplicate confirmations
invalidate pending summary actions. Typed chat instructions never mutate work.

## Open a site for Verify

A Verify human check can declare `review_target: {url, revision}`, or use the
issue's `implementation_preview` with those fields. URLs must be HTTP(S), without
embedded credentials. **Open site** offers the hosting browser (including ChatGPT)
and, on macOS, the default browser and installed Chrome, Brave, Safari, Firefox or
Edge. Native choices launch a fixed application name with the validated URL;
arbitrary application names or commands are never accepted.

Approve result and Needs changes enable after the open request succeeds. Opening
records an attempt to open the exact candidate, not an observation or approval.
Needs changes requires comments; evidence checks require an actual observation.
The recorded decision belongs only to that human check and candidate revision.
It does not pass technical checks, advance stages, approve integration or close
an issue. A changed issue, candidate URL/revision or source requires reopening;
unrelated issue changes do not. Replay and owner mismatches are rejected.
Completed prototype checks stay completed against their saved prototype revision
when the issue reaches Verify; they are not re-requested against the project HEAD.

## Delivery finalization and runtime identity

`pnpm run factory -- runtime http://127.0.0.1:PORT` identifies the running UI's
source checkout, revision, branch, authoritative issue project and live/preview
mode. Continue using `factory issues` or the installed `issues` skill to list
issues; runtime identity is additional context, not another issue list.
Start disposable review servers with `--preview --authoritative-url URL`.
Their header links to the real issue, and site-review writes are rejected.
Live review receipts retain the issue project and mode alongside the candidate.

After independent verification of the remote PR merge, finalize eligible issues through the shared `scripts/factory-ui/delivery.mjs` owner. New finalization requires that verified PR receipt; worker or assembly completion is insufficient. For a separate delivery checkout, invoke
`pnpm run factory -- finalize-delivery /absolute/manifest.json` from the issue
project using the UI source's `scripts/factory.mjs` when that project lacks it.
This records existing integrated work; it performs no merge, deployment or acceptance.
If a `url` is supplied, the command checks the running server's identity first.

The manifest names a stable `operationId`, full `issueId`, `expectedState`,
`reportDigest` (SHA-256 of exact report bytes), canonical `checkout`, exact
`revision` and starting `base`, `verification` summary paths, reviewed
`requirements` (`description` and hashed `evidence`), and hashed `authorization`.
Each evidence entry is `{path, sha256}`. Full verification and step audit must
pass against that base and delivered tree; the delivery checkout must be clean.
Earlier human results need explicit `reviewApplicability` entries
(`checkId`, `revision`, `reason`) unless they match the delivered revision or
approved prototype. This records applicability without fabricating new testimony.

Finalization retains evidence and an operation receipt before atomically updating
the issue. Retry with the identical manifest after interruption. An already
recorded operation adds no duplicate history; changed inputs or issue bytes fail
closed. Verify and Commit are completed, integration is recorded, and the issue
stops at Final review. Custom stages keep their own exit review. Closure accepts the recorded artifact and retained evidence. It does not certify
later checkout changes or require the issue project to own that code. Changed
verification evidence and unfinished human obligations still block acceptance.

Queue polling omits command events and instructions and includes a bounded live
output tail only for the selected issue. Expanding transcript details fetches the
saved run on demand. Polls do not overlap; retained RunStore history is unchanged.

## Acceptance of recorded results

Close issue accepts the result recorded for that issue. It is independent of the
current project HEAD, branch and uncommitted source. The acceptance receipt names
the recorded revision and checkout when known, retains supporting bytes and
explicitly states that verification was not rerun. Legacy Final review reports
without structured delivery metadata remain usable; an unknown artifact revision
stays unknown rather than being replaced with the current HEAD.

The decision token covers the selected report and lifecycle configuration.
Another issue changing or another branch advancing does not invalidate it.
Changes to the selected report still require refreshing the decision. Same-issue
active work, unfinished implementation criteria, pending observations and failed
human checks remain blockers. Close supplies pending final judgment only through
the user's actual click, never missing physical observations.

For tracked source evidence, acceptance reads the exact blob from the recorded
commit when the working file differs. It never substitutes newer code for that
snapshot. Changed or missing immutable test logs still fail with the exact path.
Queue reports and the registry are mutable context; their current bytes and
original recorded digests are retained separately from technical evidence.
Verification and commit operations continue to require current source checks.

## Managed deployment

After committing and verifying a candidate, run:

```sh
pnpm run factory:deploy -- --checkout /absolute/verified/checkout --project /absolute/queue/project --url http://127.0.0.1:52995 --verification /absolute/verification-summary.json --base FULL_START_COMMIT
```

This switches the local listener to an already committed checkout; it performs no
Git merge, issue acceptance or workflow advancement. Record delivery through the
existing finalizer separately. The full verification summary must match the exact
candidate tree and base, with passing raw check evidence. Keep the prior source
checkout clean and unchanged so it can be restarted on failure.

The running server must support deployment preparation and report its PID. Older
servers need one manual restart onto this version. Preparation rejects connected
work and running lifecycle controllers, then blocks new mutations while draining.
Deployment waits for the old listener to release its port, starts the candidate,
and checks its runtime identity. Failure restores the previous unchanged checkout;
failed recovery retains the deployment lock for reconciliation. Logs and receipts
remain in the authoritative project's `.issues/evidence/`. Never clear an unknown
deployment lock or stop another listener to retry.

Candidate and recovery readiness each retain observations in the receipt's
`readiness` links to an adjacent `.readiness.json` file. Each attempt records HTTP
phase/path/status, transport error names/codes, elapsed time, and expected versus
observed runtime identity with mismatched fields. Response bodies, headers,
session cookies and arbitrary runtime fields are excluded. The file keeps twenty
recent attempts per wait, its first failure and its latest failure of each kind
(HTTP, transport, decode or identity), so failures survive a later successful poll.
The receipt and diagnostics are updated during polling, including unsuccessful
candidate and recovery waits. Identity requirements, request/polling timeouts and
recovery/locking rules are unchanged. A later passing run does not establish the
cause of a historical timeout without those observations.

When a saved assignment cannot launch because the target has uncommitted files,
the current issue shows Uncommitted changes, the affected paths and the local
commit/Continue next step. This live blocker takes priority over a finished review's
historical summary. Issue notes and grilling answers are already local records;
this message refers to project files and requires no GitHub push. The UI never
stages, commits or discards those files itself. After the changes are preserved,
normal source freshness and approval checks apply before the task starts.

### Queue lifecycle controls

The queue shows every configured lifecycle role in a fixed horizontal strip. The
strip scrolls on narrow screens and retains its scroll and keyboard focus across
live updates. Blue checks mean recorded completion; grey Xs mean recorded or
planned skips. Earlier stages without valid outcome records stay neutral. Orange
exclamations show blockers or errors. The current role shows play while idle and
a spinner during actual activity. Hover or focus any square for its explanation.

A yellow speech bubble above the current square marks a pending lifecycle question
or connected worker approval, including the final acceptance decision. The bubble and square are one keyboard control that
opens the existing issue question. Waiting for input shows idle play, while an
actual error keeps its orange square. Play uses the issue screen's existing
Progress flow, including its plan consent and human guards; it grants no extra
authority. Historical squares are informational. Every role block also links to
that issue with the selected step expanded, focused and scrolled into view. This
includes completed, skipped and future steps. Opening a step starts no work and
changes no route choices. The link preserves the selected step when opened in a
new tab or refreshed; live updates retain the user's expansion choices without
repeatedly moving focus.

Eligible future squares immediately toggle the saved route between take and skip.
The server follows configured Next links and the existing skip policy: enhancement
investigation, optional prototypes and commit recording when commits are disabled.
Required roles and acceptance cannot be skipped. Choices can change during active
Progress only while the selected role remains future and has no recorded outcome.
A reviewed route may repeat an earlier recorded skip without treating it as a
new skip request under current policy. This requires a valid skipped outcome
since the last reopening and configured Next links leading from that stage to
the current stage. It preserves the historical outcome and its original source;
current and future required stages remain protected.
A saving indicator prevents duplicate clicks; failures retain the saved value and
show an error. Stale issue, route or policy versions are rejected. Other route
choices and historical outcomes remain intact. Saving a choice starts no work and
does not complete a stage or authorize acceptance.

`pnpm run test:factory` includes disposable lifecycle fixtures for route persistence,
stale writes, protected roles, active-progress choices, disk-failure rollback and
HTTP authorization. Browser evidence separately checks rendering and interaction;
synthetic activity and provider failures establish no provider availability or
human acceptance.

## Header action control and version

The header counts running actions and open temporary chats. **No new actions** is
an on/off switch. Turning it on blocks new work and requests that coordinators
pause after their current action. Existing work can finish, permission replies
and saving/ending a temporary chat remain available. Turning it off restores
normal dispatch and resumes paused coordinators through their existing guards.
The switch does not restart the server or start a build. Unknown locks still
need their existing reconciliation workflow.

**Restart server** in the header uses the same restart path as deployment and
maintenance: it drains current work, permission replies, temporary chats and
coordinator locks before handing the installed listener to a replacement on the
same port. It installs no build. Saved chats, pending questions and progress
remain in the project, and the browser reconnects without erasing drafts. The
button is hidden on preview copies and while a restart is already in progress.

The header displays the last four characters of the server's reported startup
commit, with the full hash and source path in its tooltip. Unknown revisions
are shown as unknown, and source changes retain their warning. This is not an
independent attestation of the browser’s loaded code or dirty source contents.

Queue roles use 24-pixel squares. Future roles remain outlined squares on dotted
connectors. Skipped roles use slightly smaller, lowered squares, with the dotted
connector above them. Every square still links to its expanded issue step.

## Closing without completing the work

Every open issue has **Close with reason…** above its chat. Choose a reason and
optionally add details or the duplicate issue ID. The project’s editable
`.issues/triage-labels.md` defines the reasons in a Closed reasons table with
ID, Label and Meaning columns. Older projects use the standard reasons until
they add that section. The stable `fixed` ID always means verified, accepted
work and retains final-review checks. All other reasons close work that is not
currently running, without claiming implementation, passing checks, acceptance,
or review of a finished worker result. Work that is still starting or running
must finish first. Accepting the issue as Fixed still requires that outstanding
result to be reviewed. The report records the reason, label, time and optional
details, and the page shows them after closure. Reopening preserves the decision
in history.
Changed reports or reason lists invalidate an open decision; duplicate submissions
cannot close twice. This explicit user disposition is separate from automatic
Progress, which still cannot close issues.

## Issue priorities

The queue and issue page show the saved priority and up/down buttons. Each click
moves one level through the project’s Issue Priorities table in
`.issues/triage-labels.md`, ordered highest first. Missing priorities display as
Major without rewriting old reports. The defaults are Showstopper (orange),
Critical (red), Major (yellow), Minor (green), and Suggestion (pink). The divider
above each queue row uses that row’s priority color, so the line between two
issues describes the following issue. Labels and hover descriptions supplement
color. Filtering retains the same rule for the visible issues.

Arrows disable at either end and while saving. Writes serialize with other queue
writes, preserve current report content, record the priority change and timestamp,
and reject stale priority/configuration choices. They change no stage, test result
or acceptance and start no work. Existing queue ordering is retained.

## Issue PR delivery

Follow [issue delivery](issue-delivery.md) for contribution assembly, complete-issue
review, publication, recovery and server-enforced merge gates. New delivery uses
one PR per complete issue. Historical records retain their original meaning.

## Create an issue from the list

**Create issue** accepts one required description. Save asks the configured model
to derive titles, separate independent outcomes and assess initial routing.
Numbered steps for one problem stay together. Reports preserve the exact original
description and relevant excerpt, use ask autonomy and record each initial skipped
stage with its own reason and original-report source. Required custom stages stay
in the route. Capture starts no investigation, worker or lifecycle Progress.

Save stays on the list with its filters and reading position. A persistent toast
links to every captured issue, including issues hidden by current filters. Opening
a link starts no work. Cancel before submission writes no report. While saving,
the controls disable; closing a request cannot undo a publication. Errors retain
the description and retry identity, including across reloads in this browser tab.
Retry the same draft to recover a lost response or partial publication. A changed
description with that identity is rejected; Cancel starts a fresh draft. Success
links survive a failed list refresh.

Capture uses the existing local HTTP, preview, server ownership, pause and draining
guards. Provider assessment holds no queue lock. Publication uses the common
queue lock, exclusive report creation and a durable receipt under
`.issues/factory-ui/captures/`. Same-identity retries return the original IDs; new
explicit submissions may contain identical wording. Existing reports and the
factory ledger remain untouched. Uncertain locks or changed partial reports need
reconciliation. Provider/profile restrictions fail closed, with no model fallback.
Descriptions go to the configured provider under its account policies; local
ephemeral runtime cleanup establishes no provider-retention guarantee.
