---
status: accepted
---

# Track issue lifecycle folders separately

Store Open, Closed, and Archived reports in `.issues/open/`, `.issues/closed/`,
and `.issues/archive/`. Separate directories let projects that use ordinary
commits choose which report collections Git sees through `.gitignore`. The
shared queue continues to publish Open and Closed reports through its existing
writer and keeps Archived local. This preserves the split between code delivery
and queue publication in [ADR 0011](0011-share-issue-reports-on-the-target-branch.md).

See the [sidebar folder design](../plans/factory-sidebar-folders.md#git-tracking)
for an ignore rule example.
