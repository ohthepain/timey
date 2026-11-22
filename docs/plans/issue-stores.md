# Issue, Coordination, and Artifact stores

Draft specification, 22 November 2026. The user approved the product decisions
below and requested continued design discussion before implementation. Application
changes, infrastructure changes, migrations, and switching defaults remain paused.

[ADR 0022](../adr/0022-separate-issue-coordination-and-artifact-stores.md) records
the agreed architecture. The earlier [storage comparison](issue-storage-adapters.md)
and [provider evidence](issue-storage-provider-evidence.md) remain historical
context. They do not define the scope of this proposal.

## Purpose and supported stores

Keep the working files/Git implementation and make remote storage optional.
Exercise every implementation through shared behavioral contracts. Separate
issue data from execution ownership so a future external tracker can hold issues
without having to implement claims or store execution logs.

| Role               | Selection                        | Owns                                                                                                                               | Initial implementations       |
| ------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Issue store        | One configured store per issue   | Report, title, lifecycle status, priority, labels, relationships, and issue revision history                                       | Files/Git, DynamoDB, Postgres |
| Coordination store | One configured store per project | Claims, full flow graphs, attempts, input and definition snapshots, pending writes, recovery receipts, and remote control requests | Files/Git, DynamoDB, Postgres |
| Artifact store     | One configured store per project | Full logs, large outputs, screenshots, attachments, evidence, and committed source checkpoints                                     | Files/Git, S3, Postgres       |

All roles default to files/Git. A configured Postgres connection can serve several
Factory roles using separate records in one dedicated Factory database. Factory
must never use a database belonging to the installed application, even through a
different schema. The Factory database can share the application's Postgres
server or instance. A project can instead combine DynamoDB coordination with S3
artifacts. No separate database is required per Factory storage role.
Plain local files remain supported without a database or remote service. Shared
Git retains the dedicated queue design and does not update source workspaces.

