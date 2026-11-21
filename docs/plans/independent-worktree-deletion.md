# Independent worktree deletion

**Worktree → Delete** supports an idle issue with a saved checkout, including
one with unfinished closure. The separate Stop work and delete shortcut is a
follow-up. Stop an active action before using Delete.

## Agreed decisions

- Worktree deletion is available for any issue, including an issue with a failed,
  stopped, or unfinished closure sequence. An actively running Retro or Cleanup
  blocks deletion with an operation-still-in-progress message.
- Deletion removes only the local checkout. It preserves local and remote
  branches, PRs, conversations, retained evidence, and issue status.
- Uncommitted edits and new files are discarded without a backup. The
  confirmation states this consequence before deletion.
- When Work is running, the confirmation offers **Stop work and delete**.
  Deletion waits for Work to stop. Play remains paused. This does not apply to
  actively running Retro or Cleanup, which must finish or be stopped separately.
- A later explicitly started operation that needs a checkout recreates it from
  the preserved issue branch. Deletion itself leaves the checkout absent.

The existing [Close and Cleanup sequence](flow-close-cleanup.md) retains its
meaning. Independent worktree deletion does not itself complete Retro, close or
accept the issue, or delete branches.
