# Close and Cleanup in the issue flow

Agreed design for the Factory issue flow.

## Agreed behavior

- Close and Cleanup run as a separate sequence in the same issue flow.
- Confirming Close in the UI starts the sequence with the selected reason.
  Flow opens the dialog with the reasons and issue details from the loaded
  issue view. Confirmation rechecks current issue state before recording the
  decision. The dialog is ready without discovering cleanup resources. Cleanup
  attempts to remove the eligible worktree for every closure reason. Manual
  Close waits for active work to finish or be stopped explicitly.
- You can dismiss the dialog while Factory waits for the confirmation response.
  Dismissing leaves the submitted request in progress. If Flow receives no
  response within 30 seconds, it reloads the issue so you can check its saved
  status before retrying.
- To delete a branch with unmerged work, select that branch explicitly after
  reviewing what work its deletion would discard. The separate Cleanup dialog
  identifies each affected branch and the unmerged work at risk. Cleanup rechecks resource
  identity, ownership, and safety before deleting anything.
- Automatic closure requires an explicit opt-in for the issue. It records
  Fixed after Factory's Merge block succeeds and the existing requirements
  for Fixed are satisfied. A merge outside Factory requires manual Close.
  With auto-close off, the delivery sequence ends at Merge. The flow shows a
  **Close issue…** button before the Close block and explains that closing is
  manual. The button opens the existing closure confirmation and remains
  available after Merge. With auto-close on, this manual prompt is hidden. After closure, the merged notice no longer asks for Close.
  The opt-in covers
  one delivery and includes removal of the eligible worktree. Later Cleanup
  can remove either branch with explicit selection. You can revoke the opt-in
  before automatic Close starts. Reopening clears it.
- Close saves the disposition before Cleanup starts. A failed deletion leaves
  the issue Closed. Cleanup retains each resource's result and can retry an
  incomplete deletion without repeating Close.
- In the Close dialog, **Run Retro before Cleanup** starts with the issue's
  Request setting for Fixed and starts unchecked for every other reason.
  You can change it for this closure.
- You can use **Worktree → Delete** while the issue is idle, even if a saved
  closure step is incomplete. Active work, Retro, or Cleanup still blocks
  deletion. The confirmation asks you to discard uncommitted changes. Timey
  preserves the branch and recreates the checkout from it when needed.

## Prior decisions affected

The [separate closure and cleanup plan](separate-issue-close-cleanup-delete.md)
keeps the conversation available for a retro between closing and cleaning up.
For issues that opt into Retro, the [issue retros design](issue-retros.md) adds
Retro between Close and Cleanup. A failed Retro holds Cleanup until the user
retries Retro or chooses to continue to Cleanup.

The [direct closure design](direct-issue-closure.md) records explicit acceptance
when a person confirms Fixed closure. Opting in to automatic closure supplies
that acceptance in advance, conditional on the delivery satisfying the existing
requirements for Fixed.

## Verification cases

`node scripts/flow-browser.mjs --manual-close` checks the manual button's
placement, an open issue after Merge, the existing confirmation and cancellation,
and automatic Fixed closure without a prompt. It uses a fixture executor for
external Merge and Cleanup operations.

- Confirm manual Close with a non-Fixed reason while cleanup discovery is unavailable.
  Check that the issue closes, Cleanup removes the eligible worktree, and
  both branches remain.
- Select an unmerged local or remote branch. Check that the dialog identifies
  the unmerged work before confirmation. Change the selected branch after
  preview and check that Cleanup preserves it.
- Exercise an active operation, a failed Close, and a dirty worktree. Check
  that active work blocks manual Close, failed Close blocks Cleanup, and
  Cleanup preserves the dirty worktree.
- Exercise auto-close with opt-in on, off, and revoked. Check the Fixed reason,
  human check requirements, retained branches, and opt-in reset on reopening.
  Merge the PR directly on GitHub and check that the issue stays open.
- Fail one selected deletion after another succeeds. Check that the issue
  stays Closed and that retry targets the incomplete resource.
