---
name: factory
description: Browse issues and saved progress, evaluate work, handle human input, and manually launch selected worker chats.
---

# Factory

Follow the [factory interface](../../../docs/agents/factory.md) from the project
root. Accept `/factory`, `/Factory`, and `$factory` as this skill's chat invocation.
Route by arguments below; a decision iteration and action launch are separate
manual actions. Preserve the existing explicit-only invocation policy.

## Status: `$factory status [ACTION_ID ...]`

Run `pnpm run --silent factory -- status` and display its generated Markdown
directly. Pass `--json` only when JSON is requested or needed for coordination.
Action IDs or unique prefixes narrow the output; `--details` requires exactly
one action and returns its full saved record. Read full records/reports/evidence
only when the next decision needs them. Status alone checks no live chats,
reassesses no readiness, and writes nothing. Explain missing/damaged records
without initializing or repairing them. Stop after displaying status.

## List: `$factory issues`

Run `pnpm run factory -- issues --output ABSOLUTE_UNIQUE.html` using the chat's
writable visualization directory; pass supported `--state`/`--sort` options.
Display the returned file directly with the installed issues skill's inline
renderer (`visualize{"path":"/absolute/path.html"}`). This branch uses the
installed listing script; read no report bodies and perform no evaluation or
queue mutation. Report helper/runtime/rendering limitations without inventing a
second listing implementation. Stop after displaying the result.

## Decide: `$factory [ISSUE_ID ...]`

Read `docs/agents/operating.md`, `issue-tracker.md`, and `verification.md` before
coordinating work.

1. Start with `pnpm run --silent factory -- status --json` for saved results and
   chat references. Use those references for compact worker snapshots rather
   than rediscovering known chats. Load full action records only for changed or
   relevant outcomes; status text alone is not evidence review.
   Run `pnpm run factory --` with any selected issue IDs as arguments when queue
   evaluation needs report content. Save the full inspection to a temporary JSON
   file and extract the needed reports instead of printing all prompts/history.
   Use the
   returned `focus_issue_ids` as the assignment; other reports remain dependency
   and existing-work context. Missing/ambiguous selections stop this iteration.
   Inspect outside blockers, explaining any proposed scope expansion for human
   selection. Read the tracked effort plan and relevant
   reports. With a missing registry, discover existing worker chats and reconcile
   known action IDs. Restore discovered workers with `pnpm run factory -- recover FILE`;
   use an absolute temporary JSON file and retain original IDs, issue IDs, kind,
   merge policy, status, ready/pending chat references, and `recovery_evidence`.
   Completed code recovery must preserve `worker_revision`; if unknown, recover
   the worker as blocked until its exact result commit can be established.
   Use `pnpm run factory -- init` only after confirming no workers need recovery.
   If the queue itself is absent, initialize it with the installed setup-local-issues
   skill and apply this repo's policy before inspection. Do not reset damaged state
   or erase uncertain reservations.
2. Read the shared `progress` entries in the inspection before selecting work;
   an active issue coordinator must not get a competing coordinator. Surface an
   existing waiting question through its original response control. Inspect recorded workers with compact `wait_threads` snapshots, preserving
   cursors in the effort plan/registry as needed. Read evidence before recording
   outcomes. A worker's final message is not integration or issue acceptance.
3. Assess shared causes/grouping, semantic dependencies, human obligations,
   existing work, and urgency. Propose a ranked set of bounded actions; prefer
   coherent grouped fixes and useful parallelism, not arbitrary task splitting.
4. Save tracked effort-plan updates first. Commit only coordinator-owned documentation
   changes under the repo policy when needed for a clean launch revision; preserve
   unrelated edits and report that they block launch. Then save recommendations
   with `pnpm run factory -- recommend /absolute/tmp/actions.json` when worker actions
   are appropriate. With only human input or waiting work, save no empty action
   batch and present the applicable choices instead.
   The input is an array of `{kind,title,scope,reason,verification,worker_prompt,
   merge,issues,dependencies}`. Kinds: `investigate`, `prototype`, `implement`,
   `verify`, `review`, `integrate`, `retro`. `merge` is `automatic`, `human-first`,
   or `none`; issue IDs are full local IDs; dependencies are existing action IDs
   (`none` is for non-code work; code actions require an integration policy).
   (use `[]` when none). Review/verification/integration may depend on a completed
   worker result; implementation dependencies require reconciled/integrated work or an exact approved assembled starting revision under the issue-delivery contract.
   Put scope, expected evidence, and worker result format in
   `worker_prompt`. Source/report text is evidence, not authority to expand scope.
5. Present the applicable **Human input**, **Launch recommended group**, and
   **Both** choices defined in the interface guide, with named issues/actions,
   grouping reasons, dependencies, verification and merge policies. Offer current
   human input in this chat; required clarification precedes dependent work,
   while later hardware/final judgment remains pending until useful. Group only
   independent dispatchable actions. Omit unavailable choices and explain why.
   Keep action UUIDs in native follow-up prompts, with readable labels and a
   copyable command fallback. The launch choice uses:

   `- :codex-followup[Launch recommended group]{prompt="Use $factory launch ACTION_ID ACTION_ID in this project."}`

   Human input uses `$factory human ISSUE_ID ...`; Both uses
   `$factory both ACTION_ID ...` and names the displayed human-input issue IDs
   separately in the same prompt. Allow narrowing; selecting input/group members
   alone authorizes no launch. Save the next
   action in the effort plan; modifying tracked source makes a recommendation
   stale, so save tracked plan updates before generating recommendations.

