# Local factory UI

The gear beside **Flow** opens **Project settings**. It edits tracked execution
defaults in root `folder.md` and displays the human-input rules from the project
adapter and the contents of `.issues/triage-labels.md`.
There is no policy preset selector. The lifecycle file defines saved states,
transitions, priorities, and closure reasons; it does not define the adapter's
human-input policy.

The GitHub icon immediately left of the gear shows API requests made by Timey.
Failed requests appear in red parentheses when the count is nonzero. Open the
counter to see the latest 30 requests, newest first, with their repository, start
time, result, and duration. Expand a failed result to read its explanation.
Authentication, retries, and pagination count per request. Git transport and
commands run independently by coding agents are outside this history.
Projects on the same Timey installation share counts and history across restarts.
**Reset history and counts** clears both after confirmation.

The pulse icon and recorded-turn count open **Codex API requests and usage** in a popup.
Both the Codex and GitHub popups offer Reset to clear their request count and recent
history for this installation. Codex reset preserves quota information and other
activity categories; turns already running before reset do not restore old records. Recent Codex turns show
reported input, cached input, output, and reasoning tokens, time to first output
when reported, and total time. **Codex by issue** groups the retained turns.
**Repeated work** highlights matching submitted inputs, repeated block attempts,
and verification reruns with matching inputs. Matches are diagnostic leads.
They do not assign a cost or establish that a rerun was unnecessary.

**Shared stores** shows refreshes, waits, record operations, and counts of
cached views and joined refreshes since server start. **Git and verification**
shows times and outcomes for tracked repository operations and checks. Timings
and turn summaries are local and retain up to 120 entries per activity type.
They do not store prompt text, command output, or credentials.

The panel also shows the signed-in Codex account's remaining ChatGPT usage
percentages and reset times when Codex supplies them. The check starts no model
turn and is cached for five minutes. **Refresh** fetches current limits.
API key sessions use separate OpenAI API organization and project limits.

If the lifecycle file is missing, settings offers a preview and an explicit
**Initialize lifecycle configuration** action using the bundled template. Restore
the original file instead if the project used custom states. Initialization
creates only the missing file, preserves reports and existing configuration, and
starts no work. Retry a blocked flow step explicitly after setup. Read-only blocks
remain available while the lifecycle file is missing.

The default page opens **Project home**, with rolling seven-day issue statistics,
saved investigations, and investigation controls. The shared header stays above
the workspace columns and contains **Home**, **Issues**, **Reports**, **Discuss**,
**Automate me**, and **Admin**, in that order. **Investigate** is a separate
header action. **Automate me** contains the session history and the control to
start a conversation.
Investigations always cover the project and use a selected branch, defaulting to
the branch in Project settings. Optional discussion retains goals and codebase
questions in the investigation conversation. Its ordinary route is Request,
Investigate, Generate report, and Create Issues. Either output can be removed or
run independently after a completed inquiry. Create Issues saves uncovered work
as Needs approval and links matching existing issues without changing them.
Approval does not start work. Reports retains dated publications and evidence,
with optional discussion below the reader. Recommended prompts sit above the
report composer and send their full text with the selected report as context.
Archived investigations retain report access and discussion without starting another inquiry. See the
[investigation reports design](../plans/investigation-reports.md).

**Automate me** runs the installed PStack skill through a guided Codex conversation.
History defaults to four weeks with an editable duration and uses only available
project conversations. Review the proposed skill and destination before **Apply**.
Choose project-local or personal storage, with optional activation as the project's
default for future work. Both operations save progress and provide Stop and Retry.
Opening or refreshing Project home starts neither operation. See the
[project home design](../plans/project-home.md).

Selecting an issue opens its [explicit flow workspace](../adr/0013-explicit-issue-flows.md).
The browser's Back and Forward buttons and history menu traverse project pages,
folders, issues, investigations, and blocks. A block URL opens the same block;
if the block has been removed, Factory opens its issue. If a folder or issue is
unavailable, use the browser controls to continue through history. Inspector
tabs, sidebar filters, and refresh keep the current history entry. Block drafts
stay in the current browser tab when you leave and return through either
Factory or the browser controls.

