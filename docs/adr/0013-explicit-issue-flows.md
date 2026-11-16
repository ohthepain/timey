# Explicit issue flows

The `number_2` design makes each operation a visible block. The graph is the
planned route. A person can run one block or press Play to run the route.
This addresses the strategy runner's coupling of work, target synchronization,
verification, publication, and readiness.

The flow workspace is the factory server's default page. `/classic` retains the
strategy interface and its historical records. This decision supersedes ADR 0009's
bundled execution for explicitly started flow blocks. It preserves existing
strategy assignments, human-input obligations, protected merge checks, and explicit
acceptance. Reading or refreshing a flow does not migrate or launch old work.

Each issue has one JSON flow under `.issues/flows/ISSUE_ID/flow.json`. The flow stores blocks, dependencies, lanes, comments and attempts. Request owns
Your words and the agent's clarified fields. It is the required first block.
The issue flow stores the settings for Starting point and Destination.
Older records preserve their settings from the former Target block.
A starting point records the full Git ref, display name and exact base commit.
New issues start from the configured delivery branch. Destination follows the
starting branch on the configured remote until explicitly pinned. An existing
PR establishes the locked Destination. External base changes require explicit
acceptance before Publish or Merge. Update Branch fetches the upstream of Starting point and
keeps the checkout's original base. The **Starting branch ahead** menu can run **Update
Branch** immediately with a progress indicator, or add an **Update Branch**
block that must succeed before **Work** can run. With Play active, **Work**
starts when the update succeeds. The immediate action leaves
the flow graph intact. A suggested starting branch update also precedes Work and
becomes its prerequisite when run. The route's
existing update before **Publish PR** stays in place.
Folder rows in the flow sidebar provide a direct issue capture action; captured
issues save the selected folder in their flow at creation.

A block type's Markdown defines its system prompt and its Details and Artifacts
tables. Details declares the block's inputs; Artifacts declares its outputs. The
inspector renders inputs first, then read-only outputs from the latest run, and a
collapsed System prompt section. Each input switches between Manual and Source.
Source defaults to the unique upstream output named by the Details source; when
there is no unique match, the person chooses a source or switches to Manual.
Saved links use the producer's block ID. Request fields supply request facts
and wording. `Starting point.branch` and `Destination.delivery` read Git settings
from the issue flow.

Optional Type and Options columns shape the controls. Supported input types are
`text`, `long text`, `number`, `boolean`, `choice`, `filename`, and `url`; missing
types default to `text`. Choice options are a JSON array in the Options cell.
Filename inputs select a regular file inside the issue repository and save its
relative path. URL values use URL controls and valid HTTP(S) outputs are links.
Artifacts retain their `value` or `file` kind; file artifacts remain file outputs.
Earlier output values stay in attempt history. The block prompt determines
whether missing data or proof should fail the task.

Opening the block editor, starting the block or clicking its wand checks the
selected definition's checksum. A detected edit invalidates every instance of
that definition and the connected successors of each instance. A saved block edit
likewise invalidates the edited block and its connected successors. These actions
request a stop for active work in affected flows. An invalidated attempt remains
in history with the definition and resolved Details it actually used. Results
returned after invalidation remain historical. Details resolve again when the
editor opens, a block starts or a relevant edit is saved.

Saving Your words or clicking the Request wand reruns Request clarification.
The agent derives the issue type, goal, requested proof, known facts, and
constraints. Requested proof proposes a concrete way to demonstrate the goal
and honors any evidence the user asks for. If the type changes, the controller
applies the new type's default flow. Rebuilding preserves the progress of retained blocks
and keeps displaced blocks in history.

The [user-editable flow design](../plans/user-editable-flows.md) records how
Markdown defaults, one-time flow building, manual updates, and export work.

Revision checks reject conflicting edits. Retrying appends an attempt. Interrupted
ownership remains uncertain until the original provider thread is reconciled.
The flow survives workspace deletion.

