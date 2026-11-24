# Asset storage management

The design interview is ongoing. The user confirmed the first round on
2026-11-24. These decisions authorize design documentation. Implementation and
the remaining product decisions are pending.

## Confirmed behavior

Asset Storage is accessible through settings. It lists all project-owned
artifacts in the project's configured S3 stores, including documents,
attachments, screenshots, logs, and source checkpoints. Unrelated bucket
contents are outside its scope.

The panel shows each asset's size and the content or personal saves that refer
to it. It provides row checkboxes, filters, Select all, and Delete selected.
Filter details and selection behavior remain open.

Each asset has a permanent identity independent of its location and public URL.
Moving an asset updates its location while existing references continue to
identify the same asset. Individual references explain its reference count.

Retained content keeps its references, including archived issues, content in the
icebox, older chat messages, and retained report revisions. Removing the last
reference automatically deletes the asset without a warning.

Save creates one personal reference shown as "Saved by you". Repeated Save
actions add no references. Unsave removes that person's reference.

Asset Storage permits forced deletion of referenced assets. The referring issues,
reports, and chats remain and show "Asset deleted" in place of the asset.
Surviving references must not recreate deleted contents.

## Relationship to existing decisions

[ADR 0022](../adr/0022-separate-issue-coordination-and-artifact-stores.md)
retains archived history and evidence and removes exclusively owned evidence
on permanent issue deletion. Asset references preserve archive retention.
Forced asset deletion adds a deliberate exception to evidence retention without
deleting its referring content.

[ADR 0023](../adr/0023-select-issue-and-artifact-storage-per-issue.md)
requires checked storage moves. Permanent asset identity must remain valid
across those moves.

## Remaining decisions

- How existing assets acquire verified references before automatic deletion starts.
- How publication and links outside Timey retain assets.
- Whether dependent assets form a reference graph and how cycles are handled.
- Whether reference removal is permanent when only retained history contains a link.
- Deletion timing, concurrent writes, partial failure, and in-progress uploads.
- S3 versions, replicas, and cached copies after deletion.
- Forced deletion confirmation and permissions.
- Panel filters, sorting, size totals, and selection across pages.
- Whether Save applies to artifacts other than documents and where it appears.
- How old physical copies are retired after storage moves.

The interview ends after the remaining decisions are settled and the user confirms
shared understanding. No production behavior has changed.