Understand uses a read-only checkout. Factory retains the final response as its
Block response artifact; the agent does not need filesystem write access to save
that response. Missing historical evidence remains a reported gap. Retro follow-ups
retain the source issue and receive a sanitized snapshot of its saved attempts.
Conflict and CI repair attempts retain their worker turn IDs and declared command
logs. The retrospective export links those turns to their attempts and includes
copies of the logs with their hashes.
It shows issue folders, a downward block graph, and a block inspector. Issue names
include their numbers and wrap. The **Worktree** menu appears in the branch status
row. Its tooltip says whether a worktree has yet to be created or was deleted.
**Open** opens it in Finder. **Update** merges the configured target branch into
the worktree and shows progress while it runs. When an update needs to merge
destination changes, it commits local work before merging. **Delete** requires
a clean worktree and asks for confirmation before removing the managed worktree
and local branch. Drag the sidebar’s right edge or focus the resize
handle and use the arrow keys to change its width. The inspector also resizes from
its left edge. Its left arrow widens it and its right arrow narrows it. Home and
End choose the minimum and maximum width for either panel. The browser remembers
both widths and keeps enough room for the graph. In the narrow stacked layout,
the inspector follows the graph's width and its resize handle is hidden.
**Inspect UI**, **View index**, and Refresh sit on the right of the issue's
second header row. In Details, click the displayed model name to choose a model
where selection is available. The **.md** menu and definition refresh wand appear
on the same row.
Opening an unattempted issue aligns Starting point with the graph viewport's top.
Starting point includes a Git branch selector. It lists local and cached remote
branches by latest commit date, newest first. Branches sharing a commit remain
separate options. Selecting a branch saves its exact starting commit for this
issue. New issues snapshot the configured delivery branch's current commit. The
selector locks when work starts or a checkout exists. Selecting a branch leaves
the project's checkout in place.

Select a folder name to see its issues and actions in the center column. The
triangle beside the name shows or hides the sidebar rows. It points down when
expanded and right when collapsed. Choose a
selection strategy to see suggested issues and the reasons for selecting them.
Adjust the selection before grouping issues or starting overnight work. **Find
issues to add** can scan another folder or the open queue. Review the proposed
moves or choose automatic approval for that scan. To keep an issue out of future
folder moves, enable **Prevent moves into folders** on its Request block.

**Group into one** previews a master issue with the selected requests. Creating
it leaves the original issues linked and assigns their work to the master.
Drag an issue from the sidebar, a folder view, or a master’s sub-issue list
onto a master to attach or transfer it. Drop a sub-issue onto a sidebar folder
to detach it and move it there. Use **×** beside a sub-issue to detach it from
the master without moving it to another folder. Transfers require both masters to be idle and
the Issue and Coordination stores to support the same transaction.
**Work All Night** starts the reviewed list using each issue’s configured Merge
policy. Automatic Merge proceeds after GitHub confirms readiness. Human-first
Merge waits for approval in the issue. A rejected manual action while a block
is running reports its error without updating the running flow’s revision. The
folder shows the run report and the next action for issues that paused.
See the [folder design](../plans/issue-folder-strategies.md) for the master issue's
acceptance and detachment rules.

Destination uses the issue's resolved target branch by default. Starting point
remains a separate choice. Open the destination picker to list
branches on the configured GitHub remote, labeled with the configured remote
name (for example, `origin/main`). Selecting a branch pins it. Choose
**Follow starting branch** to restore the default. A local starting branch matches
the configured remote by name. A starting branch from another remote requires an
explicit destination. Older issues with a PR use its GitHub base. Destination
locks when the issue has a PR. If GitHub reports a changed base, accept that base
in Destination before running Publish or Merge.

The issue number appears in smaller text to the left of the title in the center
column. Use the pencil next to the title to rename the issue. **Start** or **Resume**
runs the route; Publish runs when the candidate and destination checks pass. When running Publish directly,
review the title, source and destination branches, verified commit, and exact PR
description. The description contains Goal, Requested proof, and Original wording
from Request, with empty sections omitted. On later runs, Publish shows pending
title and commit changes and preserves the existing GitHub description. A
matching title and commit show **PR is up to date** with the link. **Confirm
current PR** completes Publish using the existing PR.
When the candidate changes issue annotations, shared coordination, or grouped issue
UI, Publish runs the focused Flow integration cases in the early CI repair plan
before writing the branch or PR. The publication attempt retains the candidate
commit, commands, results, and logs.
The PR menu beside Worktree and Close shows the PR number. **Open** opens the
pull request. **Approve** opens the GitHub review page, where you submit the
approval using the GitHub account signed in to your browser.
The Worktree menu's **Open Terminal** option opens macOS Terminal in the
selected issue's checkout.
Closed issues open with Destination aligned at the bottom. Other issues center
their running or most recently attempted block within the content's scroll range.
The graph has 16 pixels of edge room. Column scrolling stays local, with native
bounce where supported and no pull-to-refresh. Selecting a block scrolls only enough to reveal it. The
circular plus button adds a step. The center-column Start/Resume/Pause control runs
the route one eligible block at a time. A confirmation link appears in the header
when the route reaches a protected block. The Run, Retry, Recover, or Stop button
beside the selected block's name controls that block individually.
Flow is the Factory workspace. Legacy `/classic` links open the selected issue
in Flow. Legacy queue links open **Issues**. Other legacy links open Project Home.
In the **Issues** tab,
you can filter and sort saved issues, edit shared fields across an open selection,
and archive a closed selection.

