# Share the Timey issue queue across runners

Draft for discussion. [ADR 0011](../adr/0011-share-issue-reports-on-the-target-branch.md) records the proposed architecture.

## What Git tracks

The issue list is built from the Markdown reports in `.issues/<full-issue-id>.md`. Version-control those reports on the configured target branch, normally `dev`. Track the display-number registry (`.issues/issue-numbers.json`) alongside them so every runner sees the same issue numbers. Explicitly allowlist shared files and review existing reports before importing them into Git history. Allocate new display numbers through the shared write path so concurrent creates cannot reuse a number.

Keep `.issues/issue-work/` and its entire contents ignored by Git on every clone. Workspaces, logs, transcripts, credentials, and runtime state stay on the machine that produced them. Replace the current blanket exclusion of `.issues/` with repository ignore rules that expose only the approved shared files. A fresh clone of the target branch gets the issue list and its history without downloading another runner's workspace.

## Checkouts

The target checkout reads the shared queue and prepares queue-only updates. Each runner works in its own issue worktree from the approved revision. The factory uses both checkouts without switching branches. It preserves unrelated edits and stops a queue write if it cannot safely reconcile the target checkout.

## Claim an issue

Use one canonical remote branch per issue, proposed as `refs/heads/claims/<full-issue-id>`. Every runner uses the same name for that issue. Put a unique attempt ID and a runner label in the claim record so a runner can recognize its own claim after an interrupted request. Keep credentials and work in progress out of the claim record.

The remote must create the branch only if it is absent. A local branch or a remote lookup followed by an ordinary push is insufficient. The runner starts only after confirming its own claim and rechecking that the latest shared report is still eligible. A conflicting claim, unavailable remote, or unresolved creation result leaves the runner idle. Display the remote claim alongside the report so the queue can show active ownership immediately.

## Publish and release

Publish report changes when an issue is created or closed, when Progress ends, or when an explicit handoff needs a shared checkpoint. Save intermediate edits locally. Publish through the target branch's configured rules and preserve concurrent changes to other reports. If the same report changed remotely, reconcile it before publishing.

A Progress result and a code delivery are separate events. If a code PR remains open, record the run outcome and the PR link without implying merge or closure. Closure keeps its existing human acceptance rules. A handoff records where the next runner can find the retained work and what remains. It does not transfer a local workspace.

For a normal release, stop the old runner and confirm that the required report checkpoint is on the target. Delete only the exact remote claim held by that run, so a delayed release cannot remove a replacement claim. If publication fails, show the checkpoint as pending, retain it and the claim, and require a human to reconcile the failure before releasing the claim. For a crashed runner, require explicit recovery after confirming the old run has stopped. An elapsed timer alone does not establish that.

## Human review

Every shared report update goes through a human-reviewed PR. The factory can prepare a queue-only PR, or include the update in a code PR when the report can wait for that merge. Keep direct target pushes unavailable to runners and require human review on either path, including when a code PR carries a report update under a strategy that would otherwise allow review bypass.

A remote claim takes effect immediately and tells other runners who owns the run. The shared report changes only when the reviewed PR lands. A runner that has stopped while its report awaits review still holds its claim.

## Verification

Use two independent clones against one test remote. Race them for one issue and verify that only the confirmed owner starts. Cover an interrupted claim response, a stale report, a failed checkpoint, an interrupted release, and a delayed release after a new claim. Verify that a fresh clone of the target contains published reports and display numbers, that files created under `.issues/issue-work/` remain ignored and never appear in the target tree, that concurrent report edits are preserved or surfaced for resolution, and that published changes contain only the permitted queue files. Exercise normal issue delivery and closure with the configured branch rules.

Verify that queue-only PRs and code PRs carrying report updates cannot publish without human review, including through Full Send. Verify that pending review keeps the claim held and that the claim is visible before any report PR lands.
