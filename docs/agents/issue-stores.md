# Configure and move Factory stores

Factory uses one Coordination store for the project. Each issue saves its own
Issue and Artifact destinations, selected through a named Issue storage profile.
The project also selects a Coordination artifact store for large coordination
records and operation receipts. See [the profile decision](../adr/0023-select-issue-and-artifact-storage-per-issue.md)
for these boundaries and the [store specification](../plans/issue-stores.md) for
ownership, outage, and retention behavior.

Local mode uses files on your machine. Remote mode uses Git, Postgres, or DynamoDB
for Issue and Coordination stores, and Git, Postgres, or S3 for artifacts. Local
file stores are not used for remote issues. The project's mode is fixed after
its version-2 configuration is saved; changing mode requires a separate project
migration that is outside the initial profile implementation.

Adding credentials or a configured destination does not move existing data.

## Prepare Postgres

1. Create a database dedicated to Factory, such as `timey_issues_db`. The database
   can share the application's Postgres instance. It cannot be the application's
   database, including through another schema or another user.
2. Give the Factory database user permission to connect and create the `factory`
   schema and its tables. Factory creates `factory.store_records`,
   `factory.store_operations`, and `factory.artifact_objects` when their providers
   open. No separate database is needed for each storage role.
3. Set `FACTORY_ISSUES_DB_URL`, `FACTORY_DB_USER`, and `FACTORY_DB_PASSWORD` through
   the project's private environment or secret setup. The URL must name the
   dedicated database. Keep credential values out of `.issues/stores.json` and
   source files.

## Prepare S3

1. Use the existing private artifact bucket. Set `FACTORY_ARTIFACTS_BUCKET` to its
   name and `FACTORY_ARTIFACTS_BUCKET_REGION` to `eu-central-1` for the supplied
   bucket. Factory passes this region explicitly to the S3 client.