Editable work and protected operations require the project policy, human input,
credentials, and retained evidence. Blocked commands show the error lines in
**Progress** and link to the full log. Known errors include a plain-language
explanation beside the original output.

The Artifacts tab shows the selected block’s latest run. Expand **Previous
artifacts** to see the surviving files for an earlier run. **Inspect** opens the
raw text. Turn on **Restate** for a version that follows the bro skill’s
plain-language guidance.

The Details tab shows declared **Inputs** first. Each input can use a Manual
value or a matching upstream **Source**; unique Markdown source matches are
selected by default. **Outputs** are read-only fields from the latest run, while
earlier results remain in attempt history. The collapsed **System prompt** section
lets a block use prompt text or one of the skills allowed by its Markdown. Block
Markdown can type fields as `text`, `long text`, `number`, `boolean`, `choice`,
`filename`, or `url`; untyped fields use text controls. Choice options are JSON
arrays. Filename inputs choose repository files and save relative paths; URL
outputs open only valid HTTP(S) links.

Every button provides clear feedback when activated. Show immediate progress for
asynchronous operations, then report success or failure. Use a popup or toast for
operations that run outside the block graph, such as updating a worktree. Keep
block execution progress in its block.

Run `pnpm run factory:ui -- --project /absolute/path/to/timey` from a checkout
containing this adapter. Open the printed loopback URL. Project settings can initialize
only a missing lifecycle file; it does not replace reports or create a registry.
The selected checkout owns the issue records and delivery configuration, so choose the
authoritative project rather than an old worker checkout. In live mode the
server uses browser assets and the restart entry from the installed adapter
checkout. Updating code uses managed deployment with exact passing verification,
HTML and authenticated queue probes. The in-page restart refuses changed installed
source; the external restart command below can install an already verified checkout.
Use `--port NUMBER` only when a fixed local port is needed.

When Timey runs locally from the selected project checkout, its header shows a
**Factory** link to that workspace. The live Factory launcher records its bound
port and instance ID in the project's `.issues/factory-discovery.json`. Timey
checks the loopback health response for the matching instance ID and hides the
link when the instance stops responding. The check also rejects a stale record
when another Factory takes over its port.

The queue and issue screens read actual reports and the dispatch ledger through
the existing factory helper. The issue page polls an issue endpoint that returns only the selected report, its assignments, and its runs. The queue page fetches the queue separately. Each queue refresh projects saved run history once
and reuses that projection for lifecycle availability; dispatch still reads current
history and applies its guards. No history projection is cached across requests. Refreshing and filtering are read-only. Lifecycle
stages come from the configured role mapping. Human input remains separate from
stage, worker completion and code integration. Links use the report's Parent,
Blocked by and Related sections; reverse links are computed from those explicit
references. Reports are displayed as escaped text, never executable HTML.

The queue toolbar has an icon-only **Refresh queue** button beside the settings
and create controls. It requests the current queue data and redraws the view in
place, without reloading the browser page.

Below the issue table, the queue shows the latest saved evaluation's decision and
next action. Earlier evaluations and the full diagnostics for the latest one are
inside the collapsed **History and diagnostics** disclosure.

Under the issue number, the issue screen shows the working checkout's current
branch and short HEAD commit, with the full hash available on hover. It uses
unfinished worker work first, then the assembled issue branch, then the last
worker checkout. Detached or unavailable checkouts and issues without assigned
work are labeled explicitly. Only the selected issue's Git identity is read
on refresh; the running server's branch is never substituted.

The issue screen shows configured lifecycle history as numbered expandable steps,
except Prototype, Implement, Verify, Commit and Final review. Their saved report
events and assignments remain unchanged, but they are omitted from the issue's
step list and queue filters. Issues currently in one of those states remain in the
queue, display a generic queued status, and do not offer lifecycle Progress
controls. Strategy controls remain the active work path. Opening a visible step
does not advance the issue. Stage expansion is preserved while live results
refresh. Earlier visible stages are not marked complete merely because the issue
currently sits later in the lifecycle. Saved timestamps and report notes provide
history where it exists; missing historical transitions are not reconstructed.
Unmatched assignment kinds stay visible under Other work.

### Files and issue folders

Local notes, Files, and Issues scroll together in the left column. The resize
handle stays at the column edge, and the shared header stays above the column.

The sidebar shows the installation's flow and skill folders and the
project's `user/` directory. Use the plus icon on a writable folder row to
create a subfolder. Drop an outside folder onto the sidebar to browse it
in place. Files under `user/` are editable. Use **Install project skill** on
`user/skills/<name>/SKILL.md` to make the skill visible to Codex. Custom flow
definitions live in `user/flow/definitions/`.

