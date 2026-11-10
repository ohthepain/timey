# Separate issue closure, cleanup, and deletion

## Outcome

Users can close an issue immediately, run and save a retro while the issue's
conversation is available, clean up dependent resources later, and permanently
delete the issue once cleanup is complete. Accepting a fix is a separate decision.

The user confirmed this design. Implement it from the Timey repository root.
Start by checking the current branch and diff. Preserve unrelated local changes
and use disposable fixtures for tests. This plan supersedes the coupled acceptance
and closure behavior described in [Direct issue acceptance and closure](direct-issue-closure.md).

## Action contract

| Action | Effect and conditions |
| --- | --- |
| **Close issue** | Write the configured Closed state. A reason is optional. Checks, acceptance, and active work do not block closure. The current action can finish or be stopped explicitly. Closed issues cannot start or continue implementation work or automatically dispatch a subsequent action. |
| **Accept fix** | Record explicit human acceptance independently of issue state. Allow it on open or closed issues when retained evidence satisfies the existing acceptance checks. Preserve the saved-PR recovery path and show the concrete blocker when acceptance fails. |
| **Run retro** | Use the saved issue conversation after closure. Let the user save the retro to the issue report before removing the conversation. The report and saved retro survive cleanup and reopening. |
| **Clean up** | Preview and remove explicitly selected dependent resources for a closed, idle issue. Record each outcome in **Cleanup results**. Allow later cleanup of skipped resources and retries of individual unresolved resources. |
| **Reopen issue** | Reopen any closed issue that still exists. Keep the report, saved retro, and cleanup history. Create a fresh work folder when implementation next starts if the old folder was removed. |
| **Delete issue** | Require a separate confirmation and fresh server-side proof that the issue is closed, idle, and has no remaining dependent resources. Permanently remove the report and issue-specific records. Keep the issue number reserved. |

Closing never starts acceptance, verification, cleanup, or chat archival. It also
does not cancel a stopped or running action. Accepting a fix never changes the
issue state. Keep prior acceptance and closure records readable.

## 1. Split Close from Accept fix

- Separate the Close, Reopen, and Accept fix paths in
  [issue-decision.mjs](../../scripts/factory-ui/issue-decision.mjs),
  [http.mjs](../../scripts/factory-ui/http.mjs), and
  [index.html](../../scripts/factory-ui/index.html). Keep the existing session and
  request freshness checks. A stale request may ask the user to refresh and retry.
- Move fixed acceptance validation, approval recording, and merged-PR recovery
  into Accept fix. Reuse the existing evidence and human-input checks. Close
  should need only the current report and configured Closed state.
- Audit server entry points for work starts and continuation, including automatic
  follow-on actions. Reject new implementation work on a closed issue. Let an
  already-running action retain its result without advancing or reopening the
  issue. Keep explicit Stop available while work is active.
- Keep **Run retro** available when the saved conversation is present. Offer a
  way to save the result to the issue report. After conversation cleanup, explain
  that the full conversation is gone and show the saved retro if one exists.
  Avoid creating an empty replacement conversation for a retro on a cleaned issue.

## 2. Make cleanup an independent operation

- Reuse the preview, identity checks, cleanup ledger, and retries in
  [issue-cleanup.mjs](../../scripts/factory-ui/issue-cleanup.mjs). Move initial
  cleanup execution out of the Close handler. Guard both initial execution and
  retries on the server. Active implementation, chat, retro, and held operation
  locks block cleanup.
- Build one inventory for cleanup and deletion. Include the issue's local and
  remote branches, current work folder, legacy delivery checkouts, and any
  project-level local transcript. Derive candidates from saved identities and
  known issue-owned paths. Check ownership before removing anything. Report
  shared, protected, dirty, active, or unverified resources with the reason they
  remain.
- Show work-folder presence using a local filesystem metadata check. Render that
  result without waiting for Git status, branch lookups, chat checks, or recursive
  size calculation. Run those checks separately and revalidate safety immediately
  before removal. A positive presence result does not imply safe removal.
