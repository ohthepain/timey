# Explicit issue flows

The goal is a three-column issue workspace where people choose each operation,
its skill, and its order. Every operation has a visible block and retained attempts.
The original request is preserved. Refresh reads external state without starting work.

## Workflow

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [x] Phase C: Run the loop.
- [x] Phase D: Keep the audit trail.
- [x] Phase E: Verify and hand back.

## Done check

A disposable project can create a typed request, edit its five request fields,
organize issues into folders, insert and reorder blocks, select installed skills,
start and stop one block, retry with retained attempts, and inspect conversation,
results, evidence, and artifacts. Reload preserves edits. Git observations detect
changed target revisions and removed worktrees. Work never silently starts the
next block. Existing merge, closure, and deletion protections remain enforced.
The graph runs down from the original target revision to the destination branch and
shows suggested future blocks with dotted outlines.

## Design comparison

Both independent source readers found that strategy execution bundles work,
verification, publication, and target synchronization. Wrapping that cycle in a
block would misrepresent the user's control. The chosen design is a separate
explicit flow controller using the existing conversation and protected-operation
adapters. A persistent graph owns ordering and attempts. The existing strategy
and queue records remain intact and available through the classic interface.

## Throughput checkpoint

- Blocking first steps. Read ownership and verification policy, inspect the current
  execution path, agree the graph and HTTP contract before implementation.
- Independent workstreams. The flow model and HTTP adapter, block execution, and
  browser workspace have distinct files and a written shared contract.
- Shared mutable state. The flow controller is the only writer of flow JSON.
  Execution returns results and progress through its callbacks. One issue chat
  has one writer. Parallel lanes describe independent work inside an arena turn.
- Smallest safe decomposition. Three owners implement model, executor, and UI.
  Focused record checks precede browser verification and the completion audit.

## Verification and limits

Use real disposable Git repositories for persistence, target changes, and missing
worktrees. Use the browser for layout and interactions. Model transport is stubbed
in protocol tests and never treated as evidence of a live model result. Do not
merge, publish, deploy, close real issues, or delete real artifacts during this run.

## Results

The implementation is on `number_2` and remains uncommitted. The live source
preview is at `http://127.0.0.1:4317/`; `/classic` retains the previous interface.

The rigor level uses real disposable Git repositories, actual browser controls,
and the canonical human-input and closure writers. Model and provider protocol
responses are injected. No real model task, PR publication, merge, closure,
deployment, or artifact deletion was used as a test.

- The aggregate factory run passed 833 checks. The final retained-claim guard and lane-preserving reorder were
  then added and verified by the current focused suite of 65 passing checks.
- All legacy browser scenarios and the 13 explicit-flow browser scenarios passed.
  The browser records no automatic model or skill-list calls during polling.
- Changed-file formatting and `git diff --check` passed.
- The saved-base step checkpoint completed. Fallow was skipped by repository
  default, so this run does not claim a Fallow analysis result.

Retained command logs live under `.issues/evidence/number-2/`. The browser run is
`.issues/evidence/flow-browser-8f0c1b68-8a5b-478a-bd63-1dc97d7e108c/results.json`.
The decision trail is [decisions.tsv](decisions.tsv). The initial two placeholder
timestamps have a superseding audit row and are not authoritative.

Final review reproduced cancellation and target-divergence counterexamples.
The corrections now preserve all unreconciled attempts, require positive idle
observation before releasing a model claim, keep classic controls out of retained
claims, and observe the configured remote target when local and remote diverge.
A retained blocked or completed legacy claim requires reconciliation rather than
starting another writer. The final focused suite covers that guard.

## Remaining limits

Live Codex transport and real GitHub writes require a smoke test with the user's
project policy and App credentials. This source checkout lacks its local
`.issues/triage-labels.md`, so editable work reports a setup blocker here. No
policy was invented. The installed pnpm shim was broken; checks used the fetched
pinned pnpm 12.15.0 executable without changing repository package versions.

Parallel lanes display graph branches. Ordinary blocks serialize through the
one issue conversation. Arena and Swarm own any parallel workers inside their
selected block. Their individual worker graphs are not imported automatically.

The final independent reviewers used the inherited model because configured
Claude and Grok families were unavailable. They found no comment removals. The
last retained-claim finding was corrected and proven by a focused regression.
No active transcript path was exposed for a separate transcript audit.

## Sidebar and graph follow-up

