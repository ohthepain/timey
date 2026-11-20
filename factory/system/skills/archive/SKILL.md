---
name: archive
description: Archive a requested list of Timey issue numbers together through the factory's existing storage controls.
---

Take the issue numbers from the user's request, remove duplicates, and call the
registered `issue_archive` tool once with `action: "archive"` and the complete
`issueNumbers` array. For example, `$archive 11 12 13` becomes
`{"action":"archive","issueNumbers":[11,12,13]}`. The tool resolves numbers
from the registry once and returns one result per selected issue.

Older saved chats may expose a tool schema with only `issueIds`. In that case,
query `issues_list` once to resolve the complete number list, check that every
requested number was found, and submit its IDs in one batch. Never guess IDs.

Use one batch for up to 500 numbers. Split larger lists only at that limit;
keep shared-queue writes within the existing serialized storage controls.
Avoid per-issue model turns, report-body queries, shell moves, and separate tool
calls when one batch suffices. Preserve existing archive eligibility, claim,
publication, and recovery safeguards.

If the request gives no numbers, ask which issues to archive. For an explicit
request to archive all closed issues, query `issues_list` with `location: "closed"`
once and submit its IDs together. Archive only the requested selection; archiving
does not close, accept, or clean up an issue.

Summarize archived, pending publication, already archived, and failed items from
the actual tool results. Shared-queue `published` means archiving finished;
incomplete publication states remain pending. Retain issue numbers so failures are easy
to identify. Retry only unresolved items when requested, using the existing
controls. If `issue_archive` is unavailable, report that limitation and direct the
person to the factory Discuss tab.
