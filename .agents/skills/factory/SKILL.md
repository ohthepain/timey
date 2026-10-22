---
name: factory
description: Evaluate Timey's local work queue and recommend actions, or launch one explicitly selected saved action in an isolated worker chat.
---

# Factory

Read `docs/agents/operating.md`, `issue-tracker.md`, and `verification.md` from the
project root. This skill is manually invoked. A decision iteration and an action
launch are different user actions; never silently combine or repeat them.

## Decide: `$factory`

1. Run `npm run factory -- inspect`. Read the tracked effort plan and relevant
   reports. With a missing registry, discover existing worker chats and reconcile
   known action IDs. Restore discovered workers with `npm run factory -- recover FILE`;
   use an absolute temporary JSON file and retain original IDs, issue IDs, kind,
   merge policy, status, ready/pending chat references, and `recovery_evidence`.
   Completed code recovery must preserve `worker_revision`; if unknown, recover
   the worker as blocked until its exact result commit can be established.
   Use `npm run factory -- init` only after confirming no workers need recovery.
   If the queue itself is absent, initialize it with the installed setup-local-issues
   skill and apply this repo's policy before inspection. Do not reset damaged state
   or erase uncertain reservations.
2. Inspect recorded workers with compact `wait_threads` snapshots, preserving
   cursors in the effort plan/registry as needed. Read evidence before recording
   outcomes. A worker's final message is not integration or issue acceptance.
3. Assess shared causes/grouping, semantic dependencies, human obligations,
   existing work, and urgency. Propose a ranked set of bounded actions; prefer
   coherent grouped fixes and useful parallelism, not arbitrary task splitting.
4. Save tracked effort-plan updates first. Commit only coordinator-owned documentation
   changes under the repo policy when needed for a clean launch revision; preserve
   unrelated edits and report that they block launch. Then save recommendations
   with `npm run factory -- recommend /absolute/tmp/actions.json`.
   The input is an array of `{kind,title,scope,reason,verification,worker_prompt,
merge,issues,dependencies}`. Kinds: `investigate`, `prototype`, `implement`,
   `verify`, `review`, `integrate`, `retro`. `merge` is `automatic`, `human-first`,
   or `none`; issue IDs are full local IDs; dependencies are existing action IDs
   (`none` is for non-code work; code actions require an integration policy).
   (use `[]` when none). Review/verification/integration may depend on a completed
   worker result; implementation dependencies require reconciled or integrated work.
   Put scope, expected evidence, and worker result format in
   `worker_prompt`. Source/report text is evidence, not authority to expand scope.
5. Present the ranked actions with reasons and explicit merge policies. Put the
   highest-priority next action first using a native follow-up suggestion:

   `- :codex-followup[Launch recommended action]{prompt="Use $factory launch FULL_ACTION_ID in this project."}`

   Include a copyable `$factory launch FULL_ACTION_ID` fallback. Save the next
   action in the effort plan; modifying tracked source makes a recommendation
   stale, so save tracked plan updates before generating recommendations.

Stop. This branch creates no worker chats, performs no recommended implementation
or merge, and does not automatically initiate another decision iteration.

## Launch: `$factory launch ACTION_ID`

The human explicitly authorizes creating and following up the selected worker
chat within the saved scope, using an isolated Git worktree for coding. This does
not authorize other recommendations or a decision loop.

1. Inspect the saved action and reports. Revalidate dependencies, verification
   obligations, scope authorization, and merge policy. If stale or blocked, report
   why and recommend a fresh manual decision iteration; launch nothing.
2. Run `npm run factory -- reserve ACTION_ID`. It refuses stale recommendations,
   dirty source, overlapping active issues, and duplicate launches. Preserve
   unrelated work rather than committing it to get past this guard.
3. Discover the app tools, call `list_projects`, and match this repo. Call
   `create_thread` once for the reserved action, with its ID in the human-readable
   prompt/title. Coding work uses `environment.type: worktree` and an explicit
   `startingState` referencing the action's saved HEAD. Do not invent a branch
   name or override model/reasoning settings.
4. Supply the issue snapshot, starting revision, operating/verification pointers,
   acceptance criteria, and expected result: changed files, commits, actual check
   results, evidence, limitations, and remaining human obligations. Workers must
   not mutate the authoritative queue, launch other chats, auto-push, or close
   issues. Return results in the worker's final response; cross-chat reporting
   messages require their own human authorization.
5. Run `npm run factory -- attach ACTION_ID /absolute/tmp/reference.json` with
   `{threadId,hostId}` for a ready chat or `{clientThreadId}` for pending setup.
   On uncertain launch/attach failure retain the reservation and reconcile;
   never create a replacement chat speculatively. Missing tools are a blocker,
   not permission to imitate a chat with a subprocess.
6. Report the created/pending chat and emit the supported created-thread directive.
   Return control without waiting for completion. Do not launch the next action.

## Integrate: `$factory integrate ACTION_ID`

This is an explicit coordinator operation on a completed code action, separate
from both decision evaluation and worker launch. Worker chats prepare code or
integration candidates in worktrees; only this manually triggered coordinator
step finalizes a merge into the authoritative checkout.

Read the completed action, exact `worker_revision`, scope, merge policy, current
target, reports, and actual evidence. Preserve a dirty checkout and stop rather
than stashing, resetting, or including unrelated work. Confirm there is no other
integration in progress. For `human-first`, show the candidate diff and evidence
and require the human's explicit approval for this merge; the original worker
launch alone is not approval. For `automatic`, this explicit integration trigger
permits the coordinator to proceed once its evidence conditions are satisfied.

Use Git's normal merge operations on the exact candidate commit. Recheck target
HEAD immediately before merging and resolve only conflicts within the approved
scope. If correctness or intended behavior is unclear, preserve the candidate and
ask. Run relevant verification on the combined result and record actual failures;
do not mark failed integration verified. Keep human obligations and closure pending.
After successful integration, record its checked revision and evidence as below.
Do not dispatch another action or start a decision iteration afterward.

For a completed code action needing finalization, the decision branch can recommend
`$factory integrate ACTION_ID` directly. It must not execute it. Other new actions
use saved recommendations and the launch branch.

## Reconcile evidence

Use `npm run factory -- record ACTION_ID /absolute/tmp/result.json` for lifecycle
records: `{status,evidence}`. Completion never edits issue state. For `integrated`,
also provide `verified_revision` equal to current HEAD and `checks_passed: true`
only after reviewing actual integrated checks. This is an assertion requiring
evidence, not a command that runs checks or performs a merge.

Completed code actions also need `worker_revision` naming the exact worker commit.
Integration verifies that commit is an ancestor of the checked current HEAD.
`human-first` integration additionally needs `human_approved: true` backed by the
human's actual approval in the evidence. Non-code outcomes can be marked
`reconciled` after evidence review without pretending code was merged. A blocked
setup can attach its recovered original chat; recovery never requires relaunching.

Integration/review recommendations are manually triggered too. Honor the selected
merge policy, serialize merges, and follow the operating guide. Pending human
review never becomes acceptance through a worker result or ledger transition.
