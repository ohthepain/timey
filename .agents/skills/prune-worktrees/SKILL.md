---
name: prune-worktrees
description: Review and clean up missing Git worktrees and their local branches in Factory.
---

# Prune worktrees

1. Open the requested project in the live Factory app. Check the selected project before reviewing anything. On the project page, open **Admin → Prune worktrees**. Use the app's preview so Factory's issue protections apply.
2. Read the comparison branch and each selected worktree and branch. If the app asks for a comparison branch and the user has not specified one, ask which branch contains the work to keep. Report any protected entries and local branches whose commits are not confirmed in the comparison branch.
3. Present the exact batch for one approval. Leave unconfirmed branches unchecked unless the user explicitly selects them. After approval, use **Remove … worktree records and … branches** on that preview. If the preview changed, present the new selection for approval.
4. Report the displayed results, including skipped entries and partial failures. When Factory or Admin is unavailable, explain the dependency and stop before any deletion.
