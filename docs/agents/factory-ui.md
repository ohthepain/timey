# Local factory UI

Run `pnpm run factory:ui -- --project /absolute/path/to/timey` from a checkout
containing this adapter. Open the printed loopback URL. The project must already
have its local issue queue and factory registry; the UI never initializes or
replaces either. The selected checkout owns the issue records and delivery configuration, so choose the
authoritative project rather than an old worker checkout. In live mode the
server uses browser assets and the restart entry from the installed adapter
checkout. Updating code uses managed deployment with exact passing verification,
HTML and authenticated queue probes; restart refuses changed installed source.
Use `--port NUMBER` only when a fixed local port is needed.

The queue and issue screens read actual reports and the dispatch ledger through
the existing factory helper. Each queue refresh projects saved run history once
and reuses that projection for lifecycle availability; dispatch still reads current
history and applies its guards. No history projection is cached across requests. Refreshing and filtering are read-only. Lifecycle
stages come from the configured role mapping. Human input remains separate from
stage, worker completion and code integration. Links use the report's Parent,
Blocked by and Related sections; reverse links are computed from those explicit
references. Reports are displayed as escaped text, never executable HTML.

Under the issue number, the issue screen shows the working checkout's current
branch and short HEAD commit, with the full hash available on hover. It uses
unfinished worker work first, then the assembled issue branch, then the last
worker checkout. Detached or unavailable checkouts and issues without assigned
work are labeled explicitly. Only the selected issue's Git identity is read
on refresh; the running server's branch is never substituted.

The issue screen shows every configured lifecycle stage as a numbered expandable
step. The current stage opens by default. Saved assignments and worker results
appear under their matching stage; worker commits and manual integration have
separate steps. Opening a step does not advance the issue. Stage expansion is
preserved while live results refresh. Earlier stages are not marked complete
merely because the issue currently sits later in the lifecycle. Saved timestamps
and report notes provide history where it exists; missing historical transitions
are not reconstructed. Unmatched assignment kinds stay visible under Other work.
New lifecycle stages use the same step layout without requiring another screen.

## Queue sorting

The queue defaults to latest progress first. The sort selector also offers lifecycle
progress, creation time, completion time and required human input. Direction is a
toggle: a downward triangle means descending and an upward triangle means ascending.
New modes start highest/newest/required first. Missing dates stay last
in both directions, with ascending issue ID breaking ties. Filters and sorting
remain selected during live refreshes.

Progress ranks the furthest configured stage actually started, following Next
links; planned and skipped stages alone do not count as starts. Last progress
includes saved stage events, worker activity and results within a stage. Polling
creates no activity timestamp. Completion uses recorded entry into Final review,
excluding closure without a fix. Missing historical dates remain unknown. Human
input includes actionable requests, connected approvals and final acceptance;
deferred requests and future prerequisites do not count. Sorting is presentation
only and does not change readiness or grant authority.

Human-input sorting uses the shared reader's current availability and deferral
overlays, including revision-bound readiness prerequisites. Deferred or upcoming
requests do not count as actionable input; their requirements still block affected
work. Connected worker approvals and current lifecycle questions remain visible.
Final acceptance is projected from recorded finished work, not a stage name alone.

## Model and effort preferences

The issue queue's gear opens project-local defaults for model and reasoning
effort. Defaults start at GPT-6 Luna and medium. The model selector offers Luna,
GPT-6.1 Sol, GPT-6.1 Terra and GPT-6 Astra with brief practical descriptions;
effort choices are low, medium, high and max. The issue page has separate model
and effort selectors. An unset issue choice follows the current default, while an
explicit choice remains fixed if defaults change. Preferences are stored in the
ignored `.issues/model-settings.json` file so changing them does not dirty source
or interfere with worker dispatch.

These preferences are read when a new Codex thread starts. Resuming an existing
thread keeps its original model and effort. `model-settings.mjs` validates and
stores preferences; `codex.mjs` passes the effective model and reasoning effort
to `thread/start`. New threads retain the existing sandbox and approval policy.

