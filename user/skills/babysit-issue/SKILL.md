---
name: babysit-issue
description: Use in a Timey issue chat when asked to start or resume and babysit the issue through checks, repairs, and its configured delivery finish line.
---

# Babysit an issue

Use the issue attached to the chat and follow its saved Flow to the configured delivery finish line. Honor any narrower stop requested by the person. If the Flow authorizes automatic Merge, stay with it through required checks, repairs, and a confirmed merge. If Merge requires human approval, surface that gate and continue through Merge after approval using the existing control. Keep issue acceptance and closure on their existing explicit controls.

## Start or resume

Read the current issue with `issues_list`. If Factory is already working on it, keep that run and use its status and approval controls. Recover an uncertain attempt through Factory before requesting more work.

For an explicit request to start or resume the saved route, use `issue_control` with `action: play`, the issue ID, and the current revision. If the person sets a narrower stop, verify that the available control can honor it before starting. If the owning chat must finish before Flow can start, end the turn with the issue link and point to Start or Resume. A command receipt confirms submission only.

## Drive the authorized work

Factory owns execution, waiting, and approvals. Use the runner for the configured route. If the runner pauses, report the exact block, failed check or required approval, and the next available control. A discussion turn can hand work to the runner through an available guarded control, but cannot take over its checkout or monitor the run in a separate loop.

In an authorized execution turn, use the saved failure evidence to reproduce and fix bugs that block delivery. Preserve the verification assertions and unrelated work. Rerun the focused check, commit the repair in the managed issue checkout, and let Factory verify the changed candidate before retrying Publish. Apply the same approach to CI failures and confirmed review findings on the current PR head. Use the runner's retry limits. Stop for a required human decision, an unresolved operation, or an exhausted repair budget.

Report readiness from retained verification and the PR's current checks and review state. Report a merge from Factory's receipt or verified GitHub state. Link the issue, PR, and relevant repair evidence. If the available controls cannot carry the run to the configured finish line, name the remaining work and where it belongs.