The user requested numbered, wrapping issue titles in a resizable sidebar,
top-to-bottom graph order, initial active-block centering, minimal scrolling on
selection, a circular add control, and a header Continue action.

- [x] `how` over the affected subsystem.
- [x] `architect` for parallel design exploration.
- [x] Write the throughput checkpoint as four todo items.
- [x] Delegate code-writing to a subagent.
- [x] Verify on the matching surface.
- [x] Rebase into small, ordered commits. Skip. The user has not requested commits.
- [x] If the design is contested, `interrogate` before shipping. Skip. Independent review found no contested design.
- [x] Run **Opening a PR**. Skip. This is a local preview with no publication request.

### Follow-up throughput checkpoint

- Blocking first steps. Inspect selection, polling, graph connections, and existing continuation guards before editing.
- Independent workstreams. One owner edits UI assets. The parent owns browser checks and documentation.
- Shared mutable state. UI preference and scroll intent belong to the browser. Issue flow records and execution guards stay with the existing service.
- Smallest safe decomposition. One UI owner avoids competing writes across the coupled markup, styles, and event handlers.

Starting revision remains `afa10b2d77db60590a9383f458b530f8aba32915`.

Two read-only designs compared one-use scroll intent with saved card anchors.
One-use intent was chosen because polling can retain the current scroll position
without a viewport cache. The intent distinguishes initial centering from minimal
reveal on click. The selected block defaults to running, then most recently
attempted, then Request. The existing guarded continuation handles the header action.

The follow-up passed 17 real browser scenarios, including pointer and keyboard
resizing, saved width, wrapped numbered names, exact Request and running-block
centering, downward dependency geometry, minimal click scrolling, stable refresh,
and guarded Continue. The fixture uses an injected executor and starts no live
model. Evidence is in
`.issues/evidence/flow-browser-0316f2bc-90c7-48b8-b900-71109c998432/results.json`.
The refreshed source preview also shows issue #114 with wrapped numbered rows,
Request centered, and the header Continue control. Formatting and independent
review passed. The comment review found no comments or suppressions in the four
scoped source and browser files. The saved-base step audit completed with Fallow
skipped by repository default. Changes remain uncommitted on `number_2`.

## Bounded scrolling follow-up

The user requested scroll ranges limited to the blocks with a little bounce room,
without pull-to-refresh. New issues start with Starting point's top at the viewport
top. Closed issues start with Destination's bottom at the viewport bottom. The
dotted-block explanation is removed. This supersedes the earlier Request-centering
behavior for unattempted issues.

- [x] `how` over the affected subsystem.
- [x] `architect` for parallel design exploration.
- [x] Write the throughput checkpoint as four todo items.
- [x] Delegate code-writing to a subagent.
- [x] Verify on the matching surface.
- [x] Rebase into small, ordered commits. Stack follow-ups. Skip. No commit request.
- [x] If the design is contested, `interrogate` before shipping. Skip. No contested design.
- [x] Run **Opening a PR**. Skip. Local preview only.

### Bounded scrolling throughput checkpoint

- Blocking first steps. Trace the large margins and existing scroll intent before changing geometry.
- Independent workstreams. One UI owner changes the two coupled source files. The parent changes tests and documentation.
- Shared mutable state. Only browser scroll intent changes. Issue records remain unchanged.
- Smallest safe decomposition. A read-only design comparison precedes one implementation owner and independent review.

The design comparison chose fixed edge room and native overscroll containment
over scripted bounce. Existing one-use scroll intents now include terminal edge
alignment. The graph's minimum height permits short closed flows to align at the
bottom with only a small scroll range. Starting revision remains
`afa10b2d77db60590a9383f458b530f8aba32915`.

All 20 browser scenarios passed. These include exact terminal alignment, short
closed flows, tall windows, limited graph extents, retained click reveal behavior,
and touch gestures at both ends of each column without navigation or outer-page
scroll. Native elastic bounce appearance remains platform-dependent. The initial
clipped-card check used a graph that now fitted its viewport. The corrected check
uses a short window and asserts the card is clipped before selecting it.
Evidence is in
`.issues/evidence/flow-browser-b14b7079-8bca-4ca8-9a51-060e0432aaa5/results.json`.
Independent review found no actionable defects or comments and suppressions to
remove. Formatting and syntax checks passed. The saved-base step audit completed
with Fallow skipped by repository default. The work remains uncommitted.

## Inspector resizing follow-up