On the project page, open **Admin → Prune worktrees** to review stale Git
worktree records and their local branches. The button opens a preview. Check the
comparison branch and the selected entries before applying the batch. A branch
whose tip is outside that history requires explicit selection. Entries used by
open issues or whose checkout directories still exist are kept. The results
show what was removed, skipped, or failed.

**Admin → Preview remote branches** lists branches from the configured GitHub
delivery repository. A branch qualifies when its exact tip is already in the
delivery branch's history. Squash-merged branches may still have a different tip.
Factory keeps protected branches, branches used by open pull requests on either
side, the default and delivery branches, the shared issue queue, and the standard
`main`, `master`, and `dev` branches. Select the branches you want to remove,
review their names, and confirm the batch. Factory rechecks the live GitHub
state and submits only the still eligible branches, with their reviewed commit
IDs. Refresh the preview if GitHub does not confirm the outcome.

**Admin → Preview local branches** starts from local Git branches. The
comparison defaults to the configured delivery branch when available. You can
choose another local or remote-tracking branch; the comparison uses the locally
known commit. Factory keeps branches named by worktrees, including missing
checkouts, and branches referenced by open or unarchived closed issues. A
reference from an archived issue alone does not prevent cleanup. Factory
also keeps project and comparison branches, and checks protection for the configured
GitHub repository. Select eligible
branches, review their names, then confirm. Factory rechecks the reviewed tips
and references before deleting local refs.

**Admin → Preview archived issues** lists archived reports for permanent
deletion. Select one or more reports and optionally select eligible local
branches under each one. Branch selection starts off. Review the exact reports
and branches before confirming. Factory keeps reports that were restored or
changed after preview, and keeps branches that fail the local cleanup checks.
The results show report and branch outcomes separately. This deletes the local
archive copy and selected branches; separate issue cleanup owns worktrees and
conversation data. The issue's display number remains reserved.

To use `$prune-worktrees` from Codex in another Factory project, copy the
bundled `System / skills / prune-worktrees` folder into the project's
`user/skills/`, then use **Install project skill** on its `SKILL.md`. The skill
uses the live project's Admin preview and confirmation.

Folder rows share their triangle, type, color, and spacing. Issue folder names
are italic. Click a folder name to open its landing page. Its triangle expands
the contents. A folder without `folder.md` shows its name, **System folder**, and
**Create folder.md** when it belongs to the project. Installed and external
directories remain browsing-only. Finder and Delete use adjacent icon buttons.
Deleting confirms a move of the real directory and its contents to macOS Trash.
Installed folders use the same action and identify their role in Factory in the
confirmation. Move assigned issues out of a folder and its subfolders before
deleting it. Choose a replacement before deleting the default issue folder.

Create `folder.md` in a project-owned sidebar directory to enable issue actions.
A subfolder created inside an issue folder receives its own settings file.
Use **Move existing issue folders** to convert virtual folders and
store assignments on the issue reports. **Issues** lists open issue folders
directly, including configured project folders, followed by the
**Closed** and **Archived** collections. Each folder shows its
assigned issues and count. Expand or collapse it with the arrow, select its name
to open its actions, or use its plus button to create an issue there. Drag an
open issue onto a folder heading to move it. Every issue belongs to a folder.
The New issue dialog uses the project's default issue folder. A folder's plus
button explicitly chooses that folder. Older reports without an assignment belong to
**Inbox**. The destination expands after the move. Issue move restrictions
and active-work checks still apply. See the
[sidebar folder design](../plans/factory-sidebar-folders.md) for the planned
report storage migration.

### Folder settings

Root `folder.md` stores version-controlled project defaults. Each issue folder's
`folder.md` can override any inherited field listed in the installed
`factory/system/folder.md` reference. Missing fields and `default` follow actual
parent folders, then the project, then Factory's built-in fallback. The page shows
the resolved value and its source. The reference is excluded from folder discovery.

**Is default folder** appears first and never inherits. Exactly one issue folder
is the default for creation without an explicit destination. Zero or multiple
defaults show an error. The magic wand lists missing fields and preserves all
existing fields, comments, and Markdown when adding them. A red wand explains
invalid settings and previews proposed corrections. Unsafe syntax opens for editing.

The issue list switches between **Open** and **Closed**. The top checkbox selects
the displayed results. Text Search matches displayed issues; AI Search sends the
natural-language query and all folder issues in the chosen view through a prompt,
independent of checkbox selection or earlier text filtering. It returns explanations
without changing issue records or selection.

**Start all** and **Archive all** preview checked issues and report each outcome.
Subset selections use **Start selected** or **Archive selected**. Starting uses each
issue's saved route and preserves its eligibility checks and confirmation stops.
Grouping requires each selected issue's PR target to match the folder's resolved
default target. Copying a selection strategy creates an editable file beneath
`user/selection-strategies/` and selects that copy without changing the built-in.