SQLite and external issue tracker implementations are deferred. S3 is an Artifact
implementation in this release. DynamoDB holds artifact references, not large file
contents. Its item size limit is 400 KB. AWS describes the
[DynamoDB and S3 arrangement](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-use-s3-too.html).
Postgres also supports large text and binary values through
[TOAST storage](https://www.postgresql.org/docs/current/storage-toast.html).

## Store choice and defaults

Use the term Issue store in the product. Choices name configured destinations,
such as "Team issues · Postgres", rather than only database engines. Keep Issue
store distinct from Code destination, which selects the code delivery branch.

Show Issue store wherever an issue's destination branch is selected. This covers
creation, issue settings, project and folder defaults, bulk operations, and
follow-up creation. Preserve the separate meaning of Starting point.

Issue creation requires a visible, valid Issue store choice. Resolve its default
through the existing project, parent-folder, folder, and explicit-choice rules.
A valid default preselects the control. Missing or invalid configuration blocks
creation rather than choosing another backend silently.

Save the resolved store identity on creation. A later default change affects new
issues and does not move existing reports. An existing issue's store control
starts an explicit checked move. Coordination and Artifact choices are project
settings and do not follow per-issue or folder defaults.

Each issue has one authoritative Issue store. Preserve stable issue IDs, display
numbers, Markdown content, unknown metadata, relationships, and decision history
when moving it. Numbers remain unique within the project and are never reused.
The combined Issues view can list issues across stores and identify their stores.

## Shared execution and evidence

The Coordination store retains full flow and attempt history. Separate issue
lifecycle status from execution status and pending-publication status. Archive,
successful writes, and completed attempts do not imply human acceptance.

Any connected runner with project access can inspect history, edit idle issues,
and start eligible work on an idle issue. Existing approvals, eligibility, exact
candidate verification, merged-issue locks, and acceptance rules still apply.
Reading shared records starts no work and does not transfer a running process.

An active attempt belongs to its executing runner. Claims remain held until the
owner releases them or a person explicitly reconciles the attempt. Missing
heartbeats or elapsed time do not establish that the old runner stopped. Recovery
must reconcile outstanding external operations before another run starts.

Any connected machine can request Stop. Persist a command bound to the exact
attempt and owner. Show "Stop requested" until the owner confirms cancellation
or reconciliation establishes the outcome. Sending a command does not release
ownership. A stale command cannot stop a replacement attempt.

Keep checkout paths, process identifiers, sockets, credentials, and transient
caches local. Shared history identifies the originating runner but does not treat
its absolute paths as portable file references. Store large outputs and evidence
through Artifact references with immutable identity, size, media type, and digest.
Verify retrieved bytes before using them as proof. Missing or changed artifacts
remain visible as evidence gaps and cannot supply passing verification.

Local progress appears immediately. Other machines receive active progress and
growing logs through periodic shared updates. Batch those updates. Completion
must publish the complete retained output and its artifact references. Preserve
history without appending an unbounded log to a single DynamoDB item.

Share committed source checkpoints through the Artifact store so another runner
can continue eligible idle work before Publish. Bind each checkpoint to its
repository, source revision, tree, and integrity proof. Validate reconstruction
on the receiving runner. Uploading a checkpoint does not publish the issue branch
or PR and does not transfer an active process. Uncommitted and ignored files stay
local under this decision. A new runner still needs its own dependencies and
credentials, and the existing verification rules apply to its actual candidate.

## Coordination across stores and outages

Files/Git currently combines report publication and exact-owner claim release in
one queue commit. The new interface must also work when those records belong to
different stores. Keep a durable operation identity and recovery receipt spanning
the issue write, artifact publication, and ownership transition.

Confirm required artifact uploads before publishing references as available.
Confirm the authoritative issue update before releasing the corresponding claim.
An unknown write outcome remains pending until reconciliation identifies the
actual result. Retries must preserve operation identity and cannot duplicate a
creation or release a replacement owner's claim. A colocated implementation can
use an atomic commit where available. Separate stores need an explicit recovery
protocol. S3 and DynamoDB have
[no cross-service transaction](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-use-s3-too.html).

When a required remote store is unavailable, allow cached browsing and local
drafts. Block shared changes and new runs. Keep drafts separate from accepted
shared changes, and never silently switch the authoritative store.

Already-running Work may finish local edits and retain its results locally.
Those results remain pending. Publish, Merge, and subsequent blocks wait until
required shared state and artifacts are confirmed. Synchronization and recovery
retain the existing execution authorization and manual recovery rules.

## Migrations, groups, and archive

Include checked migrations in the first release. Support per-issue Issue store
moves and project-wide Coordination and Artifact store moves. Require affected
work to be idle and unresolved ownership or writes to be reconciled first.

Migration copies and verifies data before switching authority. Retain resumable
receipts and the source until cutover is confirmed. A lost response must not
leave two writable authorities. Preserve recorded evidence gaps rather than
inventing missing bytes. Changing settings alone performs no migration.

A master and all attached sub-issues must use the same configured Issue store in
this release. Reject mixed-store grouping and individual moves that would break
the group. The reviewed move must cover the affected group. Accepting the master
retains the existing Fixed by closure and evidence requirements.

Archive is shared. Retain the report, flow, attempt history, and artifacts in
their configured stores. Hide archived issues from active queues on every runner
and allow any connected runner to browse the archive. Preserve display numbers.
Archive does not delete evidence or move it to the initiating machine.

This changes the local archive policy in [ADR 0012](../adr/0012-retain-closed-issues-and-archive-locally.md)
and the local-history scope of [ADR 0019](../adr/0019-share-issue-claims-on-the-queue-branch.md)
when the feature is implemented. Until then, their documented runtime behavior
remains in effect. No new automatic retention or deletion policy is approved.

## Connections and resources to prepare

These names were supplied by the user. No secret values were inspected, and no
live resource or permission checks were performed during this design discussion.

| Setting                                           | Purpose                                                |
| ------------------------------------------------- | ------------------------------------------------------ |
| `FACTORY_ISSUES_DB_URL`                           | Postgres connection address and database               |
| `FACTORY_DB_USER`                                 | Postgres user                                          |
| `FACTORY_DB_PASSWORD`                             | Postgres authentication                                |
| `FACTORY_ARTIFACTS_BUCKET`                        | Existing S3 bucket for shared artifacts                |
| `AWS_REGION` or the configured AWS profile region | AWS resource region                                    |
| Existing AWS role or profile                      | Credentials for the selected S3 and DynamoDB resources |

Store choices and connection references belong in project configuration. Keep
credential values in the existing secret mechanisms. Connections can be reused
across roles. Merely adding connection settings does not change files/Git defaults.

Prepare a dedicated Factory database. For example, if Timey uses `timey_db`,
Factory can use `timey_issues_db` on the same Postgres server. A separate schema
inside `timey_db` is not allowed. `FACTORY_ISSUES_DB_URL` must target the dedicated
Factory database. Configuration validation must reject the installed application's
database target, including connections that differ only in credentials or schema.

`factory` is the proposed schema name inside the dedicated Factory database.
A migration identity needs ownership or appropriate creation privileges there.
Runtime privileges should cover Factory's own objects, without requiring a
superuser. PostgreSQL documents
[schema access and creation privileges](https://www.postgresql.org/docs/current/ddl-schemas.html).
Do not hand-create application tables before reviewing the migrations.

The proposed logical data groups are issue records and revisions, a project issue
catalog, flows and attempts, claims, operation receipts, runners and control
requests, migration receipts, and optional Postgres artifact bytes. Physical
table names, indexes, and relations remain implementation design work. These
groups do not require separate databases.

The existing artifact bucket is sufficient. Isolate projects and disposable tests
with separate prefixes. Grant the application access to the selected prefixes.
The baseline S3 operations require bucket listing and object reads and writes.
Explicit deletion and test cleanup need object deletion permission. Final IAM
policies must include any chosen multipart upload operations. AWS documents
[S3 operations and IAM actions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security_iam_service-with-iam.html).
Keep the bucket private and avoid automatic expiration of retained evidence while
the application's retention policy is undecided.

Use the existing AWS credential mechanism. The JavaScript SDK supports a
[default credential provider chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
and accepts the region through [`AWS_REGION` or shared configuration](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-region.html).
No new application-specific AWS access-key secret is required by this proposal.

Choose the AWS account and region for DynamoDB. Leave table creation until the
provisioning template defines partition keys, sort keys, indexes, capacity mode,
and project namespaces. Issue and Coordination records are separate logical
datasets. Their physical table count is not settled. Include isolated database
and AWS test namespaces before running destructive integration checks.

## Contracts and implementation planning

Files/Git must implement the same interfaces used by other providers. Remove
direct filesystem and Git assumptions from readers and workflows as callers move
to those interfaces. Keep provider mechanics inside the implementations.

Use separate shared suites for Issue, Coordination, and Artifact behavior. Add
composition checks because a transaction inside one implementation does not prove
correct behavior across stores. Run concurrency and recovery checks against real
disposable provider fixtures, alongside provider-specific protocol tests.

Required observable cases include the following:

- Valid creation defaults and explicit overrides, with a stored resolved Issue
  store and unchanged existing homes after default changes.
- The same issue reads, report updates, revision conflicts, and stable numbers
  across files/Git, DynamoDB, and Postgres implementations.
- Exclusive claims, exact-owner release, duplicate requests, unknown outcomes,
  runner restart, manual reconciliation, and no automatic expiry.
- Shared full flow and attempt history, portable artifact reads, live progress,
  source checkpoint reconstruction, and remote Stop acknowledgment.
- Corrupt or missing artifacts, interrupted uploads, and pending issue writes
  that cannot produce a false completed result or premature claim release.
- Cached browsing and local drafts during outages, local completion of existing
  Work, and blocked downstream operations until synchronization is confirmed.
- Per-issue and project migrations interrupted before and after cutover,
  preserved references, verified data, and exactly one authority.
- Same-store group constraints and acceptance, shared archive visibility and
  retained history, and preservation of merged-issue and human acceptance guards.
- No source HEAD, source-index, or working-file updates caused by issue, claim,
  flow, status, artifact, or archive refresh.
- Connection diagnostics and test output that reveal references and availability
  without exposing credentials or modifying production issues.
- Dedicated Factory database validation that rejects the installed application's
  database, including a separate schema or different credentials on that database.

Draft the concrete interfaces, physical schemas, DynamoDB access patterns,
checkpoint format, progress batching, and provisioning templates before coding.
Coordinate Settings integration with its separate issue, which currently scopes
its storage page to already implemented providers. This specification does not
expand that issue's authorized implementation scope.

The next checkpoint is review of this specification and the concrete schema and
interface proposal. No provider implementation, resource creation, connection
test, migration, publication, deployment, or issue closure is authorized here.