The user requested a resizable right column matching the issue sidebar. The
inspector resizes from its left edge, supports the keyboard, and remembers its
preferred width. Coupled bounds preserve the graph's minimum width. Stacked
layouts hide the inspector's horizontal resize handle.

- [x] `how` over the affected subsystem.
- [x] `architect` for parallel design exploration. The existing sidebar gives the interaction precedent. Comparison chose a shared per-panel binding over duplicate event handlers.
- [x] Write the throughput checkpoint as four todo items.
- [x] Delegate code-writing to a subagent.
- [x] Verify on the matching surface.
- [x] Rebase into small, ordered commits. Stack follow-ups. Skip. No commit request.
- [x] If the design is contested, `interrogate` before shipping. Skip. No contested design.
- [x] Run **Opening a PR**. Skip. Local preview only.

### Inspector resizing throughput checkpoint

- Blocking first steps. Inspect sidebar resize state and responsive grid constraints.
- Independent workstreams. One UI owner edits markup, styles, and handlers. The parent owns browser checks and docs.
- Shared mutable state. Both widths are browser preferences. A single layout update resolves their combined bounds.
- Smallest safe decomposition. Reuse the existing interaction through one UI owner and independent review.

Starting revision remains `afa10b2d77db60590a9383f458b530f8aba32915`.

The 21 browser scenarios passed, including inspector dragging, arrow keys,
saved width after reload, both columns at their limits across desktop breakpoints,
hidden stacked-layout handle, and unchanged graph scrolling during resize.
The viewport assertion waits for the browser's resize event before measuring the
settled layout. Evidence is in
`.issues/evidence/flow-browser-b3d6fa2d-f7cd-4a72-b9dc-156aa906ac25/results.json`.
Independent review found no actionable defects or comments and suppressions to
remove. Formatting and syntax passed. The saved-base step audit completed with
Fallow skipped by repository default. Changes remain uncommitted.

## Starting branch selector

The user requested a Starting point branch selector ordered by recent modification,
a remembered default, and every branch name when commits are shared. Branch tip
committer date defines the displayed order. Local and cached remote refs retain
their separate identities.

- [x] `how` over the affected subsystem.
- [x] `architect` for parallel design exploration. Independent source review and the parent compared overloading the delivery target with a separate starting point. The separate snapshot preserves Destination and existing delivery guards.
- [x] Write the throughput checkpoint as four todo items.
- [x] Delegate code-writing to a subagent.
- [x] Verify on the matching surface.
- [x] Rebase into small, ordered commits. Stack follow-ups. Skip. No commit request.
- [x] If the design is contested, `interrogate` before shipping. Skip. Independent review found no contested design.
- [x] Run **Opening a PR**. Skip. Local preview only.

### Starting branch throughput checkpoint

- Blocking first steps. Trace the actual checkout base and retained verification before defining the branch contract.
- Independent workstreams. The backend owns enumeration, selection, capture defaults, and checkout creation. The UI owns the selector. The parent owns tests and docs.
- Shared mutable state. The controller owns per-flow snapshots and the project default. Git refs are read without switching branches or fetching.
- Smallest safe decomposition. A shared branch contract separates backend and UI writes. Existing revision and ownership guards protect selection.

Starting revision remains `afa10b2d77db60590a9383f458b530f8aba32915`.
The flow stores `{ref, name, commit}` separately from Destination. Project defaults
remember the ref in `.issues/flows/defaults.json`; captures pin its current commit,
including retry receipts. Existing attempted or retained checkouts cannot change
their starting point. Missing defaults require restoring or explicitly replacing
the branch.

All 67 focused service, executor, and delivery checks passed. All 23 current
browser scenarios passed. They prove branch ordering, duplicate-commit refs,
saved selection, future defaults, retained dropdown focus during polling, and the
actual starting commit used by a real Git worktree. Browser execution uses an
injected executor. Explicitly cancelled GET polling requests are recorded
separately from network failures. Current browser evidence is
`.issues/evidence/flow-browser-11d37c63-39bf-4d7d-99cf-6e9144f74131/results.json`.
Independent review found no actionable defects, comments, or suppressions.

The normal preview restart helper stopped because the local queue configuration
is missing. The development server was then verified owned, paused, and idle,
with no running issues, operations, approvals, chats, or locks, before a graceful
restart on the same port. No queue configuration was created. The refreshed
backend lists 31 branch refs. Formatting and the saved-base step audit completed.
Fallow was skipped by repository default. Changes remain uncommitted.
