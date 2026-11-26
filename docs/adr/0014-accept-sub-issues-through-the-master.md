---
status: accepted
---

# Accept sub-issues through the master issue

A master issue owns the work for its attached sub-issues and retains their
evidence. Code masters can be accepted using the merged PR and its required
GitHub checks. Investigation masters use the retained inquiry and sub-issue
evidence. Required human checks still apply.
Accepting the master as Fixed closes each attached sub-issue with the **Fixed by**
reason and a link to the master. An unmet sub-issue must be detached before
acceptance, so one decision can cover the whole fix without closing unfinished work.

Closing the master for any other reason releases its attached sub-issues for
independent work. Their reports stay open and link to any relevant master
evidence. A person can also detach an individual sub-issue while the master is idle.
User-initiated removal clears the child's master links and omits the
**Removed from master** badge. The master retains its detach history so the
user can attach the child again. An ordinary detach invalidates the master's
Request and dependent blocks. A fresh Request uses the current membership
and preserves the original wording and attempt history.

A master run can detach its own blocked sub-issue during Request or Work when
its saved Work scope and checkout evidence establish that changes are attributable
only to siblings. Unknown attribution leaves the group intact. A blocked sub-issue detach
changes active scope and retains the original Request and attributable sibling work.

See the [issue folder design](../plans/issue-folder-strategies.md) for the grouping
and review workflow.
