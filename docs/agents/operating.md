# Factory operating rules

## Communication

In coordinator and worker chats, write as one professional speaking to another:
use plain language, connected sentences and concise explanations. Lead with the
result. When there is a next step, say clearly what it is and whether it belongs
in this chat or elsewhere. Include checks and limitations that affect that decision.

Use technical terms only when they help, and explain unfamiliar ones. Keep IDs,
commit hashes and detailed logs in linked evidence or actionable commands unless
the reader needs them in the explanation. Describe progress directly, for example:
"The change passes its checks and is ready to merge." Keep finished work, merged
changes and user acceptance distinct in plain language. Prefer short paragraphs;
use lists for separate results or choices.

When the chat's assigned work is finished and nothing remains for it to handle,
tell the user plainly that it's okay to close the chat. Save the decisions,
results and any needed handoff first.
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

For an issue with a saved conversation, include its selected-issue conversation
context and current report in role assignments. The [persistent conversation](factory-ui.md#persistent-issue-conversation)
retains its full timeline for handoffs and retrospective review; it supplies evidence
and feedback, while each operation retains its existing authorization guards.

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

`$factory integrate ACTION_ID` assembles a reviewed contribution on the issue's
stable delivery branch through the shared server operations. It never merges new
work directly into dev/main. Follow [issue PR delivery](issue-delivery.md) for the
completion manifest, publication, recovery, required checks and exact aggregate
human-first approval. All contributions preserve their original policies and bases.
Worker completion, assembly, PR merge, independent integration verification and
human acceptance are separate. Only the coordinator updates authoritative reports.

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

## Local UI transport

The [factory UI adapter](factory-ui.md) may use the installed Codex CLI instead
of native chat tools. It retains exact saved action IDs, isolated worker
checkouts and durable conversation references. Explicit lifecycle Progress
consent authorizes continued work within the selected issue’s approved plan:
recommend, save, launch/reuse, review, verify, record commits and integrate under
an automatic merge policy. It does not authorize another issue, broader scope,
pushes, deployment or closure. A changed plan needs renewed approval. Human-first
integration needs approval of the exact current candidate and target. Required
input is shown and answered in the issue; the same run continues afterward.
Opening or refreshing the UI starts nothing. Native `/factory` commands retain
the separate manual steps above. Independent combined checks and operation-specific
human guards apply in both workflows.
