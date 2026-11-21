# Share the Timey issue queue across runners

[ADR 0011](../adr/0011-share-issue-reports-on-the-target-branch.md) records the branch split.

## What Git tracks

The active issue list is built from Markdown reports in `.issues/<full-issue-id>.md`. The separate Closed issues view uses `.issues/closed/<full-issue-id>.md`. See the [archive design](archive-closed-issues.md). Version-control open and unarchived closed reports on the dedicated `issue-queue` branch. Track the display-number registry (`.issues/issue-numbers.json`) alongside them so every runner sees the same issue numbers. Explicitly allowlist shared files and review existing reports before importing them into Git history. Allocate new display numbers through the shared write path so concurrent creates cannot reuse a number.

Keep `.issues/issue-work/` and `.issues/archive/` ignored by Git on every clone. Workspaces, logs, transcripts, credentials, and runtime state stay on the machine that produced them. After cutover, the code branch ignores the report cache and registry. A fresh Factory code checkout loads shared reports from the queue branch on refresh. Tracked project policy, such as `triage-labels.md`, stays with the code.

## Checkouts

The Factory checkout reads the queue into its local `.issues/` cache and prepares queue updates against the queue branch with a separate Git index. Each runner works in its own issue worktree from the approved revision. The factory uses both checkouts without switching branches. It preserves unrelated edits and stops a queue write if it cannot safely reconcile the local cache.

## Claim an issue

Use one canonical record per issue at `.issues/claims/<full-issue-id>.json` on
`issue-queue`. Reports already include lifecycle state in their YAML metadata.
Reports, statuses, display numbers, and claims share one branch. Local report
files remain an ignored cache, and local-only queues continue using files.

A version 2 claim contains a unique attempt ID, issue ID, runner label, remote,
and queue branch. Its blob object ID identifies the exact ownership record.
The runner saves its local intent before publishing. It reads the queue tip,
checks claim absence, and commits the new record as a direct child of that tip.
The push checks the exact expected remote tip. A competing update causes a fresh
read and revalidation, with at most three attempts per operation. The runner
starts only after confirming its current ownership and rereading the report to
check that it is still eligible. A failed or unresolved request retains local
recovery information and starts no work.

Release removes only the record whose blob ID matches the saved claim. A delayed
release cannot remove a replacement owner. Claims have no automatic expiry.
Direct report checkpoints remove their owned claim in the same commit as the
report update. A landed commit and its parent prove that exact release even if
the response was lost or a later run now holds another claim.

Before upgrading writers, stop old runners and reconcile their outstanding claims
and queue PRs with the previous version. New claim acquisition refuses any remaining
`refs/heads/claims/*` branches, and old local claim receipts require explicit
reconciliation. Block creation of legacy claim branches in the remote rules after
cutover. Do not operate old and new claim writers concurrently.

## Publish and release

Publish report changes when an issue is created or closed, when Classic Progress ends, or when an explicit handoff needs a shared checkpoint. Save intermediate edits locally. Publish through the queue branch's configured rules and preserve concurrent changes to other reports. If the same report changed remotely, reconcile it before publishing.

A Classic Progress result and a code delivery are separate events. If a code PR remains open, record the run outcome and the PR link without implying merge or closure. Closure keeps its existing human acceptance rules. A handoff records where the next runner can find the retained work and what remains. It does not transfer a local workspace.

For a normal release, stop the old runner and confirm that the required report checkpoint is on the queue branch. Remove only the exact queue claim held by that run, so a delayed release cannot remove a replacement claim. If publication fails, show the checkpoint as pending, retain it and the claim, and require a human to reconcile the failure before releasing the claim. For a crashed runner, require explicit recovery after confirming the old run has stopped. An elapsed timer alone does not establish that.

## Direct publication

Set `"sharedIssueQueueDirect": true` with a dedicated `sharedIssueQueueBranch`.
Factory builds the report commit on the latest queue tip and sends a normal Git
push authenticated by the Timey Software Factory GitHub App. The App needs
repository contents write permission. Factory recalculates display numbers if
another report lands first and stops if the same report changed. It stores the
candidate before pushing and confirms that exact commit is in the queue history
before releasing the claim. Code PRs still exclude shared reports and numbers.
Each report or claim check fetches the queue branch directly into a private
worktree ref without updating the checked-out branch, remote tracking branches,
or `FETCH_HEAD`. Metadata writes use a private index and never change source HEAD,
the source index, staged code, or unstaged source edits. The App push helper allows
only report, number, and claim paths and requires the exact expected queue parent.

