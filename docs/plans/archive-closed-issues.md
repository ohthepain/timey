# Separate closed issues from the active queue

Investigations use the [direct archive lifecycle](project-home.md#investigation-lifecycle-and-repeated-runs):
open investigations can move directly to Archive without closure, and Restore
returns them open with their history and Reusable setting preserved. The closed
report requirements below continue to apply to other issue types.

Agreed design.

## Issue locations

| View          | Report location                 | Purpose                                                 |
| ------------- | ------------------------------- | ------------------------------------------------------- |
| Issue queue   | `.issues/<issue-id>.md`         | Open issues for prioritization, review, and scheduling. |
| Closed issues | `.issues/closed/<issue-id>.md`  | Closed reports available to browse and archive.         |
| Archive       | `.issues/archive/<issue-id>.md` | Closed reports retained locally outside Git tracking.   |

Closure keeps its existing acceptance and dismissal rules. Move the report to the closed folder once closure takes effect. Preserve the full issue ID, display number, report body, and closure reason. Existing closed reports move into the same folder through a one-time migration. Keep archived display numbers reserved.

## Queue cost

Routine queue reads, scheduling, and model prompts use the open queue. Load closed report bodies on demand when a person opens a report or work explicitly needs a specific closed issue as evidence. A dedicated Closed issues view shows all closed, unarchived reports. Open, Closed, and Archive links sit beside the heading. On macOS, the Finder shortcut opens the current folder. A list can read the metadata it needs without sending the reports to a model.

At the time of design, the local checkout held 105 closed reports totaling about 2.4 MB and 14 open reports totaling about 32 KB. These are file sizes. Actual model savings depend on which queue reads feed a prompt.

## Archive

A person initiates archive from the Closed issues view. Application code validates that the report is closed, preserves it in the local archive folder, and refreshes the list. The operation starts zero model calls. It preserves the issue number and leaves the report closed. An in-progress closure sequence continues after archive. The Archive list links to the saved flow, which shows progress and provides manual Cleanup for an idle issue.

For a shared closed report, the proposed flow saves the local archive copy first, then prepares a report-only PR to remove the shared copy from the target. Until the PR lands, the shared report remains closed and the initiating runner shows the archive as pending. Previously published copies remain available in Git history. The local archive copy is available on the runner that performed the archive.

## Agreed behavior

- Offer an Archive action per report and an Archive selected action in the Closed issues view.
- **Archive selected** opens a progress dialog when two or more closed issues
  are selected. The dialog follows the current issue and processed count from
  the server. It stays open until dismissed and reports how many issues were
  archived, any awaiting review, and any individual failures.
- Provide a local Archive view with Restore to closed. Reopening is a separate explicit action.
- Admin can permanently delete reviewed local archive copies in one batch. A
  person can also select eligible local branches associated with those reports.
  This operation preserves display numbers and leaves issue worktree and
  conversation cleanup to their existing controls.
- Use a human-reviewed PR when closure moves a tracked report or archiving removes one. In a local queue, apply both moves directly.
- Choose which closed reports should stay local in the Closed issues view before publishing the initial import. Use `pnpm factory issue-storage-export /path/to/local-review-checkout` to regenerate the candidate after archiving. The export copies the open and closed reports and the display-number registry. Archived issue numbers stay reserved.

## Verification

The factory-provided `archive` skill lives under `factory/system/skills/archive`.
It accepts a list such as `$archive 11 12 13` and submits one `issue_archive` call
with `issueNumbers`. Storage controls read the number registry once and remove
duplicates. Unknown numbers are rejected before any selected report is moved.
For batches up to the existing 500-item limit, the model need not query reports
or dispatch separate archive calls. Larger selections use bounded batches.
Each issue retains its existing eligibility checks, shared-queue claim and
publication behavior, and result. This is one guarded batch request, not a new
all-or-nothing transaction across independently published issue reports.

Bulk archive/restore yields to the server between reports, so it can handle
other requests during a long selection. Each report's existing Git operation is
still synchronous. Running storage batches are counted for restart readiness,
including when the initiating chat has stopped, so a reload waits for retained
storage work to finish.

Check that moving an issue between folders preserves its ID, display number, and content. Verify that routine queue reads and prompts skip closed and archived report bodies, while the Closed issues view can open each report. Test archive and restore without a model connection, including interrupted moves, destination conflicts, and repeated requests. Verify that a pending shared archive preserves a local copy and that the archive folder stays ignored in a fresh checkout.

Run `pnpm factory issue-storage-migrate` once on the local queue before the initial import. It moves existing closed reports into the Closed issues view. Leave shared mode disabled until the reviewed import is ready.
