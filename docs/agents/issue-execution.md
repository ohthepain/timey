# Issue execution

## Strategy execution

[ADR 0009](../adr/0009-issue-strategies.md) defines the primary execution path.
Explicitly start Full Stop for a merge-ready PR or Full Send for a protected merge.
Sol Loop is optional (off, one or up to three review rounds). One owning chat and
branch carry the work without role assignments, routes or stage transitions.
Existing work stays intact and is adopted only when idle. Starting records exact
scope and destination consent. Required checks, real permissions, acceptance and
closure stay distinct. Full Stop never merges or enables automatic merging.
Failures retain their evidence and require manual attention; changed conditions
never launch another recovery. Queue order is priority, then oldest eligible issue.
The issue page exposes **Continue issue** whenever no work is running, including
before any work starts and after a blocked attempt. It starts the same issue system
prompt immediately, retaining the existing conversation and checkout for that prompt
to handle. A saved strategy and Sol setting remain fixed when continuing; the control
disables while the issue is active.

The following describes the retained legacy execution records and adapters.

Single-issue chats use the exact current issue title as their native chat name.
Creation and primary-chat reuse refresh that name from the authoritative report;
changing lifecycle roles keeps the issue name. Independent issue review chats
use the same title while retaining their separate identities and permissions.
Queue-wide and grouped chats without one issue keep their existing naming.
Rename failures are retained on the run and do not stop approved work, replace a
chat, change its permissions or dispatch another turn.

Lifecycle Progress keeps one primary work chat per issue across clarification,
planning, investigation, implementation and verification assignments. Resume that
chat at the selected task's exact isolated checkout and sandbox. Retain separate
assignment IDs, bases, evidence and integration policies. Reuse an existing idle
worker chat when adopting older records; never replace an active or uncertain chat.
Each assignment retains its exact result turn and original checkout even when
later roles reply in the same chat. Grouped manual assignments retain their own conversations. Temporary discussion
is unchanged. Required independent evidence reviews use a separate read-only chat.
After a server restart, initialize the Codex connection before reading the saved
primary chat's status. Reuse still requires a known idle chat; initialization
does not create a replacement chat or start a turn.
For a native `notLoaded` status, resume that exact chat without a turn, then read
its loaded status and require idle before dispatch. Busy and unknown states stay
blocked; loading a saved chat never permits a replacement or parallel assignment.

For settled simple work, clarification may return one executable task and its
route alongside the plan. Save the task only after the exact human plan approval,
using the normal recommendation and route validators. Changed reports or plans
invalidate it. Investigation and prototypes need a concrete uncertainty to resolve;
optional stages may be skipped with recorded reasons. Required stages, checks,
custom stages, human-first integration and final acceptance retain their guards.

Positive scope coverage is reusable only at the same plan and human receipt,
issue report, task scope/checks/policy/start, dependencies, source and instruction
contents. Corrupt or missing receipts invalidate it. Reuse does not grant an
integration approval, publication, deployment or acceptance.

Server-owned candidate checks retain their exact tree/base and hashed summaries
and raw logs. Reuse requires a clean identical tree, comparison base, verifier,
Node runtime, environment digest and pnpm installation metadata, then revalidates
the original evidence with the current validator. Failed or altered evidence is
never reused. New combined trees require checks; staged commit audits still run.
This cache does not establish current external-service, browser or human evidence.

The final independent verification review can also assess all approved plan items.
The coordinator applies the same completion compiler and PR-readiness validator
without a second model conversation. A changed candidate or plan rejects that
result. Genuine decisions are asked inline; unfinished work and proposed repairs
are retained for manual attention without automatically dispatching repair tasks.
Missing combined findings retain the ordinary review path.

Queue selection is deterministic code: priority first, then oldest eligible issue.
The shared coordinator chat is only for optional queue discussion. Issue planning
and lifecycle reviews use the issue's primary chat; independent reviews keep their
separate contexts. Failed or interrupted work stops for manual attention. Invalid
worker or review JSON is retained without another AI correction turn. Existing
explicit retry controls preserve approvals and candidate evidence.