An active block card shows time on the current attempt, followed by time
on the current command or step. The second timer resets when that label changes.
Command output remains in Progress. Finished, failed, stopped, and disconnected
cards show the latest attempt's duration. A retry starts its timer at zero.
Time waiting for human input is excluded. If a runner disappears, its last saved activity marks the end of
the attempt for timing.

The controller owns flow writes. The executor owns one bounded block.
Work formats issue changes and checks Fallow before running focused tests. It
selects relevant tests from the changed behavior and Requested Proof, and adds a
focused test when existing tests cannot demonstrate the behavior. A failure that
also reproduces on the recorded destination revision is reported in the response
and can leave Work complete. Factory rechecks formatting and Fallow after the
response. It sends failures to the existing Work conversation and stops after
three unsuccessful repair turns. Verify independently checks the full candidate.

The executor returns
results and evidence. The observer reads Git and PR facts independently of model
turns. Local Git queries have short timeouts. PR reads run separately and retain
freshness and failures. An externally merged PR is an observation, not acceptance.
Factory suggests Update Branch when the cached upstream of Starting point
contains commits missing from the issue branch. Git fetches remain explicit operations or external Git-tool work.

The issue timeline groups notes and results from its blocks. Model blocks use
their own Codex conversations so each receives its declared inputs independently.
Explicit continuation can reuse a block conversation with the same inputs and
definition. Before the checkout exists, the timeline uses its project fallback. Classic and flow writers cannot own the same issue concurrently.
Parallel graph lanes describe independent branches. The owning Arena or Swarm
skill can coordinate isolated parallel workers inside its block; ordinary blocks
serialize through the one conversation.

Installed skills are discovered explicitly through the existing Codex transport.
A continuation reuses a conversation only while its skill and inputs match. Missing skills stop that
block without substituting another method. Skill instructions do not authorize
later verification, publication, merge, closure, or cleanup blocks.

The standard delivery flow verifies the updated candidate at delivery.
Merge reuses passing evidence when the issue commit, destination revision,
verification inputs and retained evidence match. Verify remains available as a
standalone block. A change to Goal or Requested proof invalidates related flow
results. Publish PR prepares and
rechecks an exact preview before writing to GitHub. New PR descriptions include
Requested proof when present. Repeat publication updates the title and commit as
needed and preserves the original PR description.

Merge fetches Destination and merges its current revision into the issue branch.
It checks full verification for the issue commit against that destination revision,
pushes any changed commit to the existing PR, and waits for required GitHub checks.
It repeats if Destination
advances. GitHub determines readiness, including repositories with zero required
checks or unsuccessful optional checks. The Merge block Markdown sets the merge
policy, polling interval, check timeout, and repair limit. Human-first policy
requires approval of the current issue commit and target revision. A change to
either revision expires approval. GitHub App publication and GitHub protection
apply. Merge can repair inherited test or formatting failures and new Fallow
findings that block required checks. It commits the smallest repair that
preserves the behavior and coverage under test, then verifies the candidate again.
Close confirms that the target still contains the merged PR and checks
only the GitHub checks required for that PR. Zero required checks is valid.
Explicit acceptance and cleanup ownership checks remain separate.

An open, approved issue has **Close** beside **Worktree**. The header and Close
block use the same dialog and start a separate closure sequence in the issue
flow. Close records the selected reason, then Retro runs if enabled in Request.
Cleanup runs last. If Retro fails, Cleanup waits for a retry or an explicit
choice to continue. Closing as **Fixed** still requires retained evidence and
all acceptance checks. Auto-close requires explicit consent for the delivery
and starts only after Factory confirms its own Merge. Pending issues replace
Worktree and Close with **Needs approval**.

See [Close and Cleanup](../plans/flow-close-cleanup.md) and
[Issue retros](../plans/issue-retros.md).
On closed issues, a red square replaces Play.
Once the issue is closed, **Archive** replaces **Close**. The menu can archive the
saved report, reveal it in Finder, or reopen the issue for investigation.

