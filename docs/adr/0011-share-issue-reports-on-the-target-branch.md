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
on the queue branch. Runners publish queue checkpoints through queue-only
PRs and use exclusive remote claims to coordinate work. Local flow state,
workspaces and evidence stay with the runner.

The `sharedIssueQueueBranch` setting selects the queue branch. Deployments that
already enabled shared mode without that setting retain their original target.
See the [shared queue design and migration](../plans/shared-issue-queue.md).
