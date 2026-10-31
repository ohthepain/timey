# Codex-owned issue execution

Status: implementation authorized and started at milestone 1. Native creation and
registration are demonstrated; visual reopening and full verification remain
incomplete. Later milestones have not started.

The user confirmed shared understanding of the design in
[ADR 0007](../adr/0007-codex-owns-issue-conversations.md). This plan moves model
orchestration out of the factory server and into each issue's native Codex chat.
It does not claim to diagnose or fix the reported factory unresponsiveness.

## Outcome and boundaries

Saving an issue writes its report without creating a chat or calling a model.
An explicit choice to discuss or work on an issue creates its first chat, once
there is more than a title. Later discussion and work return to that same chat.
All lifecycle roles, questions, approvals, and retrospectives take place there.
Independent verification uses a subagent with findings returned to the home chat.

After plan approval and an instruction to proceed, the issue chat continues
through applicable roles. Questions, required approvals, and blockers pause it;
a role change alone does not. This is continuation by the active Codex agent,
not a new background daemon or a promise of execution after the chat stops.

The factory becomes a record and status interface. It starts or continues no model
conversations, including capture assessment, readiness assessment, temporary
discussion, plan review, and verification review. The chat can inspect, implement,
run checks, and record results with the factory HTTP server stopped.

Existing check requirements, checkout isolation, scope approval, human-first
candidate approval, publication authority, and explicit final acceptance remain
in force. Default draft-PR handoff retains its existing limited meaning. Moving
conversation ownership does not authorize publication, deployment, or closure.

## Current implementation and reusable parts

- `scripts/factory-ui/service.mjs` constructs `CodexConnection` and coordinates
  model work. `codex.mjs` starts a child `codex app-server`; its lifetime and
  in-memory requests are owned by the factory process.
- `issue-work-chat.mjs` reuses some primary chats, while `lifecycle-review.mjs`,
  `review-recovery.mjs`, and `plan-review.mjs` retain separate review paths.
  `issue-chat.mjs` and `discussion-codex.mjs` provide other server-managed paths.
- `issue-capture.mjs` invokes `capture-assessment.mjs` and can start grilling after
  saving. Capture therefore needs more than removal of a chat button.
- `scripts/factory.mjs`, `factory-record.mjs`, `factory-progress.mjs`, and
  `factory-completion.mjs` already expose local inspection and guarded writes.
  `record`, `record-checks`, and `complete` retain distinct meanings.
- `scripts/issue-delivery.mjs` exposes shared local delivery operations.
  `factory-ui/checks.mjs` already runs command-owned candidate checks.

Use these existing stores and validators. Extract reusable operations from their
HTTP/service dependencies where needed; do not copy them into a parallel workflow.
The directory name `factory-ui` need not be renamed to make an operation local.

## 1. Prove native chat handoff

Implementation progress and native smoke-test limits are recorded in the
[handoff proof](codex-native-handoff-proof.md). The proof page and local binding
commands are implemented. Native creation, registration, matching saved reopen
link, and chat accessibility with the proof server stopped are demonstrated.
Foreground native reopening remains unobserved, and broader verification retains
two failed checks; this milestone is not yet verified complete.

First deliverable: a documented, exercised path from explicit issue selection to
one visible native Codex chat, and back to that exact chat on a later visit.

Verify the installed Codex integration's supported create/open/link capabilities
using a disposable issue and an explicitly authorized test chat. Browser JavaScript
cannot assume access to tools available to the agent in this chat. Do not replace
the server's model connection with a hidden CLI client or another model service.

If direct browser handoff is unavailable, establish the supported user-mediated
handoff, such as an explicit native command, and document the additional action.
Do not present a non-working Open button or silently adopt a different architecture.
A required new integration capability is a concrete implementation blocker to
report before cutting over the UI.

Deliver an issue-to-chat binding through the existing shared record owner, with
project identity and ready or pending chat reference. Reserve creation before
dispatch; repeated clicks and uncertain replies must find the original attempt.
Unknown, busy, missing, or archived chats must never silently create replacements.
Opening a chat is distinct from asking it to start work.

Exit evidence: actual Codex visibility and same-chat reopen, plus deterministic
tests for duplicate requests, pending setup, and uncertain creation. A mocked
transport alone does not establish the native integration.

## 2. Make capture and shared operations independent of models and HTTP

Save one issue directly from the user's supplied title/description using the
existing queue contract, IDs, atomic writes, and retry identities. Preserve the
original description. If a title must be derived, use a deterministic rule rather
than a model. Routing requiring interpretation waits for the issue chat; capture
must not invent completed clarification or investigation. Keep save-only behavior
and its existing return-to-list/link feedback. An explicit discuss-after-save
choice may hand off only after the report is durably saved.

Expose missing local operations needed for plan approval, route decisions,
questions, claims, and progress through the existing CLI/shared owners. Keep exact
report/plan/source/evidence freshness and actual user-decision receipts. Ensure
the recognized issue-chat owner can write its progress without being rejected as
a competing coordinator; other owners must still be excluded.

The CLI must not require the HTTP server, instantiate a model connection, or use
the server's process lock as permission to operate. Preserve operation-specific
locks, atomic replacement, and existing guarded delivery behavior.

Exit evidence: model-free capture; guarded local operations with no listener;
stale evidence, conflicting owners, invalid approvals, and damaged records still
reject safely.

## 3. Put lifecycle coordination in the issue chat

