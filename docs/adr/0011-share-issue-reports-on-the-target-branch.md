---
status: accepted
---

# Share issue reports on a dedicated branch

Timey runners share Markdown reports and display numbers through a dedicated
`issue-queue` branch. Issue updates previously advanced the code delivery branch.
Factory then advertised a branch update to other issues and checked a new
candidate at Merge, even when the only change was a report.

Keep code delivery, verification and branch protection tied to the issue's
code destination. Keep open and closed reports and the display-number registry
on the queue branch. Timey runners publish queue checkpoints as direct commits
using the Factory GitHub App. Exclusive claims now live on that same branch,
as recorded in [ADR 0019](0019-share-issue-claims-on-the-queue-branch.md). Local flow state,
workspaces and evidence stay with the runner.

The `sharedIssueQueueBranch` setting selects the queue branch. Shared mode requires an explicit dedicated branch and refuses to fall back to
the code delivery target.
See the [shared queue design and migration](../plans/shared-issue-queue.md).
