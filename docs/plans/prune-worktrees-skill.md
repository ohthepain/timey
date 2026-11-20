# Prune worktrees skill

Factory will ship `$prune-worktrees` so other projects can install it.
Projects can copy the complete skill folder to `user/skills` and use
**Install project skill** to register it with Codex.

The project page will have an **Admin** tab next to **Home** and **Discuss**.
Its first tool is **Prune worktrees**, available from a button.

The skill previews Git worktree records marked prunable whose checkout folders
are already missing. It shows existing folders for review. It captures the
local branch associated with each missing checkout before removing its record.
An open Factory issue associated with the worktree or its branch protects both.
The preview identifies the issue and explains why the entry is skipped.

One approval covers the reviewed batch. The preview lists the worktree records
and local branches selected for deletion. A branch whose commits are not
confirmed safe is kept unless the operator explicitly selects it for deletion.
The preview shows the comparison branch. It uses the configured delivery branch
when available. Otherwise, the operator chooses a branch. Only local branches
whose tips are ancestors of the comparison revision are selected by default.
Remote branches are outside the cleanup scope.

The Admin button opens the preview directly. The Codex skill uses the same
Factory tool, including when installed in another project. Apply rechecks the
reviewed worktree records, branch tips, and open issue associations. If a
reviewed entry changed, it is skipped and the batch continues. The result
reports each attempted removal and any partial failure.

## Verification

The Factory cleanup suite passed 14 checks. The Chrome project Home scenario
passed through the Admin tab, preview, confirmation, and Git deletion in a
disposable repository. The strict Fallow audit still reports complexity warnings
for the new code and the inherited `/discuss-markdown.js` reference in Flow.