Provide the issue-chat entry instructions through the repo's maintained skill and
documentation adapters. Review installed/shared skill ownership before changing
generated or installed files; use the supported source/install path for those.

On entry, inspect the issue report, approved plan, progress, exact checkout/base,
pending human requests, and retained evidence. Bind the current chat as the home
only through the guarded owner. A discussion request authorizes discussion;
implementation still requires its plan approval and instruction to proceed.

The active chat performs the next applicable role, uses local commands to save
its result, and continues inside approved scope. It records durable checkpoints
before long operations and on pauses. Resuming reads those records and reconciles
uncertain operations before retrying; it does not replay a completed action.
Starting another issue requires that issue's own chat and authorization.

Implementation uses the issue's isolated checkout, with recorded original base
and exact candidate. Independent reviewers are fresh subagents with bounded
read-only assignments and actual evidence access. The home chat inspects findings,
records them, and handles repairs or human input. Reviewer prose cannot replace
verification summaries or the person's acceptance. Subagent findings needed for
later sessions are saved before the transient subagent context is lost.

Exit evidence: one issue proceeds through clarification, implementation, and
independent verification in its native home chat; an interruption and restart
recover the same recorded work; the factory server is stopped throughout.

## 4. Cut over the factory UI and remove server model execution

Replace conversational Progress, discussion, answer, and review controls with the
supported Discuss/Work/Open handoff and saved status/evidence views. Questions and
plan approvals are answered in Codex. Browsing and refreshing start no work.
Record management such as saving issues and changing priority may remain local
factory operations; model reasoning and conversational decisions move to Codex.

Remove model-owning construction and reachable turn dispatch from the server,
including issue chat runtimes, lifecycle reviews, temporary discussions, capture
assessment, site-review conversations, health polling of owned turns, and recovery
or deployment paths that assume server-owned model work. Audit all HTTP routes,
not just the currently visible buttons. Legacy conversational endpoints must give
an explicit migration response and must never start work for older clients.

Retain historical transcripts, decision receipts, raw logs, and evidence readers.
Keep deterministic delivery/check functions available through shared local owners.
Refresh status from those stores after external chat writes; distinguish saved
observations from live native chat status and identify stale/unknown status honestly.

Exit evidence: the server's complete request surface starts no model process or
model conversation; former model endpoints cannot bypass this; capture, queue
browsing, priorities, evidence links, and issue chat links work in the rendered UI.

## 5. Migrate existing issues and adopt the new runtime

Produce a preview mapping of issues to candidate home chats, active work,
checkouts, unresolved operations, and retained evidence. Prefer a known existing
primary chat where it is usable; conflicting or uncertain identities require
reconciliation rather than a guessed replacement.

Adopt one home chat per issue at a safe stopping point. Save a concise handoff with
the approved plan, actual completed work, pending questions, exact revisions,
evidence links, and earlier chat references. Preserve other chats as history;
do not attempt to fabricate a merged native transcript, delete old chats, or treat
their assertions as newly verified evidence. Migration records no new acceptance.

Use existing drain/restart safeguards for the old server. Retain active reservations
and integration locks until their owning operations are settled. A failed migration
leaves a diagnosable record and must not dispatch duplicate work. Reverting the UI
must not resume legacy model orchestration for an issue already adopted by Codex.

Update `docs/agents/factory.md`, `operating.md`, `factory-ui.md`,
`issue-execution.md`, `factory-records.md`, `verification.md`, and `codebase.md`
alongside their affected implementation. Mark replaced runtime rules explicitly;
keep ADR 0003 as historical rationale with a pointer to ADR 0007. Update the repo
factory skill's role/launch instructions to enforce the one-home-chat boundary.

## Verification and acceptance

Use disposable queues/checkouts for deterministic coverage, extending existing
workflow and chat suites rather than creating another test runner. Required cases:

1. Saving title/description makes no model call and creates no chat; retries save
   once. Discuss/Work creates once and later actions reuse the binding.
2. Concurrent opens, unknown creation outcomes, active home chats, and competing
   coordinators cannot create parallel issue execution.
3. Exact-plan continuation pauses for genuine input and human-first approval;
   changed scope and stale evidence cannot inherit authority.
4. Local progress/check/completion/delivery commands work without HTTP, retain
   candidate/base evidence, and remain visible after the factory restarts.
5. Independent review findings return to the same chat and are retained with
   actual evidence; no separate top-level verification chat is launched.
6. Migration preserves original references, questions, results, and locks and is
   repeatable without replaying completed work.
7. All old model routes are disabled after cutover, including capture and less
   visible review paths. Static dependency checks complement runtime assertions.

Run focused existing checks during each slice, then `pnpm run test:workflow`, the
adapted `pnpm run test:chat`, `pnpm run test:factory`, and required rendered-browser
checks for affected controls. Finish with `pnpm run verify -- --base <start>` and
`pnpm run audit:step -- --base <start>` against the actual recorded starting
revision, retaining command-owned summaries and raw logs. Resolve failures or
report partial work accurately; do not weaken checks to accommodate the move.

Native acceptance demonstration: save an issue without a chat; explicitly enter
discussion; approve a bounded plan and proceed; stop the factory server; continue
implementation, verification subagent, questions, and a retro in that same Codex
chat; restart the factory and inspect saved results and the same chat link.
Passing fixtures alone does not prove this interaction or human acceptance.

Implementation order is 1 through 5. The first milestone proves the external
handoff before broader changes. No workers, issue migrations, commits, publication,
or deployment are started by writing this plan. Unrelated working-tree changes
remain outside this assignment.