## Queue sorting

The queue defaults to merged issues, then running issues, then queued issues. Other
statuses follow in saved implementation order; ties within each named group also
use that order. Select Implementation order to drag rows and change the persisted
order in `.issues/implementation-order.json`; the scheduler selects the earliest
eligible issue in that saved order, regardless of priority. Hidden rows retain their
positions when dragging within a filtered view. New issues are appended after saved
entries using configured priority, age and ID as the default order. Priority labels
and other views are unchanged.

The issue sidebar also groups reports into user-named folders. Folder assignments
are stored in the ignored `.issues/issue-folders.json` file, separate from report
content and lifecycle state. Drag a sidebar issue handle onto a folder to move it;
drop it on another folder to change the assignment. Issues in sidebar folders appear newest first. Select a folder to reorder its issues
with Implementation order. The ordering is shared with the queue's implementation
order, and hidden issues keep their positions during a folder-scoped reorder.

Drag a block by its handle to reorder the issue flow. The graph shows the
proposed position and connections before drop. With a block focused, use
Alt+Up or Alt+Down to move it.

In Reports, open a report to delete it or select rows in the library and choose
Delete selected. Select all selects the reports in the library. Deleting a
report removes its retained copy and evidence from the report library.

The sort selector also offers implementation order, latest progress first, lifecycle
progress, creation time, completion time and required human input. Direction is a
toggle: a downward triangle means descending and an upward triangle means ascending.
The status and implementation orders have fixed directions. Other modes start
highest/newest/required first. Missing dates stay last
in both directions, with ascending issue ID breaking ties. Filters and sorting
remain selected during live refreshes.

Progress ranks the furthest configured stage actually started, following Next
links; planned and skipped stages alone do not count as starts. Last progress
includes saved stage events, worker activity and results within a stage. Polling
creates no activity timestamp. Completion uses recorded entry into Final review,
excluding closure without a fix. Missing historical dates remain unknown. Human
input includes actionable requests, connected approvals and final acceptance;
deferred requests and future prerequisites do not count. Alternate sorts are
presentation only and do not change readiness or grant authority.

Human-input sorting uses the shared reader's current availability and deferral
overlays, including revision-bound readiness prerequisites. Deferred or upcoming
requests do not count as actionable input; their requirements still block affected
work. Connected worker approvals and current lifecycle questions remain visible.
Final acceptance is projected from recorded finished work, not a stage name alone.

## Model and effort preferences

Use Folder settings to edit inherited model and reasoning effort defaults. Built-in defaults start at GPT-6 Luna and medium. The model selector offers Luna,
GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Astra, Claude Sonnet, Claude Opus, Gemini Pro, and Gemini Flash.
Codex effort choices are low, medium, high, and max. Native-agent choices hide the
effort control. The issue page has separate model
and effort selectors. An unset issue choice follows its folder's inherited setting
until work starts; explicit choices remain fixed if defaults change. Legacy local
defaults migrate into the project file. Explicit legacy issue overrides remain in
`.issues/model-settings.json` and are preserved.

These preferences select the agent when a new conversation starts. Resuming keeps
the same agent; explicit turn settings may change its supported model. Started Flow work retains its resolved
settings snapshot. `model-settings.mjs` validates preferences against the settings
reference. `codex.mjs` passes the effective model to `thread/start` and accepts model
and reasoning effort on configured turns. Native-agent execution uses the installed
Claude Code or Gemini CLI and its own supported login, billing, and permissions.

Claude and Gemini support issue chats, project discussions, and ordinary
model-driven Flow blocks. Install and sign in through the vendor CLI on the machine
running Timey. Missing installation, authentication, quota, or required capability
stops the operation with an explanation. No other provider, model, or billing method
is silently substituted. Background helpers remain on Codex; when project defaults
select a native agent, these helpers use the built-in Codex defaults. The named Sol
reviewer still selects an advertised Sol model.

A waiting native permission or question appears as **Needs your input**. **Open
request** opens the running block's input card without starting another operation.
Approvals stay bound to the current issue, block, attempt, and request. Native
conversation recovery requires inspection of retained work and explicit confirmation
after the original process group ends. Project discussion provider changes start a
fresh native conversation with a handoff while retaining the original history.
Started issue execution settings retain their existing freeze.

See the [native-agent plan](../plans/anthropic-google-model-support.md) for setup,
verification, and the initial capability limits.

