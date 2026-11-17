# Share the Timey issue queue across runners

[ADR 0011](../adr/0011-share-issue-reports-on-the-target-branch.md) records the branch split.

## What Git tracks

The active issue list is built from Markdown reports in `.issues/<full-issue-id>.md`. The separate Closed issues view uses `.issues/closed/<full-issue-id>.md`. See the [archive design](archive-closed-issues.md). Version-control open and unarchived closed reports on the dedicated `issue-queue` branch. Track the display-number registry (`.issues/issue-numbers.json`) alongside them so every runner sees the same issue numbers. Explicitly allowlist shared files and review existing reports before importing them into Git history. Allocate new display numbers through the shared write path so concurrent creates cannot reuse a number.

Keep `.issues/issue-work/` and `.issues/archive/` ignored by Git on every clone. Workspaces, logs, transcripts, credentials, and runtime state stay on the machine that produced them. After cutover, the code branch ignores the report cache and registry. A fresh Factory code checkout loads shared reports from the queue branch on refresh. Tracked project policy, such as `triage-labels.md`, stays with the code.

## Checkouts

The Factory checkout reads the queue into its local `.issues/` cache and prepares queue updates against the queue branch with a separate Git index. Each runner works in its own issue worktree from the approved revision. The factory uses both checkouts without switching branches. It preserves unrelated edits and stops a queue write if it cannot safely reconcile the local cache.

## Claim an issue

Use one canonical remote branch per issue, proposed as `refs/heads/claims/<full-issue-id>`. Every runner uses the same name for that issue. Put a unique attempt ID and a runner label in the claim record so a runner can recognize its own claim after an interrupted request. Keep credentials and work in progress out of the claim record.

The remote must create the branch only if it is absent. A local branch or a remote lookup followed by an ordinary push is insufficient. The runner starts only after confirming its own claim and rechecking that the latest shared report is still eligible. A conflicting claim, unavailable remote, or unresolved creation result leaves the runner idle. Display the remote claim alongside the report so the queue can show active ownership immediately.

## Publish and release

Publish report changes when an issue is created or closed, when Classic Progress ends, or when an explicit handoff needs a shared checkpoint. Save intermediate edits locally. Publish through the queue branch's configured rules and preserve concurrent changes to other reports. If the same report changed remotely, reconcile it before publishing.

A Classic Progress result and a code delivery are separate events. If a code PR remains open, record the run outcome and the PR link without implying merge or closure. Closure keeps its existing human acceptance rules. A handoff records where the next runner can find the retained work and what remains. It does not transfer a local workspace.

For a normal release, stop the old runner and confirm that the required report checkpoint is on the queue branch. Delete only the exact remote claim held by that run, so a delayed release cannot remove a replacement claim. If publication fails, show the checkpoint as pending, retain it and the claim, and require a human to reconcile the failure before releasing the claim. For a crashed runner, require explicit recovery after confirming the old run has stopped. An elapsed timer alone does not establish that.

## Human review

Every shared report update goes through a human-reviewed queue-only PR. Protect the queue branch so runners cannot push to it directly. The factory also blocks shared report and issue-number changes in its code PRs, including Full Send.

A remote claim takes effect immediately and tells other runners who owns the run. The shared report changes only when the reviewed PR lands. A runner that has stopped while its report awaits review still holds its claim.

## Verification

Use two independent clones against one test remote. Race them for one issue and verify that only the confirmed owner starts. Cover an interrupted claim response, a stale report, a failed checkpoint, an interrupted release, and a delayed release after a new claim. Verify that a fresh Factory clone loads published reports and display numbers, that files created under `.issues/issue-work/` remain ignored and never appear in the queue tree, that concurrent report edits are preserved or surfaced for resolution, and that published changes contain only the permitted queue files. Exercise normal issue delivery and closure with the configured branch rules.