2. Give the runner's existing AWS role or profile `s3:ListBucket` on the bucket
   and `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on the configured
   artifact prefix. The default prefix is `factory/artifacts/`. Contract tests use
   `factory/tests/artifacts/`; grant that prefix separately when running them.
   `HeadObject` uses `s3:GetObject`, and `ListObjectsV2` uses `s3:ListBucket`.
   See [S3 API permissions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html).
3. If the bucket requires a customer-managed KMS key, allow the corresponding
   encryption and decryption operations for that key. See
   [S3 encryption permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html).
4. Keep retained evidence outside automatic expiration rules. Storage moves keep
   old verified data; they do not authorize deletion or change retention policy.

Factory uses the AWS SDK credential chain. Use the existing AWS role, SSO session,
or profile; no Factory-specific AWS access-key secret is required.

## Prepare DynamoDB when selected

1. Create a table with string partition key `PK` and string sort key `SK` in the
   selected region. Factory does not create runtime tables. No secondary index
   or ownership TTL is required.
2. Configure the table name and region on the named DynamoDB store. Issue and
   Coordination records can share that table; Factory separates projects and
   configured stores in the partition key.
3. Grant `dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:PutItem`,
   `dynamodb:DeleteItem`, and `dynamodb:ConditionCheckItem` for that table.
   Transaction permissions apply to their underlying item actions; see
   [DynamoDB transaction permissions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).
4. Choose a separate Artifact destination for large histories and file contents.
   DynamoDB stores bounded references to those immutable artifacts.

## Add destinations and choose profiles

1. Open **Project settings → Issue Storage**. Add a named destination appropriate
   for the project's mode. The same backend type can appear more than once.
   Connection secrets remain environment references.
2. Save the configured store, then use **Test store connection**. The result
   checks provider access. It does not change an issue's home or start work.
3. Add an Issue storage profile with a name, an Issue store, and an Artifact
   store. Both destinations must support their roles and the project's mode.
4. Select the project profile default, or override **Issue storage profile** in
   a folder's settings. Parent folders inherit their defaults. Creation shows
   the resolved profile and requires a valid active choice.
5. Choose **Coordination** and **Coordination artifacts** independently for the
   project. Changing either role uses a checked project migration. All affected
   work must be idle and pending operations reconciled first.
   **Test connection** beside the Coordination store selector checks the selected
   destination before saving, without moving coordination data.

Configured destinations and roles are fixed after saving. To change a database,
table, directory, or Git branch, add a new named store and perform a checked move.
Display names remain editable.

Profile edits and defaults affect future selections. Existing issues keep their
saved Issue and Artifact stores. Retiring a profile removes it from new choices
without rerouting those issues. A retired profile cannot be the project default.
Invalid selections block creation instead of falling back to another destination.
Existing physical stores remain configured so retained references can be read.

On another runner, configure the same named destinations and its private
credentials. Runners derive a common project identity from the repository remote
and keep distinct runner identities. A runner follows completed project-role
migrations only after verifying their shared receipts and configured target.
An unknown target blocks shared changes and keeps cached browsing available.

Flow and its Issues tab show the last confirmed local snapshot immediately
while one shared refresh runs in the background. Polling starts another refresh
no sooner than 30 seconds after the previous refresh finishes. After a server
restart, cached issues remain read-only until storage is confirmed. A failed
refresh shows a warning and preserves cached browsing. Shared edits and execution
still wait for fresh authoritative checks. Opening an issue refreshes its retained
evidence in the background; opening a retained file waits for that file's evidence.

Rebuilding an idle flow saves its changed structure and confirmed operation in
one Coordination transaction. The transaction checks the catalog, original flow,
absent claim, migration gate, and operation revisions together. It does not
publish a temporary claim before saving. Saves belonging to a running attempt
and recovery of older pending operations retain their existing ownership protocol.

## Move existing issues

1. Open an idle issue's **Issue settings** and choose its **Issue storage profile**.
   Selecting a different profile starts the checked move automatically. Progress
   and errors appear beside the selector. The destination-branch dialog and bulk
   editor also show the profile choice. Move a master and all attached sub-issues together.
2. Confirm when the move includes a master and its attached sub-issues.
   Factory copies and verifies issue records and owned artifacts
   before switching both saved destinations. IDs, display numbers, and original
   report bytes remain stable. A failed copy preserves the source destinations.
   A merged issue stays read-only throughout storage migration.
   When only the Issue store changes, artifacts stay in their existing store;
   the move does not scan or copy retained project artifacts.
3. If the move fails or the connection is lost, the selector returns to the
   last saved profile and shows the error. Select the intended profile again to
   retry the same operation. The move retains its operation identity; it does
   not report success until authoritative readback confirms the destination.

Normal profile changes check the issue's saved migration references and this
browser's retained retry identity. To discover older unfinished moves from another
runner that stopped before sealing an issue, open **Factory settings → Issue
Storage** and choose **Find unfinished storage moves**. This explicit recovery
search reads historical operations and can take longer than a profile change.
Factory keeps only pending operation details for recovery as it scans the history.
It also identifies other pending updates that can block permanent deletion.
**Reconcile stale save** retains the original operation and marks it rejected
once Factory verifies that the issue has advanced and released its claim.

A master and all attached sub-issues must use the same Issue and Artifact stores.
Grouping compares actual destinations, so profiles with different names can still
be compatible. If either destination differs, move the issues explicitly before
grouping them. Grouping never moves data automatically.

## Upgrade an existing registry

Stop older Factory runners before activating profiles. Version-1 registry reads
produce a deterministic version-2 view without rewriting the file. Generated
profile IDs retain the old Issue store IDs, paired with the previous project
Artifact store. The previous project Artifact selection becomes the Coordination
artifact selection. Existing issue catalogs receive concrete Artifact destinations
through checked activation. This configuration upgrade copies no artifact contents
and retains existing physical references.

The selected legacy destinations must agree on local or remote mode. Unused
configured destinations remain available for historical reads; incompatible legacy
profiles are retired. Resolve incompatible existing issue destinations or master
groups before the new model activates. Invalid or retired folder defaults block
new selections until repaired. The upgrade never silently moves data to satisfy
these rules.

Stop and upgrade older Factory runners on connected machines before activating
canonical stores. Older binaries cannot honor the new shared ownership records.
The first canonical bootstrap copies verified local reports, display numbers,
saved flows, and Flow evidence. Active Flow attempts and existing shared queue
claims require explicit recovery first.
After bootstrap, the old shared-queue writer and refresh path stop. The catalog
owns issue routing; local Markdown and flow files become display projections.
Unconfirmed local edits are retained as drafts. Status changes, claims, and
storage refreshes do not update source HEAD, the source index, or workspaces.

## Verify a configured installation

Run the local contract and UI checks before a live cutover:

```sh
node --test scripts/storage-profiles-config.check.mjs scripts/storage-profiles-ui.check.mjs scripts/store-settings.check.mjs scripts/store-runtime.check.mjs scripts/store-records.check.mjs scripts/store-artifacts.check.mjs
node scripts/flow-browser.mjs --stores
```

`node --test scripts/store-git-http.check.mjs` checks large artifact uploads
through a real HTTP Git server. It covers rejected chunked uploads, retained
authentication, exact branch leases, and recovery after a lost acknowledgement.

Remote contracts require explicit opt-in and isolated test namespaces. Record
contracts select providers with `TIMEY_STORE_TEST_PROVIDERS`; disposable DynamoDB
tables must start with `timey-store-test-`. Artifact contracts enable Postgres and
S3 with `FACTORY_STORES_LIVE=1` and read environment references from
`FACTORY_STORES_ENV_ROOT` when set. Tests create random project/store namespaces
and remove their own data. Disposable DynamoDB provisioning additionally needs
explicit `TIMEY_STORE_DYNAMODB_CREATE=1` and table creation/deletion permissions.

During an outage, inspect cached history and keep local drafts. New shared
changes and runs wait for storage. An existing Work attempt can finish locally;
its retained result remains pending until synchronization succeeds. Local Stop
still cancels the owning runner. Remote Stop remains a request until its owner
acknowledges it, and neither a lost connection nor elapsed time releases a claim.

## Finish an interrupted deletion

Permanent Delete removes the issue and evidence whose exclusive ownership it can
verify. Files shared with retained issues stay available. Archive retains the
report and history.

Postgres uses a partial index to find pending operations before Factory checks
deletion admission. The first admission builds the index concurrently on an
existing database. Other storage operations can continue while it builds.
Factory verifies older external payloads and records the revision of each
finished operation, so later checks can skip it. A changed revision is checked
again. The proposal Delete button waits for confirmation while the store checks
admitted work and shared evidence.

Permanent Delete now removes S3 objects tied to the deleted issue after checking
surviving shared records and receipts. It also checks publications and Discuss
attachments in the current checkout. Publications and attachments on another
runner have their own local copies. If a reference source is unavailable,
Factory keeps the candidate artifacts. Deleting an unopened proposal during
another active claim keeps the proposal's S3 evidence. Files in stores outside
the checkout retain their existing policy.

Factory records an S3 object's bucket, key, and digest in a separate
Coordination namespace before uploading it. This entry survives a failed
metadata write and identifies the attempted upload. Reference-only inventory
can use a bounded projection saved with new overflow records and operation
receipts. Older and larger records fall back to reading the original payload.
The upload catalog records physical locations. Current records and retained
receipts supply recorded ownership.
Reference reconciliation stores one record per owner and S3 object identity.
Shared writes schedule reconciliation. The idle sweep also reconciles changes
from background work and runner-local files.
Records and receipts keep their logical identities across storage moves. Move
receipts that record copies and routing aliases have no ownership of their own.
Deleting an individual issue artifact releases that evidence path and digest,
including its retained manifest copies. Other owners continue to protect the
object. S3 removal writes a durable deletion status. Factory's authenticated
`/api/project-asset-reference` read accepts an object's `sha256` and `bytes`.

Deleting a published report queues its matching S3 copies for cleanup. Factory
checks remaining reports, Discuss attachments, shared records, and retained
receipts before removing a copy. It also checks registered uploads once per
minute while idle. A new upload has a 30-minute window to acquire an owner.
Expired uploads and objects whose last recorded reference has gone are checked
against the same sources. The cleanup uses the existing storage seal and
processes a bounded batch on each pass. An unavailable reference source pauses
cleanup for that pass. Retained receipts keep their references until retired.
The sweep uses registered object keys and the keys derived from deleted reports.
Publishers' runner-local report and attachment references are recorded by
runner. A different runner preserves those ownership records.
It also reclaims their history in versioned buckets. The S3 role needs
`s3:GetBucketVersioning`, and versioned buckets also need
`s3:ListBucketVersions` and `s3:DeleteObjectVersion`.

1. Finish running project work before deleting an issue. Deletion holds shared
   changes while Factory checks retained references and removes unused evidence.
   Factory processes retained records and receipts in batches where the store
   supports it. The cleanup plan saves record identities, revisions, and
   reference and file checks for the selected issue.
2. If a proposal deletion still holds shared changes before Factory saves its
   cleanup plan, choose **Pause deletion** in **Project settings → Issue Storage**.
   This keeps the proposal and evidence, releases shared changes, and stops the
   current selection before it starts another proposal. To continue later, retry
   Delete from the proposal.
3. If the issue is already absent, open **Project settings → Issue Storage** and
   click **Resume deletion**. The action resumes its original deletion command.
4. Restore an unavailable store, then retry the same action. Factory releases
   shared changes after authoritative cleanup confirmation.

Deletion leaves source worktrees to their existing cleanup controls. For
verified unreferenced S3 objects, cleanup removes the current object and its
versions. Shared objects and their versions stay available.

Run `node --test scripts/store-deletion.check.mjs` to exercise interrupted
deletion and retention with two disposable runner roots. Set
`TIMEY_DELETION_TEST_BUCKET` to a disposable, version-enabled
`timey-store-test-*` bucket in `eu-central-1` to check real S3 object versions.
The check writes to a unique prefix, reads back the exact versions from the
retaining runner, and removes only the versions under its test prefix.

## Recover ownership

The ownership panel in Issue settings identifies a retained claim. When Factory
allows recovery, **Release claim** opens this panel from **Last blocking error**,
or from the issue header if there is no blocking error. Stop and reconcile the
original runner, enter a reason, confirm the statement, and select **Recover ownership**. Recovery checks
the exact issue, attempt, runner and owner token. It retains the attempt history
and fences a late result from the original process. A merged issue stays read-only.

Local Stop remains available during a storage outage. Remote Stop stays requested
until the owning runner confirms cancellation. Neither an elapsed timeout nor a
Stop request releases ownership by itself.