Descriptions follow the current [OpenAI model-selection guidance](https://developers.openai.com/api/docs/guides/model-selection).

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

During an approved worker run, a transport failure automatically checks the exact
original turn before starting any further work. A running original turn is
observed for up to 15 minutes; recovery never launches replacement implementation.
Malformed final results receive one report-only correction in the same chat with
read-only permissions. The original response and recovery failure are retained.
An uncertain running correction cannot be treated as finished.

If report correction finishes but still fails validation, an existing draft-handoff
route may retain a clean committed contribution with implementation completeness
explicitly unverified. Normal candidate checks run and their failures remain
disclosed. Existing publication authorization is still required; verified-delivery
routes, merge approval and acceptance are never weakened by result recovery.

Source-only changes during planning receive one focused impact revalidation of
the existing proposal. Changes to selected reports, assignments or captured policy
inputs require ordinary planning recovery. A second concurrent change invalidates
the revalidation. Execution and candidate checks still use current source.
Continuation output is restricted to actual eligible blocked worker action IDs;
an empty eligible set requires a new assignment rather than a fabricated resume.

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
page load. A server restart displays saved runs as disconnected. On Continue,
an unattached read-only evaluation or coordinator review is retired as interrupted,
with its findings retained, and current inputs are reviewed once through bounded
recovery. It cannot remain falsely running and recreate the same retry prompt.
Worker and integration recovery still reconnect their existing assignments.
The UI refuses
uncertain setup and leaves it for coordinator reconciliation.

Continue immediately replaces the previous stop/status explanation with a sending
status and prevents
duplicate clicks while acknowledgment is pending. Server acceptance is shown
separately from work starting; request failures remain visible with guidance to
refresh before retrying. Acknowledgment is retired when fresh lifecycle progress
arrives. Current status distinguishes coordinator queueing from waiting for the
active review result instead of retaining a stale conversation-preparation label.
Saved chat history is preserved. This feedback does not change execution or approval gates.

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

An experimental `/native-chat?issue=FULL_ID` page proves the replacement native
handoff on disposable issues. It reserves one discussion request without a model
call; the user opens a prepared Codex composer and presses Send there to register
the home chat through a local command. Later visits link to that exact chat.
It is not a cutover of existing Progress or conversation controls and must not be
used for active issues. See [proof status and limits](../plans/codex-native-handoff-proof.md).

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
saved without adding an assignment. Missing decisions for integration, Final review and Closed use the project
default skip. Other missing plans say Not decided. Later partial plans preserve
earlier explicit decisions and historical outcomes.

A saved route is not authority to skip required work. Reviewed advancement follows
every configured Next link and may record a saved planned skip only when policy
permits it: optional prototype, investigation for an enhancement, or commit when
commits are explicitly disabled. Every target gets its own fresh human advance
guard. Required verification, custom stages, acceptance and closure are not
bypassed. Integration, final review and closure may be planned as skipped for
the draft PR handoff; these choices stop factory work rather than recording
integration, acceptance or closure. Skipped events need reviewed reasons and
actual evidence.

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
open a read-only document viewer restricted to project Markdown plans. Each issue
page also offers **Open saved report**, which reads its current complete Markdown
(including frontmatter) from the authoritative queue and shows its project-relative
path in the same accessible dialog. Report content is displayed as text. The
authenticated report resource accepts only an issue ID, rejects symlinks and
non-regular files, and reports missing or invalid reports without changing files,
assignments or lifecycle state. The plans-only resource remains separate. A filename
shown in issue notes, verification messages, recorded evidence, checklist text, or
command output is a button that opens that file in the same dialog. That shown-file
read accepts one regular text file inside the project, including an absolute path
that resolves there. It rejects folders, symlinks, paths outside the project, binary
files, and files of 2 MB or larger, and it does not change the queue. The current
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
files open as inert text after matching the reviewed hash. The checklist resource
still refuses a path that was not part of that review.

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

The queue lists each lifecycle role with a checkbox and the number of issues in that
role that match the current search. Every role starts selected except Closed. Clearing
a role hides its issues; selecting Closed shows closed issues. Search text applies when
Return is pressed, and also as the text changes. Search, role, and sort choices survive
live refreshes while the page is open.
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

## Refreshing stale recommendations

Continue recovers a stale, unlaunched same-issue recommendation under the current
approved plan. It retires the unused proposal with its original scope, base and
authorization history retained, then replans only unfinished work from current
inputs. It never updates the old fingerprint to make a stale assignment launchable.
The replacement passes the normal scope review, human-input and launch guards;
a changed plan or expanded scope still requires the actual human decision.

Final review still shows Continue when this recovery, or another resumable task, is
the next action. Acceptance controls appear once no automatic task remains.
Continue does not accept or close the issue.

Reads only offer recovery. The explicit Continue action performs retirement under
the ledger lock, checking the exact expected proposal and that it is still stale,
unclaimed and unbound. Grouped proposals, existing chats/reservations, dirty source,
missing approval and invalid assembly handoffs retain their concrete blockers.
Completed, reconciled and assembled work is preserved. Relevant recovery attempts
are bounded by the normal lifecycle fingerprint; notes do not reset it.

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
stale approval from being submitted twice. Failed requests show an alert beside
each copy of that exact request's control and restore it for explicit retry.
The alert survives redraws and clears on retry or a replacement request. An
expired page session explains that a reload is needed; no write is automatically
replayed after reconnecting. Negative replies and answers use Sending…/Sent…
instead of claiming approval. This feedback changes no permission or acceptance
rules.

Publication preflight checks each contributing action's real identity and scope
against the exact assembled candidate and target, just as merge preflight does.
The issue ID is not an action ID. Publication still requires its separate explicit
approval and never supplies merge or final acceptance approval.

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

**Stop** cancels only the issue assistant's current response for the selected issue.
It preserves saved messages, earlier output and received partial text, and leaves
queued comments available for their normal responses. It never stops lifecycle
Progress or workers, answers questions or grants approval. A stale Stop cannot
cancel a newer response; a response that finishes first is retained normally.
Connection or cancellation failures remain visible so you can refresh and retry.

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

## Verification recovery

Implementation completion is separate from wider verification. A worker that has
finished its requested code and focused checks returns `implementation_complete`.
If independent checks fail, retain the implementation/result/chat, record Implement
as completed and move to the configured Verify stage. This records no passed check,
commit-stage completion, integration, acceptance or closure. Custom stages are
preserved; there is no direct jump over a configured intermediate stage.

Verify explains the failed check, uncertainty, current branch and checkout.
**Retry verification** reruns checks on the existing code, including unchanged code.
**Update from branch and retry** merges all changes from an explicitly selected
local or last-fetched remote branch into the isolated worker checkout, then checks
the combined result against the original starting revision. Full verification
includes fresh registered browser interactions on that combined source before
independent completion review; old pre-merge browser logs do not satisfy the new
required browser check. See [browser verification](verification.md#browser-behavior-on-the-combined-candidate). The selector sits directly
above this action and defaults to the source branch recorded when the worker was
created. Older workers without a recorded source default to the project’s current
branch; detached or unavailable branches leave an explicit choice. An explicit
selection survives polling during the current page session. Selecting a branch
approves that update only; exact-candidate PR/human approval stays separate. Changed
branch tips, changed issue records, active work and unrelated dirty/conflicted
checkouts reject stale actions with a concrete explanation. For conflicts from
this run’s recorded branch update, the action makes one bounded Codex resolution
attempt in the existing issue chat. It preserves the original implementation
turn, checks the exact merge identity and limits edits to conflicted files (plus
the lockfile for package conflicts). The server commits the staged resolution
through its configured audit hook, then independently checks the combined result.
A retry can resume that same pending merge; it cannot adopt another merge.
Unresolved decisions, unavailable chats, failed hooks or verification stay visible
and require another explicit action; there is no automatic retry loop. Publication,
project-branch integration and acceptance remain separate. No other issue or
formal repair ticket is required, and implementation is not repeated. Failed retries remain in Verify, with another explicit retry available;
automatic progress pauses instead of repeating checks or assigning outside repairs.
A successful retry resumes approved progress while retaining pending human input.

Each verification command prints its exact summary path. Candidate checking uses
only those command-owned verification and step summaries, retaining strict
base/tree/raw-log validation. Concurrent commit-hook or other-issue evidence is
not evidence for that command and cannot make it fail or pass.

## Interrupted integration bookkeeping

The issue coordinator checks a saved integration reservation before asking for new
work. If the candidate is already in the project, it reads only the reports named
by that integration's own verification and step commands. Matching current-tree,
original-base and raw-check evidence permits finishing the ledger and stage update
without a chat, worker restart or another merge. The existing lock, candidate,
authorization and operation-specific human guards remain required. A partial
registry update resumes only the unfinished bookkeeping. Polling and queue reads
remain inert; recovery runs as part of approved Progress.

Older commands without summary markers use their recorded Fallow log paths to
identify their own reports. Other commands' reports are never selected by scanning
the shared evidence folder. Changed source, missing evidence, another live owner,
a changed candidate or missing approval leaves the original work and reservation
intact, with a concrete explanation and **Retry finishing integration**. That
explicit retry can run verification on the existing merged code if fresh evidence
is needed. It never merges, starts an implementation or grants human approval.
Repeated automatic attempts against unchanged inputs are suppressed. Maintenance
pauses prevent a successful recovery from dispatching further work.

Historical local integrations have a dedicated ledger compatibility operation.
It requires the original server-owned integration run and reservation, the saved
candidate/base, full verification and step reports, and the existing human policy.
It records a historical completion, not a PR. Ordinary new integration transitions
still require verified issue PR delivery. Unknown or unrelated reservations are
left for their owning issue; they are never deleted to unblock another issue.

### Delivery setup and assembly retry

Lifecycle Progress saves missing pull-request settings from an actual matching
human target answer, or asks for that branch directly in the issue. The server
uses the configured Git origin; the browser supplies no repository identity.
Saved answers are decisions, not proof of passing checks or permission to publish.
The issue displays stopped assembly failures and **Retry existing operation**.
Clicks show immediate feedback, reject stale requests, and reuse the existing
assembly run and saved merged tree. Checks can be retried without another worker,
repeat review loop or repeat merge. See [delivery recovery](issue-delivery.md#missing-settings-and-stopped-checks).

### Verification of an existing issue branch

Continue automatically connects a saved verification task to its exact assembled
issue revision under the current approved plan, then launches that task without
another planning review. It does not restart implementation or repeat a merge.
The Verify role shows actual launch blockers instead of a generic finished-review
message. The saved issue checkout and candidate are part of Continue freshness,
so resolving its local blocker enables another attempt. This check-only handoff
cannot authorize implementation or cross-issue work; see
[verification handoff](issue-delivery.md#verification-handoff).

### Automatic completion record

The issue's pull-request card explains the next operation in ordinary language and
uses Continue. It has no JSON upload control. After active work finishes and is
reconciled, Progress runs a focused completion review against the existing issue
candidate and actual evidence. It compiles and saves the internal completion
record through the shared delivery validator, then requests only the actual
publication approval required by the operating policy. Real scope questions are
answered inline; ordinary unfinished technical work is shown without a fake
question. Failed or stale proof never becomes a passing readiness assertion.
After publication, the saved PR link and check/merge controls remain available;
the coordinator does not return to a planning loop or claim issue acceptance.

An incomplete completion review automatically hands technical findings to one
bounded repair-selection attempt within the approved plan. Continue also recovers
saved completion stops from older servers. Recovery attempts are retained per
relevant input, and a repeated unchanged failure stops with its actual reason.
Repair recommendations take precedence over the Commit action; completed work
and merge receipts remain intact. Genuine scope questions still require an answer.

A completion review that finds approved implementation still missing returns a
bounded repair task directly. Progress saves and dispatches it through the normal
scope and human guards without another queue evaluation. The issue shows its
concrete task title. Readiness and publication remain separate from acceptance.
Live output stays durable in the per-run log while history snapshots are batched;
restarting replays uncheckpointed output without duplicating it.

[Issue execution](issue-execution.md) defines the primary chat, approved short
path, unchanged-check reuse and combined final review. Independent reviews and
operation-specific approvals remain separate from work chat reuse.

## Question wording

User-facing questions should read like one engineer talking to another. Ask for
the concrete decision first, then explain why it is needed and what approving,
declining or waiting means for that action. Explain necessary technical terms
and describe any proposed expansion of the approved work separately. Keep the
existing response fields, answer routing and approval requirements: clearer
wording grants no additional authority. Existing saved discussions retain their
original wording.

## Combined Clarify and capture grilling

The project setting in `factory.config.json` combines Clarify and Investigate into
one Clarify stage. Legacy state names remain storage aliases; their reports and
history are preserved. Active investigations keep their assignment and chat, then
feed their findings into Clarify. Diagnostic assessment can inspect code and run
focused checks before plan approval, with source kept read-only. Approval still
belongs to the user and covers intended outcome and scope. Ordinary commits do
not restart the interview; technical plan changes can stay within that approval.

Create issue offers **Grill me after creation**, off by default. With it selected,
the server first saves all reports, then sends an explicit grilling request to
each saved issue conversation. A single saved issue opens automatically; when
capture separates multiple issues, the first opens and the toast links to all of
them. Stable conversation message IDs prevent duplicate grilling on capture retry
or server restart. Conversation failures leave the issue saved and report the
problem. This option starts discussion, not lifecycle execution or implementation.

### Stopped progress and issue output

Retryable stops retain their concrete failure reason and show the next saved
action separately. A retry being available does not mean work is running. A
connected issue action takes precedence over an older blocked controller in the
visible status. The output panel names the issue, reports whether any action is
connected, and updates this state alongside streamed messages and commands.
Provider turn failures are retained in issue output, including failures before
any command or assistant message. Structured provider errors are unwrapped and
redacted; private reasoning is never displayed. Old retained turn failures are
also rendered without rewriting their records.

## Default stopping point

[Draft PR handoff](issue-delivery.md#default-draft-pr-handoff) is the default route.
Undecided integration, Final review and Closed roles display Planned to skip;
explicit choices remain intact. A skip of Closed means the factory stops before
closure. It never records acceptance or changes the report to Closed. On this
route check failures and unfinished work are retained in the draft PR description,
Progress finishes at publication, and the delivery card shows the manual handoff
without automatic merge or check-maintenance controls. The verified delivery
controls remain available for explicitly selected routes.

## Coordinator view

Open **Coordinator** from the header, queue, issue page or a waiting explanation.
The dedicated page shows the shared queue conversation, sanitized live output,
active issue and operation, waiting work and workers still running. The compact
full-width strip beneath the header shows only the issue and basic operation; on
an issue page it appears only during coordination for that issue and disappears
automatically. Page reads and refreshes start no work.

The server manages one read-only coordinator conversation that selects the next
eligible issue from compact queue facts. Its result contains only an issue ID and
reason, never an implementation assignment or route. Issue planning, approval-scope
questions, implementation, recovery and verification use the owning issue chat.
Independent reviews retain their existing evidence and approval boundaries. **Stop** interrupts only queue coordination and leaves issue progress and workers
running. A coordinator failure cannot pause an independently owned issue. **Continue** is explicit: it checks that
the retained conversation is idle, then uses existing issue handlers to inspect
saved work and continue under original approvals. Failed or uncertain startup
never creates a replacement conversation. Noninterruptible record writes finish
atomically before further coordination pauses.

**Send** queues discussion for the next coordinator response, including when another
operation is already waiting. **Steer** addresses the exact
currently displayed response; a stale response identifier is rejected, never sent
to a later response. Neither control answers issue questions, approves plans or
candidates, starts work or accepts issues. Use existing issue controls for those
decisions. Native permission requests are denied by the conversational connection.

**Start fresh** is available only while idle and after interrupted work is checked.
**Start fresh** prepares and names a replacement and archives confirmed idle
predecessors through native RPC without starting a model turn or issue work.

Automatic rotation happens between operations around 20,000 tokens of current
working context, configurable with `coordinatorContextTokens` in
`factory.config.json`. It uses the latest input/output usage, with a conservative
text-size estimate including observed tool output when measurements are absent.
Cumulative billing and turn count do not trigger rotation. A predecessor created
with the old oversized context format is replaced once at the next safe operation.

Each operation receives local source references, rather than copies of all issue
reports, plans and approvals. Current issue records and actual approval receipts
remain authoritative. Useful computed findings can be retained as bounded working
notes with source paths and SHA-256 hashes; findings whose inputs changed are not
reused. The next chat receives only validated relevant findings and source
references. Pending discussion remains in the coordinator store rather than being
copied into the handoff.

The active native chat is explicitly named after the project, such as “Timey
coordinator”. After the replacement attaches successfully, confirmed idle
predecessors are dated and archived. Naming or archival failure retains history
and reports the error without blocking the operation; cleanup retries on a later
operation. The coordinator page shows the current conversation by default, with
**Show archived conversations** for retained history. A restart
or failure preserves output and the interrupted operation and requires explicit
continuation. It never automatically replays the old operation. If the provider
independently confirms that an empty chat has no retained rollout, it may be
replaced once from source records. Populated chats and other uncertain startup
failures retain their guards.

### Factory model preference

`factory.config.json` may set `factoryModel` to a Codex model ID. This project
trials `gpt-6-luna` for new factory chats to reduce latency. The preference is
sent only at thread creation; resuming an existing issue or coordinator does not
change its model. Removing the setting restores the installed Codex default.

Route proposals accept canonical lifecycle state IDs. A model response using an
exact, unambiguous configured display label or role ID is translated to its state ID before
validation and saving; the original response remains unchanged. Unknown or
ambiguous labels are rejected with the configured IDs. Agreeing aliases for one
stage are combined with both reasons retained; conflicting choices are rejected.
Label translation never
changes take/skip decisions, required-stage policy or approval requirements.

### Stable assignments and approvals during issue progress

An unstarted stale assignment is refreshed in place after its approved scope is
validated. Its ID, task, merge policy, dependencies and original snapshot history
are preserved. Source changes alone do not invalidate a retained scope decision;
changed task semantics or altered supporting receipts require an issue-local review.
Direct tasks presented with the approved plan do not receive a redundant model
scope review before launch. Current launch, candidate and human approval guards
remain enforced.

An answer to an assignment-scope or delivery-boundary question is recorded as an
answer, preserving the implementation plan and approval. It grants no publication,
merge or acceptance authority. Explicit plan revision requests suspend approval
but retain the previous plan and receipt in approval history. Reassessment that
returns no replacement plan retains that plan for review rather than failing with
“no plan to approve”. A historical missing plan can be recovered only from the
original human plan-approval receipt, with its content hash and issue identity checked.
