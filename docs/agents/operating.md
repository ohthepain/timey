# Factory operating rules

## Communication

In coordinator and worker chats, write as one professional speaking to another:
use plain language, connected sentences and concise explanations. Lead with the
result and the next useful action or decision. Include checks and limitations
that affect that decision.

Use technical terms only when they help, and explain unfamiliar ones. Keep IDs,
commit hashes and detailed logs in linked evidence or actionable commands unless
the reader needs them in the explanation. Describe progress directly, for example:
"The change passes its checks and is ready to merge." Keep finished work, merged
changes and user acceptance distinct in plain language. Prefer short paragraphs;
use lists for separate results or choices.

When the chat's assigned work is finished and nothing remains for it to handle,
tell the user plainly that it's okay to close the chat. Save the decisions,
results and any needed handoff first; if work continues elsewhere, say where.
If this chat still has work or unanswered questions, explain what remains.
Offer closing as a suggestion for the user; issue acceptance remains a separate
decision.

## Manual control

The [factory interface](factory.md) defines queue-wide, issue-focused, listing
and explicit continuation commands.

`$factory` or `$factory ISSUE_ID ...` performs one decision iteration. It reviews
the queue, active worker snapshots, and effort plan; reconciles available evidence; evaluates grouping;
and saves ranked recommendations. It creates no worker chats, runs no recommended
actions, merges no code, and never schedules the next iteration.

`$factory launch ACTION_ID ...` is a separate, explicit action trigger. It validates
the selected saved recommendations and starts each through its own reservation
and chat attachment. The Both choice also opens human input in the caller's chat.
Starting a worker does not trigger another evaluation. Several explicitly selected independent
actions can run concurrently. Reuse existing Codex chat/worktree tools rather than
building a daemon. Present native follow-up suggestions with a copyable fallback;
do not promise actual composer prefill.

The coordinator owns `.issues/` reports and `.issues/factory.json`. Workers receive
bounded issue snapshots and write results on their own branches, not into the
coordinator queue. The helper uses a lock and atomic registry replacement. Treat
unknown/stale locks or uncertain launches as reconciliation tasks, never as a
reason to blindly erase state and retry. Its state transitions are safeguards,
not a substitute for evidence review.

## Decide and dispatch

Group when a shared cause or implementation reduces duplicated work; mere proximity
in the code is insufficient. Prioritize urgent outcomes and prerequisites, then
coherent shared fixes. Preserve deferred issues, existing work, per-issue evidence,
and explicit narrowing. An issue's autonomy never transfers to another.

Recommendations state issue IDs, scope, rationale, dependencies, expected evidence,
starting revision, and merge policy (`automatic`, `human-first`, or `none`). Review
human obligations and blocker outcomes from reports. A triage label does not prove
readiness. The helper guards current code/queue fingerprints and active claims,
but the coordinator must assess semantic dependencies and report evidence.

Workers use separate Git worktrees from the explicit approved revision. Commit
approved source before launch so the worktree includes the factory and agreed
scope. Preserve unrelated dirty work; do not add it to a commit to satisfy launch.
Reserve before `create_thread`, include the action ID in the prompt/title, then
record the returned ready ID/host or pending setup ID. Pending IDs cannot be used
as ready thread IDs. On uncertain results, find the original chat before retrying.

Record a cursor and use compact `wait_threads` snapshots when examining workers;
avoid rereading entire conversations. Follow-up messages are authorized only
within the human-triggered assignment. Worker instructions do not authorize
cross-chat replies or new work; the coordinator reads worker results itself.

## Integration and review

`$factory integrate ACTION_ID` explicitly triggers finalization of a completed
code action in the authoritative checkout. Coding and integration-candidate work
runs in separate chats; this final coordinator operation serializes the target
merge and queue bookkeeping. It is never executed by a decision invocation.

Worker completion does not verify or integrate work. The coordinator reviews
the diff and evidence, serializes integration, and checks the combined revision.
Choose automatic merge for approved scoped changes with sufficient evidence;
require human approval first for unresolved behavioral decisions, material scope,
or correctness uncertainty requiring human judgment. Make the policy visible
before launch. A worker may not silently expand an action's integration scope.

Outer-loop taste review alone need not block local integration. Missing hardware
evidence blocks progress that depends on it. An integration outside the selected
action's scope needs another manual trigger. Only the coordinator updates reports
after inspecting outcomes; action status `integrated` means reconciled/verified
work, not user acceptance or issue closure.

Use local commits to preserve verified progress with outstanding human checks
recorded. Before declaring an implementation step or worker code action complete,
run the [step-completion audit](verification.md#commit-and-step-completion-checkpoints)
against its recorded starting commit, including work that ends without a commit.
Retain current command/scope/result evidence; unresolved findings or warnings mean
the step is blocked, not complete. Coordinator completion assertions must review
that evidence as well as the worker's reported outcome. Repo lifecycle exit conditions govern advancement. At the end of a
coherent batch, present runnable results, per-issue outcomes, evidence, limitations,
and precise human checks. Keep issues open for actual acceptance.

## Durable state and improvement

Tracked effort plans contain outcome, constraints, decisions, evidence pointers,
and next action. Local registry entries contain live action/thread identifiers.
Fresh coordinators read both; if the registry is missing, discover existing chats
and restore known claims using `factory recover FILE` with original action IDs,
scope/issue IDs, kind, policy, status, references, and discovery evidence. Initialize
an empty registry only when no workers need recovery. Missing local data does not
prove no worker exists. Avoid copying issue histories into every document.

Agents maintain affected docs with source changes. Use `/retro` for consequential
failures, recurring friction, hard handoffs, and substantial batches. Inspect
existing checks first. Mechanical errors get deterministic checks; reviewer
standards cover genuine judgment. Larger repairs can proceed after notification
of problem, scope, and verification plan, within approved authority. Weakening
checks, expanding authority, or changing product expectations requires agreement.
Verify the repair's effect rather than accumulating generic instructions.
