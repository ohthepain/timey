# Shared issue queue implementation result

Starting revision: `d49cc37714c315f8d2f6e3759612916426a72bb9`.
Implementation branch: `codex/shared-issue-metadata`.
The accepted design is [ADR 0019](../adr/0019-share-issue-claims-on-the-queue-branch.md).

## Implemented behavior

Local queues continue to use files. Shared reports, lifecycle statuses, display
numbers, and version 2 claim records use the dedicated queue branch. Claims are
regular JSON files whose blob IDs identify exact attempts. Direct report
checkpoints publish their report and remove the exact owned claim in one commit.

Private indexes and worktree-private refs keep metadata operations separate from
source HEAD, source tracking refs, the staged index, and unstaged source files.
The App writer checks its configured queue, expected parent, regular-file modes,
and metadata-only path allowlist. Unknown outcomes retain recovery records.
Delayed releases cannot remove replacement owners.

Shared mode requires a dedicated branch. Source report caches are ignored, and
the source commit guard rejects reports, numbers, or claims in a shared source
snapshot. The repository's existing hook was enabled in this checkout after
confirming that no earlier hook configuration would be replaced.

## Report cutover

The initial inventory found ten source-tracked reports. Nine matched the shared
copies. One retained 1,778 bytes of additional delivery notes. Those append-only
notes were published to `issue-queue` as
`16f67ee5cee4ecaaa2a0681e5a69afd7878358b3` using the previous claim protocol, with
publication confirmed before its temporary claim was released.

The cutover command then verified all ten local files against their index entries
and that shared queue revision. It removed source tracking with `git rm --cached`
and preserved every local report. Only `preferences.json` and `triage-labels.md`
remain source-tracked under `.issues/`. The command is repeatable and refuses
unpublished or conflicting bytes. No source branch was pushed.

## Verification and limits

Evidence is retained in `.issues/evidence/shared-issue-queue/` on this checkout.

- The final storage, claim, queue, archive, transport, cutover, and verifier-hook
  check run passed all 66 tests against disposable repositories and remotes.
- The direct status test confirms visibility in a second runner while both
  source workspaces retain their HEAD, source tracking ref, staged tree, source
  status, and unstaged file contents.
- Race and interruption checks cover competing owners, unrelated claims, unknown
  creation and release responses, replacement claims, competing report updates,
  atomic checkpoints, and local cleanup recovery.
- Source cutover checks cover preservation, repeatability, refusal of unpublished
  data, local-only operation, dedicated-branch configuration, and alternate indexes.
- Type checking passed. All 71 Vitest tests passed. Changed-file formatting and
  the strict step audit passed with no new or worsened Fallow findings.
- The final full Factory run passed 1,084 of 1,089 tests. Its five refresh-fixture
  failures also reproduce
  against the archived starting revision. Its raw result is retained separately
  from the focused passing checks.
- The app build failed on missing exports from the installed TanStack
  `router-core` package. This implementation changes no application source,
  dependency versions, or lockfile. The failed build remains a verification limit.

The check runs establish storage behavior, not a live multi-runner deployment.
Stop and reconcile old runners before upgrading their claim writers. New starts
refuse existing legacy claim branches, and old local claim receipts require the
previous runner's recovery procedure. Existing runners need the source cutover
revision once. Further status updates refresh issue data without source updates.
Deployment, source merge, issue acceptance, and full Flow handoff were not performed.
