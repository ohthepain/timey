---
status: proposed
---

# Share issue reports on the target branch

Timey runners need a shared queue and a way to take exclusive ownership of an issue without publishing every progress update. Version-control `.issues/<full-issue-id>.md` reports and shared queue metadata on the configured target branch, normally `dev`, and publish at queue milestones. Keep `.issues/issue-work/` ignored by Git on every runner and use a remote branch created exclusively for each active issue claim. This lets a claim become visible immediately while report updates land through human-reviewed pull requests. Runners prepare updates on branches and the protected target receives them through those reviews.

The factory uses a target checkout for the queue and separate issue worktrees for execution. See the [shared queue design](../plans/shared-issue-queue.md).
