# Configure and move Factory stores

Factory starts with files/Git for Issue, Coordination, and Artifact storage.
Adding credentials or a configured destination does not change those defaults.
Use this guide to prepare a remote destination and move data through checked
storage operations. The [store specification](../plans/issue-stores.md) defines
ownership, outage, and retention behavior.

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

## Add destinations and choose defaults

1. Open **Project settings → Issue Storage**. Add a named Postgres, DynamoDB, S3,
   files, or Git store. Names identify destinations; the same backend type can
   appear more than once. Connection secrets remain environment references.
2. Save the configured store, then use **Test store connection**. The result
   checks provider access. It does not change an issue's home or start work.
3. Set the new-issue default on **Project settings → Issues**, or override
   **Issue store** in a folder's settings. Parent folders inherit their defaults.
   Creation shows a required store control with the resolved default selected.
4. Choose Coordination and Artifact destinations independently on **Issue
   Storage**. Saving a changed project role starts a checked project migration.
   All affected work must be idle and pending operations reconciled first.

Configured destinations and roles are fixed after saving. To change a database,
table, directory, or Git branch, add a new named store and move to it. Display
names remain editable. A later issue-default change affects new issues; it does
not move existing ones.

On another runner, configure the same named destinations and its private
credentials. Runners derive a common project identity from the repository remote
and keep distinct runner identities. A runner follows completed project-role
migrations only after verifying their shared receipts and configured target.
An unknown target blocks shared changes and keeps cached browsing available.

## Move existing issues

1. Open an idle issue's **Issue settings**, choose its **Issue store**, and click
   **Move issue**. The destination-branch dialog and bulk editor also show the
   store choice. Move a master and all attached sub-issues together.
2. Confirm the move. Factory copies and verifies the report and retained issue
   history before switching the authoritative catalog entry. IDs, display
   numbers, and original report bytes remain stable. A merged issue stays
   read-only throughout storage migration.
3. If confirmation fails or the connection is lost, keep the draft and retry the
   same operation. The move retains its operation identity; it does not report
   success until authoritative readback confirms the destination.

Stop and upgrade older Factory runners on connected machines before activating
canonical stores. Older binaries cannot honor the new shared ownership records.
The first canonical bootstrap imports verified legacy reports, numbers, flows,
and evidence. Active legacy attempts or claims require explicit recovery first.
After bootstrap, the old shared-queue writer and refresh path stop. The catalog
owns issue routing; local Markdown and flow files become display projections.
Unconfirmed local edits are retained as drafts. Status changes, claims, and
storage refreshes do not update source HEAD, the source index, or workspaces.

## Verify a configured installation

Run the local contract and UI checks before a live cutover:

```sh
node --test scripts/store-settings.check.mjs scripts/store-runtime.check.mjs scripts/store-records.check.mjs scripts/store-artifacts.check.mjs
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

Permanent Delete removes the issue and its exclusively owned evidence. Files
shared with retained issues stay available. Archive retains the report and history.

1. Finish running project work before deleting an issue. Deletion holds shared
   changes while Factory checks retained references and removes unused evidence.
2. If deletion stops while the issue is still present, retry its original Delete
   action after the blocker clears.
3. If the issue is already absent, open **Project settings → Issue Storage** and
   click **Resume deletion**. The action resumes its original deletion command.
4. Restore an unavailable store, then retry the same action. Factory releases
   shared changes after authoritative cleanup confirmation.

Deletion leaves source worktrees to their existing cleanup controls. It does not
rewrite Git history, purge older S3 object versions, or change provider backups.
With S3 versioning disabled, removing an unused object deletes its stored bytes.

## Recover ownership

The ownership panel in Issue settings identifies a retained claim. Stop and
reconcile its original runner before selecting Recover ownership, confirming the
statement, and entering a reason. Recovery checks the exact issue, attempt,
runner and owner token. It retains the attempt history and fences a late result
from the original process; it starts no work. A merged issue stays read-only.

Local Stop remains available during a storage outage. Remote Stop stays requested
until the owning runner confirms cancellation. Neither an elapsed timeout nor a
Stop request releases ownership by itself.
