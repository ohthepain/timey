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

When `issue_create` is unavailable in an external chat, use the supported
`pnpm run factory -- issue-create REQUEST.json --url LIVE_SERVER_URL` command.
Read [external chat creation](../../../docs/agents/factory.md#create-an-issue-from-an-external-chat)
for its request format. Save a request file with one UUID before sending; reuse
it on retries. Put the agreed problem, scope, constraints, decisions, acceptance
criteria and requested proof in `description`. Keep instructions about this
creation operation outside the saved work description. Report the returned issue
link; creation leaves it idle for the server to continue. Use the user's actual
live server URL; the command verifies project identity and retains server guards.

For other unavailable controls, direct the person to the project's Discuss tab.
Do not use ad hoc shell or HTTP calls or edit issue records to bypass guards.