Use **×** in the inspector’s top-right corner to remove a block after
confirmation. The original Request remains part of the flow.

The artifact inspector shows evidence produced by the selected block. The latest
run appears first. Invalidated results remain visible with their old inputs. Existing evidence from older runs appears in collapsed sections
labeled by run number. Missing files and files that differ from their recorded
digest are omitted. Deleting evidence invalidates any proof that requires it.
Inspect shows raw text and offers a Restate toggle that applies the bro skill’s
plain-language guidance in a temporary discussion. **Worktree → Delete** and
the **Delete worktree** block use the same protected cleanup and retain its backups.

## Update Branch

Choosing **Update Branch** from the **Branch** button, running the **Update
Branch** block, or reaching the block through **Play** authorizes a local commit
when needed. Factory runs the branch update without a second prompt. The Branch
button runs the action directly and shows a spinner. The action leaves the flow
graph intact.

Factory fetches the exact remote branch selected in Starting point, or the
configured remote upstream of a local starting branch. A local branch without
a remote upstream stops with a clear error. If the issue branch already contains the
fetched revision, Factory leaves any uncommitted changes in place. If there are
destination changes to merge and the managed issue worktree has local changes,
Factory saves them in a local commit before merging. The commit includes tracked
edits and deletions and untracked files that Git would normally add. For partially
staged files, the commit saves the working copy. Git-ignored untracked files
stay outside the commit.

Factory formats changed regular files with the checkout's installed formatter
before saving the local commit. Automatic commits run the normal Git hooks. If
formatting or a hook fails, the update stops before the merge and shows the
command output. A successful update has no separate notification for the local
commit.

Update Branch records the fetched commit and resulting issue commit after
checking Git ancestry. It retains Git’s merge commit message or reports a
fast-forward or already up-to-date result. Publish PR and Merge use passing
verification for their committed candidate and fetched destination. A no-op
update leaves uncommitted changes alone.

If Git reports conflicts from this update, Factory gives Codex one attempt. Codex
may edit and stage only the conflicted files. It must preserve both sides and stop
when resolution requires a decision. Factory commits the resolved merge through
normal Git hooks. If the attempt cannot finish the merge, Factory keeps the local
commit and the in-progress merge, lists the files that need attention, and pauses
Play. Resolve or abort the merge in the issue worktree before another update.

## Issue Play and Pause

The server holds Play state for each issue. Issues start paused, including after a
server restart. Tabs can switch issues, refresh, or close while Play is active.
Play waits for any current block, then starts the next incomplete block in route
order. Dotted blocks on the saved route are included. A dependency must be
complete before its successor starts.

Pause lets the active block finish. Stop interrupts it and pauses the issue.
Failure, blockers, invalidating edits, and route edits pause autoplay. Pressing
Play again can retry an eligible failed or stopped block once. A disconnected
attempt requires the block's explicit Recover action. Finishing the route
returns the issue to Paused with a Flow complete message.

No new actions disables Play. A running block can finish, and autoplay pauses
if the switch is still on when it would start another block. Turn off No new
actions and press Play to continue that route.

Play authorizes Publish PR to push the checked candidate and create or update its
pull request. Factory checks the candidate and GitHub destination before writing.
Autoplay starts Merge preparation and waits for any human-first approval once
the PR is ready. At other protected blocks, autoplay waits before the operation.
While autoplay is waiting, the issue header links to the block's
inspector. The link lets the person select the waiting block to open its existing
confirmation. Successful completion of that confirmed block resumes Play.
Cancelling the confirmation or manually starting a different block pauses the
issue. The inspector keeps Run, Retry, Recover, Approve merge, or Stop beside the block name
across tabs. Retry can reuse the block's conversation when its inputs,
definition, and skill still match.
