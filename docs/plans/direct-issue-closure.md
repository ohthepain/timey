# Direct issue acceptance and closure

## Agreed decision

On 2026-10-30 the user confirmed that lifecycle stages are no longer execution
requirements. “Accept fix and close” should be available directly on an open issue,
without moving it through the old final-review stage. The click supplies human
acceptance; code validates the existing required evidence and records closure.

The implementation replaces the final-review stage prerequisite in the tracker
adapter. It does not
change what constitutes a passed check or grant acceptance to a strategy worker.

## Behavior

- Closing is a deterministic operation with no AI calls, worker launches, new
  verification runs, or intermediate lifecycle transitions.
- Fixed closure records the person's acceptance of the retained result. Existing
  required technical checks, actual human observations, evidence integrity and
  outstanding worker-result review still apply. Unknown or failed checks do not
  become passing checks because the person clicks Close.
- Show the precise outstanding requirement when closure cannot proceed. Do not
  route the person through Progress, the coordinator or an AI review to explain it.
- Active issue work must finish or be stopped explicitly before closure. Closing
  does not silently cancel work, merge, publish, deploy or delete a branch/chat.
- Other configured closure reasons preserve unfinished work and failed checks
  without claiming a fix or acceptance.
- Show immediate pending feedback, prevent duplicate submissions, and confirm the
  saved closure as soon as its request succeeds. Conversation loading must not
  delay that confirmation.
- Keep configured Closed state storage and retained history. Historical stage
  position does not determine whether the person may accept a result.

## Current implementation findings

The existing `selectIssueDecision` → `/api/issue-decision` → `decideIssue` path
already contains no AI calls. The UI hides Fixed outside final review, and the
backend separately requires both the final-review role and its next-state edge.
These gates need removal rather than a new closing workflow.

Queue inspection is repeated during closure and after individual acceptance
judgments. Evidence can be read/hashed twice. The UI awaits a full refresh,
including conversation retrieval, after saving. These are source observations,
not measured timing results; measure before choosing further optimizations.

## Verification

Verify closure from non-final historical states with valid retained evidence and
explicit human input. Verify missing/failed checks, altered evidence, outstanding
worker results and active work still block with concrete messages. Verify other
closure reasons do not invent acceptance. Verify no AI/test call occurs, repeat
submission does not duplicate records, and slow conversation retrieval does not
hold back saved-closure feedback.

## Implementation verification

The focused closure and acceptance run passed 27 tests, including retained legacy
results, direct acceptance outside final review, failed-check rejection, evidence
integrity, outstanding work, and UI confirmation during slow conversation loading.
All seven disposable browser scenarios passed, including exact blocker display and
successful close after an explicit retry. No live issue was accepted by these tests.
