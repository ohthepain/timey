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
Detaching invalidates the master's Request and dependent blocks. A fresh Request
uses the current membership and preserves the original wording and attempt history.

See the [issue folder design](../plans/issue-folder-strategies.md) for the grouping
and review workflow.
