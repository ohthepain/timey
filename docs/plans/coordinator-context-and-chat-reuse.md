# Coordinator context and chat reuse

Status: implemented; focused verification passed. All interview decisions
are settled. This preserves ADR 0007’s distinction between the shared coordinator
conversation and each issue’s own conversation.

## Requested outcome

Reduce the coordinator prompt and reuse its chat for longer. Read relevant local
issue information when needed instead of copying the queue’s reports and plans
into every turn. Make coordinator titles understandable. When replacement is
necessary, retrieve current facts and preserve continuity without accumulating
visible predecessor chats.

## Verified current behavior

- Each turn includes every lifecycle record, including full plans and approvals.
  Replacement-chat handoffs contain a second copy of those records.
- Selected-issue context and operation prompts can repeat the report and plan.
- Coordinator reads run locally at the repository root in a read-only sandbox.
  Reports, plans and issue transcripts already exist as local files.
- The coordinator replaces chats at 20 turns, 120,000 counted characters or
  80,000 reported total tokens. Those are not measurements of remaining context.
- The installed app-server schema exposes chat compaction, last/total token usage
  and an optional model context-window size. The coordinator does not use them.
- Issue chat naming uses thread/name/set; coordinator startup does not name chats.

## Agreed design

- Each operation receives a small purpose/identity envelope and local source
  references. Queue-wide work gets a compact index. The coordinator reads current
  issue records, approved scope and relevant evidence when needed; full reports,
  plans, approvals and transcripts are not repeatedly embedded in prompts.
- Reuse a chat within a modest working-context budget, then rotate to a fresh chat
  well before the model needs compaction. Rotation happens at a safe operation
  boundary. Large accumulated histories are not a design goal, even when the
  model has room for them. Routine compaction is not part of this workflow.
- Carry only compact working notes: useful computed findings and reasoning that
  are costly to reconstruct, with references to their supporting inputs. Exclude
  copied source records, chat transcripts and routine progress narration.
- Revalidate findings when supporting inputs change, recomputing only affected
  analysis. Current source records take precedence. Notes neither supply missing
  approvals nor grant authority.
- A fresh chat reads working notes and current source references; it does not
  replay the predecessor or receive a summary of its entire conversation.
- Once continuation is established, archive the predecessor. Keep the audit trail
  retrievable for retrospectives, outside normal decision context and active-chat
  views. Apply this to existing inactive coordinator predecessors too.
- Explicitly name the active chat “Timey coordinator”; date archived predecessors.
- Preserve the existing read-only coordinator and operation-specific approval
  boundaries. Missing source facts are investigated; unavailable required records
  block only decisions that depend on them.

## Interview decisions

The user accepted small prompts with local references, explicit titles and
archiving; then clarified that only computed findings need to carry forward.
They accepted retaining useful derived analysis and refreshing only findings
whose inputs changed. Their final clarification supersedes compact-first and
near-limit reuse: move to a new chat long before compaction is necessary.

## Working-context budget

Start at approximately 20,000 tokens of current working context, tunable after
observing normal operations. Use current context measurements rather than
cumulative token billing. When measurements are unavailable, use a conservative
text-size estimate that includes observed tool output as well as prompts and
responses. Rotate between operations; never interrupt an operation merely because
it crosses the budget. Keep prompts small enough for several useful operations
per chat and rotate long before compaction becomes necessary.

The user accepted this final budget recommendation. No design questions remain.
See [the architecture decision](../adr/0008-coordinator-working-notes.md).

## Implementation verification

Use focused protocol fixtures to establish that successive small operations reuse
one chat, current-context pressure causes one safe replacement, cumulative billing
alone does not cause rotation, and replacements receive only working notes and
source references. Check title assignment, archive-after-ready ordering, source
freshness and preservation of real approval boundaries. Retained reports and
approval receipts remain authoritative; fixture success is not live-provider
proof. Focused protocol and rendered-browser verification cover the implementation.
No full regression pass or live-provider behavior is claimed.

## Verification result

The coordinator protocol suite passes 13 tests, including source freshness,
replacement failure, archival failure, native RPC naming/cancellation, no-inference
maintenance, and actual evaluation-path prompt size with large local records.
The affected Clarify, short-path and recovery cases passed (40 tests in the
combined run before the final maintenance additions), as did 14 selected lifecycle
compatibility cases. The coordinator browser scenario passed against a disposable
fixture, including archived-history visibility. The configured saved-base step
checkpoint passed with Fallow skipped by project policy. No full regression or
live-provider functional pass is asserted.
