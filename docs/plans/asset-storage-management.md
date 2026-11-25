# Asset storage management

Timey issue #217 tracks this work. The user confirmed the initial design on
2026-11-24 and approved the remaining design decisions on 2026-11-25.
Implementation requires separate approval.

## Confirmed behavior

Asset Storage is accessible through Settings. It lists all project-owned
artifacts in the project's configured S3 stores, including documents,
attachments, screenshots, logs, and source checkpoints. Unrelated bucket
contents are outside its scope.

The panel shows each asset's size and the individual content and personal
references that make up its reference count.

Each asset has a permanent identity independent of its location and public URL.
Existing references continue to identify the same asset after a move.

## Existing assets and retained history

Inventory existing project-owned assets and verify their references before
enabling automatic deletion. If a store or source record is unavailable for
verification, keep the affected assets and show their reference status as
unverified.

Retained content keeps its references, including archived issues, content in the
icebox, older chat messages, and retained report revisions. A link in a retained
revision or chat message counts until that record is permanently removed.

## Published links and dependent files

Publishing through Timey adds a reference that lasts until unpublishing.
Copying a URL leaves the reference count unchanged. A copied URL works only
while another reference keeps the asset alive.

In the first release, register each dependent file against the content that
uses it. Treat a bundle that must move and delete together as one asset. Defer
asset-to-asset reference graphs and cycle handling.

## Automatic deletion and storage moves

When the final verified reference is removed, queue deletion automatically
without a warning. Before committing the deletion, recheck references and any
active uploads or moves. After committing the deletion, reject new references
to that asset ID. Retry partial cleanup while keeping the asset inaccessible.

Show **Deletion pending** until cleanup removes managed copies, including S3
versions and replicas, and invalidates caches Timey controls. Show any provider
block in Settings.

For a checked move, verify the destination copy before switching the asset's
location. Retire the old copy through cleanup that can be retried.

## Forced deletion

Users with permission to manage project storage can force-delete referenced
assets. The confirmation shows the selected asset count, total size, and which
issue, report, or chat references will show **Asset deleted**. Include personal
saves in the impact count.

Keep the referring issues, reports, and chats. They show **Asset deleted** in
place of the asset. Keep a deletion record so retries and surviving references
cannot recreate the contents.

## Filters, selection, and personal saves

Filter by asset type, store, reference status, and **Saved by you**. Sort by
name, size, or added date. Show separate size totals for filtered results and
selected rows.

The panel provides row checkboxes, **Select all**, and **Delete selected**.
**Select all** selects the current page. Selection persists across pages and
clears when filters change. Show the total selected count beside
**Delete selected**.

Offer **Save** for every asset the user can access, in its viewer and in its
Asset Storage row. **Save** creates one personal reference shown as
**Saved by you**. Repeating **Save** leaves the count unchanged. **Unsave**
removes that person's reference.

## Relationship to existing decisions

[ADR 0022](../adr/0022-separate-issue-coordination-and-artifact-stores.md)
retains archived history and evidence and removes exclusively owned evidence
on permanent issue deletion. Asset references preserve archive retention.
Forced asset deletion adds a deliberate exception to evidence retention without
deleting its referring content.

[ADR 0023](../adr/0023-select-issue-and-artifact-storage-per-issue.md)
requires checked storage moves. Permanent asset identity must remain valid
across those moves.