Verify that queue-only PRs require human review and that Full Send cannot publish report changes through a code PR. Verify that pending review keeps the claim held and that the claim is visible before any report PR lands.

## Migration

1. Identify the authoritative report revision. For the Timey migration, use the
   checked `number_2` snapshot for report contents and numbers. Its registry
   retains all numbers assigned on `dev`. The two dev-only report copies were
   already archived on `number_2`. Preserve the two remaining backlog reports
   alongside the closed reports. Back up local edits and archives before
   changing a runner's checkout.
2. In an isolated clone with Git author details set, run
   `node /path/to/timey/scripts/prepare-issue-queue.mjs SOURCE_REVISION`.
   The script prints a parentless seed commit and an inventory. It preserves
   every selected blob and places reports whose saved state is closed under
   `.issues/closed/`. It does not update a ref, the checkout or its index.
   Compare the inventory and blob IDs with the source revision.
3. Publish the seed as `issue-queue` and verify its remote commit. Configure a
   rule for that branch that requires human approval for queue PRs. Use a
   queue PR author that cannot bypass review. The code branches retain their
   own review and CI rules. If there is only one human reviewer, give the
   Factory server a separate non-bypass bot credential through
   `TIMEY_QUEUE_GITHUB_TOKEN`. Otherwise the publisher uses the saved GitHub
   CLI login.
4. In a clean code checkout that contains the branch split, remove only the
   tracked reports and registry. Preview the paths with
   `git ls-files -- ':(glob).issues/[0-9]*.md' ':(glob).issues/closed/[0-9]*.md' .issues/issue-numbers.json`
   and use the same paths with `git rm --`. Remove the corresponding exceptions
   in `.gitignore`; keep `triage-labels.md` and `preferences.json`. Set
   `"sharedIssueQueue": true` and `"sharedIssueQueueBranch": "issue-queue"`
   in `factory.config.json`. Pass this cutover through the code destination's
   normal checks and merge policy. Do not turn the setting on in a checkout
   whose tracked report copies are still present.
5. Update clean runner checkouts so Git removes the old tracked copies. A
   staged-only removal leaves stale files that can conflict with the initial
   queue sync. Restart Factory and refresh. Confirm the closed reports and
   existing numbers in a fresh checkout and an upgraded checkout. Keep the
   source revision as the recovery copy. Historical Markdown links that name
   a moved file directly may point to its old path; issue ID references still
   identify the same report.

## Operation

The default Flow page refreshes the queue and shows pending reviews and retry
controls. Creating an issue publishes a queue PR. Each code operation acquires
the issue claim until the operation finishes. A disconnected operation retains
its claim for reconciliation. Flow records and worktrees remain local, so use
one runner for a flow while it has unpublished code. Close publishes its own
checkpoint and releases the claim only after the reviewed update lands. A
report draft can also be published from the queue status controls.

The queue periodically reads the queue branch and remote claims. **Refresh shared queue** checks immediately without changing the checked-out branch or advancing its code. Use **Publish report update** to share a deliberate local report edit. Local edits that conflict with newer reports are preserved and reported. If two new reports propose the same display number, merge one PR, then use **Refresh queue PR** in Flow or **Refresh report PR against target** in Classic on the other to allocate from the updated registry and request review of the revised PR.

If publication fails, use the issue's retry control after reviewing the failure. If a reviewer manually amended the pending PR to resolve a conflict, use **Confirm reviewed report merge** after it lands. Timey verifies the actual human-approved merge on the queue branch before releasing the claim. For an interrupted runner without a checkpoint, verify that its previous process and Git operation have stopped before using **Reconcile interrupted claim** on the owning checkout. A dead process can leave a per-issue lock in `.issues/shared-issue-claims/` or `.issues/shared-publication/`. Inspect its saved operation and remove only the confirmed dead lock before retrying. Review and merge the recovery report before releasing an active claim. Local workspaces are preserved when proposing closure and can be cleaned up separately after review.
