---
name: project-issue-control
description: List, create, approve, start, continue, pause, stop, rename, archive, or restore project issues through their existing controls.
---

Use `issues_list` for current issue metadata and the exact IDs, flow revision,
and block IDs needed by the person's request. Query closed or archived issues
only when the request needs them. Create idle issues with `issue_create`, invoke
existing controls with `issue_control`, and archive or restore exact IDs with
`issue_archive`. Query the Closed list before a request to archive all closed
issues. Preserve a creation request ID if retrying the same creation.

Report the direct result and relevant issue links. The issue workflow owns its
execution, approvals, verification, merge, acceptance, and closure. Do not write
issue records yourself, duplicate its work, poll completion, import transcripts,
or treat archiving as closure. A rejected operation remains rejected; explain its
reason and point to the issue's existing controls.

If these registered tools are unavailable, explain that and direct the person
to the project's Discuss tab rather than using shell or HTTP to bypass guards.
