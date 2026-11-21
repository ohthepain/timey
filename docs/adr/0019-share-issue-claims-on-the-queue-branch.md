---
status: accepted
---

# Share issue claims on the queue branch

Keep local issues in files. Store shared reports, their lifecycle statuses,
display numbers, and claim records on the dedicated `issue-queue` branch.
Source workspaces must not advance when shared issue metadata changes.

This extends [ADR 0011](0011-share-issue-reports-on-the-target-branch.md).
Separate remote branches for individual claims made ownership harder to inspect
and required a multi-ref transaction to publish a report and release its claim.
Version 2 claims are regular JSON files in `.issues/claims/` on the queue branch.
The claim's blob ID identifies its exact attempt. A direct report checkpoint can
update the report and remove that claim in a single commit.

Writers use an isolated index and a private queue ref. Every push directly extends
and checks the expected remote tip. A competing update requires fresh reads and
revalidation. Work starts only after confirmed ownership and a current report
check. Unknown outcomes retain receipts for explicit recovery. Claims do not
expire automatically, and a stale release cannot delete a replacement claim.

One branch serializes publication across issues. Bounded retries preserve
unrelated changes. This tradeoff avoids operating a new shared service while
keeping issue activity out of source history, workspace update prompts, and code
verification identities.

Shared mode requires an explicit dedicated branch. The source commit guard rejects
shared reports, numbers, and claims. The cutover command verifies shared copies
before removing source tracking and preserves local files. Old runners, claims,
and pending publications must be reconciled before upgrading writers. New claim
acquisition refuses remaining legacy claim branches. The rollout must block those
branches before old writers can resume.

The [shared queue design](../plans/shared-issue-queue.md) describes the protocol
and cutover. Local Flow attempts, workspaces, evidence, and archive policy retain
their existing ownership. Storing shared metadata does not transfer a live flow
or imply human acceptance.
