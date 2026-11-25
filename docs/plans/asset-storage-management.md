# Asset storage management

Timey issue #217 tracks this work. The user confirmed the initial design on
2026-11-24 and approved the remaining design decisions on 2026-11-25.
Paul approved implementation of issue #217. Starting Work authorizes
implementation within this design.

## Read-only release

Open **Settings > Asset Storage** to review assets in configured S3 Artifact
stores. The inventory reads objects under the project's exact content-addressed
namespace and groups identical content across configured stores under one ID.
The displayed object date is S3's last-modified date for the oldest listed
copy. The inventory identifies legacy objects by digest because their object
keys do not record a display name.

Reference counts cover structured artifact references in shared records and
retained record revisions, including archived issue evidence. References from
unclassified source records are shown as **Restricted reference**. Counts
remain unverified while coverage of legacy links, external publication,
dependent files, and personal saves is incomplete. Keep every existing asset
during the review, including assets with a zero recorded count.

The inventory supports filtering, sorting, page selection, and filtered and
selected byte totals. A provider failure is visible alongside results from
available stores.

## Confirmed behavior

Asset Storage is accessible through Settings. It lists all project-owned
artifacts in the project's configured S3 stores, including documents,
attachments, screenshots, logs, and source checkpoints. Unrelated bucket
contents are outside its scope.

The panel shows each asset's size and the individual content and personal
references that make up its reference count.

Each asset has a permanent identity independent of its location and public URL.
Existing references continue to identify the same asset after a move.

## First release and deletion approval

Issue #217 covers the full Asset Storage feature, including personal saves and
both kinds of deletion. Acceptance testing must let the user observe real
stored assets being deleted in a regular project with configured S3 storage.
Use newly uploaded disposable assets for the test. Remove the last verified
reference to one asset to exercise automatic deletion. In Settings, force-delete
another asset that a report still references. Verify removal from S3 in both
cases and confirm that the report remains readable and displays **Asset deleted**.

Release the Settings inventory and reference counts as a read-only first
release for existing project data. Before enabling automatic or forced deletion
for that data, review the inventory and reference counts in the real project.
Include archived issues, older chat messages, published links, and moved assets
in that review.
Enabling deletion for existing project data requires explicit approval after
the review.

## Existing assets and retained history

Inventory existing project-owned assets and verify their references before
enabling automatic deletion. If a store or source record is unavailable for
verification, keep the affected assets and show their reference status as
unverified.

Keep existing project-owned assets discovered with zero verified references
visible for manual review. Automatic deletion begins when Timey observes the
removal of an asset's last verified reference.

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

Block forced deletion while an asset is required to resume or recover work or
to complete verification. Explain which operation depends on it and what must
finish before it can be deleted.

A person with force-delete permission can delete an asset with references to
content they cannot read. Include restricted references in the impact count and
hide their titles, links, and authors in the inventory and confirmation.

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

## Earlier proposal

The interview draft proposed keeping the inventory read-only during reference
verification, rejecting dependency cycles, limiting forced deletion to project
administrators, selecting all filtered results at once, and offering Save only
for supported asset types. The approved decisions above supersede the draft.
