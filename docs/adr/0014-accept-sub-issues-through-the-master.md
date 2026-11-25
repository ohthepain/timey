---
status: accepted
---

# Accept sub-issues through the master issue

A master issue owns implementation and retains proof for each attached sub-issue.
Accepting the master as Fixed closes each attached sub-issue with the **Fixed by**
reason and a link to the master. An unmet sub-issue must be detached before
acceptance, so one decision can cover the whole fix without closing unfinished work.

Closing the master for any other reason releases its attached sub-issues for
independent work. Their reports stay open and link to any relevant master
evidence. A person can also detach an individual sub-issue while the master is idle.
A master run can detach its own blocked sub-issue during Request or Work when
its saved Work scope and checkout evidence establish that changes are attributable
only to siblings. Unknown attribution leaves the group intact. Detachment
changes active scope and retains the original Request and previous work.

See the [issue folder design](../plans/issue-folder-strategies.md) for the grouping
and review workflow.