- Fold conversation cleanup into the work-folder operation. Account for
  [legacy project-level transcripts](../../scripts/factory-ui/conversation-store.mjs)
  even when an issue never had a checkout. Follow the existing native Codex chat
  archival policy for linked chats. The native app owns its chat history. Factory
  removes local transcripts and archives eligible native chats as part of cleanup,
  without a separate chat selection.
- Keep the report, acceptance record, saved retro, and required evidence outside
  the folders being removed. Reuse the existing evidence preservation checks.
- Persist each resource's outcome outside the work folder as it completes. Show
  removed, already absent, skipped, preserved, failed, and unknown outcomes in
  **Cleanup results**, with the reason where applicable. A per-resource retry
  replaces that resource's current result and leaves other rows intact. A fresh
  cleanup can select previously skipped resources. Recover interrupted operations
  by rechecking live state before retrying a removal.

## 3. Add permanent deletion and make reopening safe

- Use the same inventory to determine deletion eligibility. Recheck live state
  at execution time. Removed and already absent resources count only when their
  absence is confirmed. A recreated resource, failed lookup, held lock, or
  unresolved cleanup blocks deletion. Show the specific blocking resource.
- Show a confirmation that names the issue and explains that deletion removes
  its report, saved retro, and issue-specific records. Under the existing
  server ownership controls, serialize cleanup, reopen, and delete for the same
  issue. Recheck report identity, closed state, and the inventory under the guard.
- Remove exclusively issue-owned records, including cleanup results, lifecycle
  and delivery metadata, and issue-owned retained evidence. Review the actual
  storage owners before implementing deletion. Shared ledgers, records, and
  evidence may serve other issues. Remove only this issue's associations from
  those stores. Keep the ID-to-number mapping in
  [issue-numbers.mjs](../../scripts/factory-ui/issue-numbers.mjs) so old links
  cannot resolve to a different issue.
- Make interrupted deletion resumable. Keep the report until its issue-owned
  records have been removed, with enough operation state to finish a retry.
  After successful deletion, remove the operation state and return to the queue.
  Old issue URLs show that the issue is unavailable.
- Preserve reopening after partial or complete cleanup. If cleanup is in flight,
  finish the current cleanup operation before reopening. After reopening,
  revalidate any saved branch or checkout before reuse. Fresh resources must
  appear in the next cleanup inventory even if an earlier cleanup removed
  resources with the same name.

## Verification for handoff

Use the existing Factory decision, strategy, cleanup, chat, and issue-number
fixtures. Add browser coverage for the full **Close → Run retro → Clean up →
Delete issue** flow, plus reopening after cleanup. Exercise the following cases.

- Close an issue with failing checks, an unreviewed result, and active work. The
  report becomes closed, no cleanup or acceptance starts, and the active action
  can finish or be stopped. A new action cannot start.
- Accept a fix on an open and a closed issue. Success records acceptance without
  changing state. Failing evidence and a missing required approval report the
  blocker. Saved-PR recovery runs only on acceptance.
- Save a retro after closure, then remove the work folder. Verify the report and
  saved retro survive and the full conversation is unavailable after cleanup.
- Delay remote lookup, Git safety inspection, and size calculation independently.
  Verify the work-folder presence appears before any of them resolves.
- Exercise current and legacy folders, a transcript with no checkout, skipped
  resources, partial failures, and item-level retries. Verify unrelated cleanup
  results survive retries and a server restart.
- Reject deletion for active work, protected resources, an unknown remote result,
  and a resource recreated after preview. Verify confirmed absence permits
  deletion, interrupted deletion can resume, shared records survive, and the
  deleted issue number is never reused.
- Reopen after cleanup and start work in a fresh folder. Verify the old report,
  saved retro, and cleanup history are still available.

Run the relevant Factory and browser checks and the required audit checkpoint.
Follow the [verification guide](../agents/verification.md). Update the Factory UI
guide, tracker conventions, glossary, and affected ADRs alongside the implementation.