Descriptions follow the current [OpenAI model-selection guidance](https://developers.openai.com/api/docs/guides/model-selection).

## Persistent issue conversation

The issue inspector’s **Conversation** tab retains Flow block messages and
responses from capture through closure. The separate **Issue Discuss** panel
has its own history and draft. Opening or refreshing either view reads saved
messages without starting a turn.

The timeline includes the original request, reviewed decisions, work reports,
confirmed verification, GitHub merge, local target update and closure. Factory
events link to their evidence and preserve stable identities across reloads.
Conversation text and worker claims do not establish verification or approval.
GitHub merge and local target update are separate events. Independent reviewers
keep their own context and return sourced findings.

`messages.jsonl`, `chat.json` and `queue.json` live under the issue conversation
directory. Before a checkout exists this is `.issues/conversations/ISSUE_ID` in
the project; normal checkout setup moves it into the managed issue workspace.
`context.json` supplies the same complete timeline to skill-driven work and history
queries. A bounded recent context accompanies each turn, with the full history
linked for older details. Sent prompts and responses survive navigation and restart.

Opening, reopening or switching conversations starts at the latest retained
message. A conversation that stays open follows new messages at the bottom and
preserves the reader’s position when they scroll up.

Project Discuss displays contextual prompts above its composer when the current
conversation offers them. Clicking a prompt sends its full wording. A local
note conversation offers actions based on the saved note and its neighbors.
The combined action keeps the source note until issue creation succeeds, then
deletes it and opens the next note’s conversation.

In Project Discuss, name an open, approved issue and a configured reason to close
it. You can include details to save with the reason. Discuss returns the recorded
reason and the issue link. To remove an issue awaiting approval, ask to delete
the proposal, then confirm permanent deletion of the named proposal. If the
proposal changes before you confirm, resolve it again before deleting it.

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

## Diagnosing a heap crash

If the browser cannot reach Factory, run `pnpm factory:health --url http://127.0.0.1:4317`
with the address from the affected tab. The command checks whether that server
responds and reports the latest recorded Node heap crash separately. A previous
crash can still appear after recovery.

Run the server with `pnpm factory:ui` or the Factory restart controls to enable
Node's fatal diagnostic reports. They go in `.issues/factory-ui/node-crashes/`.
The launchers pass Node's environment and network exclusion flags before
startup. The health command can also identify fatal heap errors
in older restart logs. A crash report records what stopped Node. It takes
separate evidence to identify what held the memory.

## Programmatic restart

Run `pnpm factory:restart` from the selected checkout. It defaults to this checkout,
this project and `http://127.0.0.1:52995`. It starts the current working folder as-is,
including uncommitted WIP, and never runs tests, pulls code, merges branches or accepts
an issue. Both `pnpm factory:restart` and its alias `pnpm factory:reset` load
`.env` from the current working directory before starting; the replacement server
inherits those environment settings. The `.env` file must exist.

```sh
pnpm factory:restart
pnpm factory:restart --checkout /absolute/checkout --project /absolute/project --url http://127.0.0.1:52995 --verification /absolute/summary.json
```

The external launcher permits changed installed source, pauses new actions, waits
for existing work/approvals/chats/locks to drain, verifies process ownership and
rechecks the candidate before stopping only the identified old PID with SIGTERM.
It then verifies the replacement's HTML, authenticated Flow issue list, PID and commit hash.
`--timeout MS` bounds each waiting phase (default 30000). Busy work is never force
killed. Issue work paused at an action boundary stays saved for explicit Continue.

The restart button and command intentionally do not require verification or a clean
checkout. A failed startup is reported with its log and receipt under
`.issues/evidence/`; the old server is left running when the drain or replacement
cannot be completed. The command shares the managed deployment lock and never removes
unknown operation locks.

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

## Header action control and version

The header shows the running Factory server's Node.js heap usage and effective
heap limit. Both values come from the same server sample. The reading refreshes
automatically and shows **Heap unavailable** when Factory cannot obtain a reading.

The header counts running actions and open temporary chats. **No new actions** is
an on/off switch. Turning it on blocks new work and requests that coordinators
pause after their current action. All chats remain available, including opening
conversations, sending and queuing prompts, retrying responses, and steering.
Existing work can finish, permission replies and saving/ending a temporary chat
remain available. A requested server restart still drains work before restarting
and blocks new chat responses during that handoff. Turning the switch off restores
normal dispatch and resumes paused coordinators through their existing guards.
The switch does not restart the server or start a build. Unknown locks still
need their existing reconciliation workflow.

The running-action count includes saved actions still marked preparing, running,
or checking. This includes interrupted preparations that block a server update.
The count opens the **Action list**. It shows those actions,
connected work, active cleanup, and recent stopped
work that can be resumed or skipped. Completed and incomplete
cleanup results are available on the issue page. The open list refreshes when
the running count changes. Each entry shows its saved issue and current
details, links to the issue and that run's output, and
Stop, Restart, Skip, Pause issue and Steer controls. Stop interrupts an
interruptible current response while retaining its saved work. Pause asks the
issue to finish its current action before stopping later work; it does not
interrupt the current response. Steer sends text to the exact active turn.
Restart is available for stopped or failed work and continues its saved issue
strategy or worker assignment within the existing scope. Skip cancels a stopped
or interruptible worker assignment while retaining its checkout and conversation;
it is disabled for an issue strategy whose approved checks and delivery would be
discarded. Unavailable controls explain why they cannot run in the current state.
For a disconnected strategy still preparing with no worker thread, use **Cancel**
to cancel that exact attempt. Factory keeps its history and any checkout. If a
newer attempt owns the issue, its progress stays in place.

**Restart server** in the header uses the same restart path as deployment and
maintenance: it drains current work, permission replies, temporary chats and
coordinator locks before handing the installed listener to a replacement on the
same port. It installs no build. Saved chats, pending questions and progress
remain in the project. The button is hidden on preview copies and while a restart
is already in progress.

The header displays the last four characters of the server's reported startup
commit, with the full hash and source path in its tooltip. Unknown revisions
are shown as unknown, and source changes retain their warning. This is not an
independent attestation of the browser’s loaded code or dirty source contents.

Queue roles use 24-pixel squares. Future roles remain outlined squares on dotted
connectors. Skipped roles use slightly smaller, lowered squares, with the dotted
connector above them. Every square still links to its expanded issue step.

## Closing without completing the work

For an open, approved issue, choose **Close** beside **Worktree**. Choose a reason and
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
Changed reports or reason lists invalidate an open decision. In Flow, manual
Close records the decision, runs Retro if selected, then starts Cleanup.
The Retro checkbox starts with the saved Request setting for Fixed and starts
unchecked for other reasons.
Turn on auto-close in Request to record Fixed after Factory confirms its own
merge and the existing acceptance requirements pass. Each branch requires its
own deletion choice. In shared queue mode, Cleanup waits for the reviewed
closure to reach the shared queue.

Create issue offers **Run a retro** and **Needs approval**. Both start unchecked.
Retro files follow-ups in **Retro items** as **Needs approval**. **Approve**
keeps the item in its folder and restores normal controls. **Delete** names the
proposal in a permanent-deletion confirmation and shows **Deleting…** while
Factory checks and removes the proposal and its exclusively owned evidence.
Work and pending operations for other issues can stay in progress. If the
confirmed proposal changes before deletion, Factory asks you to review it again.
[Issue retros](../plans/issue-retros.md)

## Issue priorities

Select open issues in the **Issues** tab to set their priority together.
The project’s Issue Priorities table in `.issues/triage-labels.md` controls the
available levels. Saving changes keeps each issue’s report and route history.

## Issue PR delivery

**Publish PR** uses the saved Destination. **Merge** starts by fetching that
target into the issue checkout and combining it with the issue branch. Factory
resolves conflicts in the checkout and pushes the resulting commit. GitHub must
observe that commit before Factory checks PR readiness. If the target advances,
Factory updates and pushes the candidate again and rechecks it on the new target.
Review and approval remain tied to the exact candidate and target. A failed
fetch, resolution, or push stops Merge and retains the checkout and command output.

See [issue delivery](issue-delivery.md) for protection and acceptance requirements.

## Create an issue from the list

Use **Create issue** or the plus beside a folder. Enter the request wording and
choose a folder and storage profile. Review the saved issue in Flow. Creating an
issue saves its Request and route. Starting the route is a separate action.

## Factory GitHub App credentials

Run `pnpm factory:setup -- --project /absolute/project` to configure GitHub App
credentials in that project's `.env`. The installer preserves existing values,
prompts for missing App and installation IDs and a PEM file path, and copies the
key into `.env` with escaped newlines. It validates the PEM before writing,
restricts a written `.env` to owner access, and adds `.env` to `.gitignore`.
It never prints the key. Running it again validates existing credentials without
rewriting them. Edit `.env` directly when replacing configured values.

Factory reads these three credentials directly from the owning project's `.env`
without exporting them to worker process environments. Exported environment
variables take precedence. Normal launches and restarts need no `--env-file`
flag. Skill `requirements.json` is tracked configuration and never stores secrets.

The existing compatibility path for server-owned issue strategy operations is `.issues/github-app.json` in the
owning project (this directory is excluded from Git):

```json
{
  "appId": 123456,
  "repository": "owner/repo",
  "privateKeyPath": "/absolute/private/location/factory.pem"
}
```

For a deployed server, the same credentials may be supplied as environment
secrets instead of a local configuration file:
`TIMEY_SOFTWARE_FACTORY_GITHUB_APP_ID`,
`TIMEY_SOFTWARE_FACTORY_GITHUB_PRIVATE_KEY`, and
`TIMEY_SOFTWARE_FACTORY_GITHUB_INSTALL_ID`. The private key may be a PEM value
with escaped newlines. The client ID is not used for installation API
authentication. Environment settings take precedence over the local file and a
partial or invalid set stops authentication rather than falling back to a
personal `gh` login.

Keep the private key outside the repository. No client secret or permanent token
is needed. The server discovers the installation, limits tokens to the configured
repository and refreshes them before expiry. It passes the token only to the
strategy provider's GitHub CLI calls; personal Git/SourceTree credentials and
worker publication are unchanged. Installation authentication does not use
`gh auth login` or the user identity endpoint. A configured app failure stops
rather than falling back to personal credentials.

Give the app Contents and Pull requests read/write, Checks, Commit statuses,
Actions and Administration read-only, and install only on the intended repository.
Grant PR-only bypass of review rules, and no bypass of the separate strict CI
ruleset requiring the existing GitHub Actions `test` check. Owner bypass can remain
for personal direct pushes. Reload through `pnpm factory:restart` after changing
credentials; restarting never retries an issue automatically.

## Shared issue queue

In [shared queue mode](../plans/shared-issue-queue.md), the issue strategy claims an issue on the remote before starting and keeps the claim until Factory confirms the report checkpoint on the queue branch. Timey publishes new checkpoints directly using its GitHub App. Use the issue page to retry publication or reconcile an interrupted claim. Queue pull requests already in progress retain their existing merge and confirmation controls. Legacy assignment launches are unavailable in this mode.

## Skill choices in blocks and chat

The `# Skill list` in each bundled block Markdown defines its skill choices.
Project `user/flow/extensions/blocks/<type>.md` and personal
`~/.config/timey/flow/extensions/blocks/<type>.md` add to that list.
`XDG_CONFIG_HOME` replaces `~/.config` when set. Existing project Markdown
overrides can still replace the bundled list. Work defaults to `poteto-mode`;
explicit selections, including No skill, remain unchanged.

Click a block's skill label to choose a skill. **Add skill…** opens its project
Markdown extension. For example:

```markdown
# Skill list

- my-installed-skill
- [team-work](https://example.com/team/SKILL.md)
- [local-work](../../../skills/local-work/SKILL.md)
```

Local links resolve relative to the Markdown file. A link declares a source; it
does not fetch or execute it. Use **Set up skills** to request installation through
Project Discuss. You can also put raw block instructions under `# System prompt`
in the extension. Opening the editor or changing a selection starts no block.

Chat grilling uses `factory/system/chat/grilling.md`, with additive project
`user/chat/grilling.md` and personal `~/.config/timey/chat/grilling.md` extensions.
Its selector offers the same Add skill and setup actions. No Grilling is a
built-in choice with no skill dependency and always appears last.

Installed custom skills live in `user/skills/<name>/SKILL.md`. Required collection
sources remain in `user/skills/requirements.json`; selector options come from
Markdown rather than a parallel JSON list. Refresh after editing a list.

Closure resolves issue type from its declared input, the current Request fields,
then the saved flow type shown by the Request selector. Invalidated derived fields
do not erase that saved type. Candidate verification, retained proof, and merged
PR identity checks still apply before Fixed acceptance.

When Run a retro is enabled, Retro is a planned closure block. It uses the normal
block status and solid outline before it starts. Saved suggested Retro blocks
are normalized without replacing their selected skill or attempt history. During
closure the saved closure decision controls whether Retro remains enabled.

Saving changed Your words invalidates Request and all subsequent blocks, across
all lanes, before clarification runs. This includes Work and any retained
verification, publication or merge results, even if clarification derives the
same goal and proof criteria. Attempts and evidence stay in history. Rerunning
unchanged wording keeps the existing criteria-based invalidation behavior.

After clarification, resume the route to run Work in the existing checkout.
Publish PR and Merge wait for current Work. Work and Merge handle testing and
repairs. An open PR stays linked to the issue.

## Issue annotations and blocked sub-issues

Open **Issue annotations** in Flow to add a blocker, readiness concern, or
comment. Anyone with annotation access can clear an entry. **Cleared history**
retains the original entry and the first clearance. A badge stays visible while
any active entry reports that label. Filter the issue list by badge or turn on
**Attention first** to move blockers, readiness concerns, and pending approvals
above other issues.

For a master in Work, select the children the attempt will work on when you run
the Work block. Factory records that scope and the checkout state before the
provider receives write access. A master run can detach its own blocked child
during Request or while Work is scoped to siblings. If a Work grant covered the
blocked child, or the checkout cannot be reconciled with the Work log, Factory
keeps the group for review. A reverted change still belongs to the grant under
which it was made.

A child detached by a master run stays open with its annotation history and a
link to the former master. When you remove a child yourself, the child stops
linking to the master and the removal adds no badge. Work and verification use
the remaining children. The original Request and earlier attempts remain in
history. An empty master pauses. Reattach a previously detached child from the
master to resume work.