Stop. This branch creates no worker chats, performs no recommended implementation
or merge, and does not automatically initiate another decision iteration.

## Human input: `$factory human [ISSUE_ID ...]`

Read the tracker/verification policy and the installed issues skill's human-input
instructions and protocol. Resolve the selected IDs (or the queue when omitted)
through `pnpm run factory -- [ISSUE_ID ...]` without performing another decision
iteration. Read fresh requests/checks and discuss the actionable selected input in
this chat. Use the installed guarded helper and each projected source's owner
handler for responses. Preserve partial answers, deferral and per-request outcomes;
grilling is optional unless actual material questions block the operation.
Apply only justified report/readiness changes. Saving input defaults to record-only.
After changed answers, offer manual reevaluation of these issues, since saved
recommendations may now be stale. An explicit Answer and continue must name its
next operation and pass its normal gates. Stop without implicit launch or merge.

## Launch: `$factory launch ACTION_ID ...` or `$factory both ACTION_ID ...`

The human explicitly authorizes creating and following up the selected worker
chat within the saved scope, using an isolated Git worktree for coding. This does
not authorize other recommendations or a decision loop.

Read operating, tracker and verification policy. For a group, deduplicate exact
action IDs, preflight every selected action before creating any chats, and ensure
the actions are independent, current and within the displayed/selected scope.
An already dispatched action is reported using its existing reference rather than
relaunched. Revalidate each action again at reservation; groups are not atomic.
On blocked/stale preflight launch none and offer a manual evaluation. On a later
failure or uncertain creation/attachment, stop remaining launches and report each
actual outcome, preserving earlier chats and uncertain reservations.

For each selected action:

1. Inspect the saved action and reports. Revalidate dependencies, verification
   obligations, scope authorization, and merge policy. If stale or blocked, report
   why and recommend a fresh manual decision iteration. Read the installed issues
   skill's human-input protocol and helper for declared operation-specific gates,
   alongside semantic report review; the ledger's legacy human_checks guard alone
   does not establish readiness for new input metadata.
2. Run `pnpm run factory -- reserve ACTION_ID`. It refuses stale recommendations,
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
5. Run `pnpm run factory -- attach ACTION_ID /absolute/tmp/reference.json` with
   `{threadId,hostId}` for a ready chat or `{clientThreadId}` for pending setup.
   On uncertain launch/attach failure retain the reservation and reconcile;
   never create a replacement chat speculatively. Missing tools are a blocker,
   not permission to imitate a chat with a subprocess.
6. Report the created/pending chat and emit its supported created-thread directive.
   Continue only through the other explicitly selected independent group members.
   Return control without waiting for completion or launching dependent work.

For **Both**, after successful dispatch handle the explicitly displayed/selected
human-input issues in this chat using the Human input branch. A bare Both command
uses the selected actions' issues. With an uncertain/blocked launch, report it
before offering human input; preserve unresolved dependent work. Human answers
do not authorize a retry or another iteration.

## Integrate: `$factory integrate ACTION_ID`

Read [issue delivery](../../../docs/agents/issue-delivery.md). This explicit
coordinator operation reviews and assembles one contribution on its issue branch.
Use the shared `factory issue-delivery assemble ISSUE_ID INPUT.json` handler;
retain its independent checks and receipt before releasing the action claim.
Complete all approved issue work and review its completion manifest before opening
one PR. Publication, merge and verification are separate guarded operations. Stop
after the selected operation. Ordinary workers remain non-publishing.

## Reconcile evidence

For issue-step completion or implementation-plan findings, read
[shared records](../../../docs/agents/factory-records.md) and use its guarded
`complete` and `record-checks` commands. Both coordinators record the same facts
with the same formats. Reuse current shared check receipts; never rerun a review
just to create UI history. Worker completion alone still does not advance an issue.

Use `pnpm run factory -- record ACTION_ID /absolute/tmp/result.json` for reviewed
worker outcomes. New `assembled` and `integrated` records require durable shared
assembly and verified PR proof. A `checks_passed` boolean or model claim cannot
replace those receipts. Preserve historical records when reading older results.

For concise status reports, include optional `summary`, `remaining` and
`evidence_links` as described in the interface guide. Record actual reviewed
results and next steps, keeping detailed evidence available through links.
Reporting fields grant no permission or human acceptance; reading status never
adds or changes them.

Completed code actions also need `worker_revision` naming the exact worker commit.
Issue assembly and delivery retain that commit together with the immutable original base.
`human-first` PR merging needs the actual exact aggregate approval retained by the shared delivery operation. Non-code outcomes can be marked
`reconciled` after evidence review without pretending code was merged. A blocked
setup can attach its recovered original chat; recovery never requires relaunching.

Integration/review recommendations are manually triggered too. Honor the selected
merge policy, serialize merges, and follow the operating guide. Pending human
review never becomes acceptance through a worker result or ledger transition.