In GitHub, add an active ruleset targeting exactly `issue-queue`. Enable
**Restrict updates** and give Timey Software Factory an **Always allow** bypass
in that ruleset. Keep force pushes and deletions blocked under a separate rule
that the App cannot bypass. Once the writer restriction is active, remove the
queue branch from any shared PR rulesets and turn off the classic PR requirement
on `issue-queue`. Scope the App's bypass to the queue ruleset. The runner still
uses its configured Git remote for reads and issue claims.

Existing queue PRs remain on their saved publication route and hold any claim
until reconciliation. Review pending receipts before upgrading a runner. Where
direct publication is disabled, new updates still use queue PRs. The setting
`sharedIssueQueueReviewRequired` controls Factory's approval check for those PRs.

## Verification

Use two independent clones against one test remote. Race them for one issue and verify that only the confirmed owner starts. Cover an interrupted claim response, a stale report, a failed checkpoint, an interrupted release, and a delayed release after a new claim. Verify that a fresh Factory clone loads published reports and display numbers, that files created under `.issues/issue-work/` remain ignored and never appear in the queue tree, that concurrent report edits are preserved or surfaced for resolution, and that published changes contain only the permitted queue files. Exercise normal issue delivery and closure with the configured branch rules.

Verify that simultaneous publishes preserve both updates and allocate distinct issue numbers. Simulate a lost push response and confirm that retry recognizes the landed commit. Verify that Full Send cannot publish report changes through a code PR and that pending checkpoints retain their claims.

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
3. Publish the seed as `issue-queue` and verify its remote commit. Configure the
   branch and GitHub App for [direct publication](#direct-publication).
4. In the owning checkout, fetch the verified queue into a private ref. Run
   `node scripts/detach-issue-reports.mjs VERIFIED_QUEUE_REF` to compare every
   tracked report with both its index entry and authoritative queue copy. Publish
   or reconcile differences first. Then run the same command with `--apply` to
   remove only source tracking while preserving local report files. It is safe
   to rerun. Remove report-wide exceptions in `.gitignore`; keep only explicit
   policy exceptions such as `triage-labels.md` and `preferences.json`. The
   pre-commit guard rejects reintroduced reports, numbers, or claims in shared
   source commits. Set
   `"sharedIssueQueue": true` and `"sharedIssueQueueBranch": "issue-queue"`
   in `factory.config.json`. Pass this cutover through the code destination's
   normal checks and merge policy. Do not turn the setting on in a checkout
   whose tracked report copies are still present.
5. Update existing runner source checkouts once for the migration. Verify and
   preserve local edits before advancing an older checkout. Ignored local cache
   copies that match the shared queue can remain in place. Subsequent issue
   status changes refresh queue data without another source workspace update. Restart Factory and refresh. Confirm the closed reports and
   existing numbers in a fresh checkout and an upgraded checkout. Keep the
   source revision as the recovery copy. Historical Markdown links that name
   a moved file directly may point to its old path; issue ID references still
   identify the same report.

## Operation

The default Flow page refreshes the queue and shows publication and retry
controls. Creating an issue publishes a queue commit. Each code operation acquires
the issue claim until the operation finishes. A disconnected operation retains
its claim for reconciliation. Flow records and worktrees remain local, so use
one runner for a flow while it has unpublished code. Close publishes its own
checkpoint and releases the claim only after the queue commit lands. A
report draft can also be published from the queue status controls.

The queue periodically reads reports and claims from the queue branch in the background. **Refresh shared queue** checks immediately without changing the checked-out branch or advancing its code. Use **Publish report update** to share a deliberate local report edit. Local edits that conflict with newer reports are preserved and reported. For a pending queue PR started before the switch, use **Refresh queue PR** in Flow or **Refresh report PR against target** in Classic to rebuild its proposed commit on the latest queue tip.

If publication fails, use the issue's retry control after reviewing the failure. Use **Confirm report merge** to reconcile an existing queue PR after it lands. For an interrupted runner without a checkpoint, verify that its previous process and Git operation have stopped before using **Reconcile interrupted claim** on the owning checkout. A dead process can leave a per-issue lock in `.issues/shared-issue-claims/` or `.issues/shared-publication/`. Inspect the saved operation and remove only the confirmed dead lock before retrying. Local workspaces are preserved when proposing closure and can be cleaned up separately after review.
