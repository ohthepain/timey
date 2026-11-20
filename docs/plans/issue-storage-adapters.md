# Alternatives to Git for issue storage

Research and proposal, 20 November 2026. This document proposes a direction. It
does not select a new provider or authorize a migration. Provider facts and
official sources are in the [provider evidence](issue-storage-provider-evidence.md).

## Recommendation

Introduce an issue storage adapter that owns reports, issue metadata, revisions,
display numbers, claims, and durable operation receipts. Keep Git as one adapter.
Use SQLite as the first alternative for one local authority and PostgreSQL as the
preferred shared alternative. DynamoDB is a strong option for an AWS deployment.

Treat Jira and GitHub Issues as tracker adapters with explicit field ownership.
They can supply the human-facing issue record, while a transactional store owns
Timey's execution claims and operation receipts. A tracker-only implementation
must prove the same concurrency guarantees before it can start shared work.

S3 can support a complete issue record through conditional writes. It deserves a
prototype if operating without a database is a priority. Separate claim and report
objects require more coordination than a filesystem-shaped adapter suggests.

These are design judgments based on the current code and the cited provider
guarantees. No provider was benchmarked or connected to a live Timey queue.

## What the current implementation needs

[ADR 0011](../adr/0011-share-issue-reports-on-the-target-branch.md) and the
[shared queue design](shared-issue-queue.md) make Git responsible for more than
file storage. The source currently divides those responsibilities as follows.

| Responsibility                   | Current owner and behavior                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue report and lifecycle state | Markdown with YAML metadata. `scripts/factory-ui/issue-report-storage.mjs` checks identity, stale content, regular files, and storage moves.        |
| Local queue reads                | `scripts/factory-ui/data.mjs` calls the factory ledger and reads local report files.                                                                |
| Shared reports and numbers       | `scripts/factory-ui/shared-issue-publication.mjs` publishes to the queue branch, checks conflicting report edits, and retains publication receipts. |
| Exclusive claim                  | `scripts/factory-ui/shared-issue-claims.mjs` creates a canonical remote ref only if absent. Release checks the exact owned object ID.               |
| Eligibility at claim time        | `scripts/factory-ui/shared-issue-queue.mjs` reads before claiming and rereads afterward. A changed report prevents work from starting.              |
| Display numbers                  | `scripts/factory-ui/issue-numbers.mjs` preserves assignments after report deletion. Shared publication allocates numbers against the current queue. |
| Archive                          | Reports leave the shared queue and remain in a local archive. Direct shared archive publishes removal and claim release in one atomic push.         |
| Execution and evidence           | Flow attempts, workspaces, transcripts, and much verification evidence remain runner-local. A shared report is not a portable running flow.         |

A replacement needs to preserve issue IDs, existing numbers, report text,
unknown metadata, evidence references, and decision history. New numbers must be
unique and never reused. There is no demonstrated requirement for gapless numbers.

Storage must keep these meanings separate.

- Lifecycle state records the issue's configured stage or closure.
- Execution state records what a run or block is doing and who owns it.
- Publication state records whether a requested checkpoint is durable and confirmed.
- Human acceptance remains an explicit domain decision. A provider's Closed label,
  a successful write, or an expired claim cannot supply acceptance.

## Comparison

The assessments below are recommendations for Timey, not measured performance
rankings. The [evidence note](issue-storage-provider-evidence.md) records the
underlying provider guarantees and their limits.

| Candidate                    | Reports, metadata, and history                                                                                                                                       | Claims and concurrent updates                                                                                                                                                   | Assessment                                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local Markdown and JSON      | Preserves the existing format and direct editing. Durable history, multi-file commits, and recovery need an explicit journal or snapshots.                           | Local locks coordinate cooperating processes on one filesystem. Separate clones are separate authorities.                                                                       | Retain for compatibility and export. Wrapping file reads alone does not replace shared Git.                                                                                          |
| Local SQLite                 | Transactions can save report, metadata, history, receipt, and claim together. No separate database server.                                                           | Conditional updates and uniqueness constraints suit one host. Multiple local processes can share the database, subject to SQLite's writer serialization.                        | Preferred local database. Several runners can use one owning service over an API, but must not each treat their own database as shared authority.                                    |
| PostgreSQL                   | Relational queries, constraints, and transactions fit issues, relationships, reports, and retained revisions. Audit history still needs application tables.          | Conditional updates and row locks can coordinate claims and checkpoints in a transaction.                                                                                       | Preferred general shared store. Requires a service, schema migrations, credentials, backups, and restore procedures.                                                                 |
| DynamoDB                     | Conditional item updates and transactions fit issue records and receipts. Access patterns need planned keys and indexes. Large reports may require separate storage. | Conditional writes can acquire and release exact claims. Regional transactions can bind several records. TTL deletion is not a claim protocol.                                  | Strong AWS alternative. Prefer one authoritative Region initially. Define how indexes become current and how large report objects are committed.                                     |
| S3                           | Strong consistency and conditional writes support a current issue object. Versioning can retain object history when enabled.                                         | Compare-and-swap works on one key. S3 provides no atomic transaction across separate report, claim, counter, and receipt keys.                                                  | Viable with an issue aggregate or a versioned manifest protocol. More custom coordination than PostgreSQL or DynamoDB. Useful separately for large artifacts.                        |
| GitHub Issues                | Native issues, comments, labels, links, and human collaboration. Timey metadata and Markdown need explicit mapping.                                                  | The issue update API does not establish the full claim, expected-revision, and checkpoint transaction required here. Assignments and labels alone do not establish exclusion.   | Useful tracker adapter. Pair with a proven coordination store unless a tracker-only design passes the contract. Account for rate limits, user edits, and ambiguous create responses. |
| Jira Cloud                   | Native workflows, issue fields, properties, comments, and history. Custom states and Timey decisions need project-specific mapping.                                  | Some property operations support conditional filters. The cited APIs do not establish one general transaction over issue edits, workflow transitions, and a fenced Timey claim. | Useful enterprise tracker adapter. Prove any property-based claim design rather than assuming properties lack conditional operations or guarantee everything needed.                 |
| Shared filesystem            | Familiar report files, but mount, lock, rename, and crash guarantees depend on the filesystem and deployment.                                                        | A network mount or sync folder does not establish the existing remote claim protocol. SQLite WAL is unsuitable across hosts on a network filesystem.                            | Avoid as a generic shared backend. One service owning local storage is a different, more defensible design.                                                                          |
| Redis                        | Can hold metadata and claims. Durable report history and recovery require explicit persistence choices.                                                              | Locks depend on expiry, ownership checks, failover behavior, and fencing. An ordinary asynchronously replicated lock can lose exclusion.                                        | Consider as a cache or a deliberately designed coordination component. Adds little value here if a transactional issue store already owns claims.                                    |
| etcd                         | Durable, versioned key-value operations and transactions. Report history and queries would still need a product-specific model.                                      | Strong coordination support through revisions and transactions. Leases do not by themselves stop a stale runner's external actions.                                             | Credible coordination backend when already operated. A separate claim service adds complexity to issue publication.                                                                  |
| R2 and Google Cloud Storage  | R2 documents strong consistency and atomic conditional writes. Cloud Storage supports generation preconditions.                                                      | The same multi-object coordination questions need a provider-specific protocol. S3 API compatibility alone is insufficient evidence.                                            | Credible object-store alternatives if hosting constraints favor them. They do not remove the need to coordinate numbers, claims, and history.                                        |
| Hosted SQLite through an API | A service such as Cloudflare Durable Objects can own SQLite storage with transactions and recovery.                                                                  | Shared authority comes from the service and its object partitioning, rather than a shared database file.                                                                        | Worth considering when it matches the deployment. Validate transaction boundaries and recovery for the chosen service.                                                               |

Here, local storage means server-owned files or SQLite. Browser `localStorage`
does not provide the shared transaction and coordination authority this design
requires. It can retain interface preferences or drafts, not authoritative claims.

## The adapter should express issue operations

A generic `get`, `put`, and `delete` interface would leave every caller responsible
for concurrency. Instead, the adapter should expose the operations whose guarantees
the application needs. These names sketch responsibilities rather than committed
signatures.

| Operation                        | Required guarantee                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listIssues` and `readIssue`     | Return bounded summaries or a complete report with a provider-neutral issue revision. List results may be stale. Execution decisions require an authoritative read.    |
| `createIssue`                    | Bind a stable request ID to one issue ID and one never-reused number. Replaying a confirmed request returns the same result.                                           |
| `acquireClaim`                   | Check the expected issue revision and exclusive ownership together, or use a verified claim-then-reread protocol. Return an opaque ownership token before work starts. |
| `checkpointIssue`                | Validate the expected issue revision and required ownership, then durably retain the report, metadata, history, and operation result. Reject stale input.              |
| `releaseClaim`                   | Release only the exact ownership token. A delayed release cannot remove another run's claim.                                                                           |
| `readOperation`                  | Resolve a lost response using the original request ID. Distinguish confirmed, rejected, and unresolved outcomes.                                                       |
| `readHistory` and `exportIssues` | Retain or export issue identity, reports, numbers, revisions, and evidence references without requiring Git.                                                           |

All mutations use request IDs. Reusing an ID with different input is an error.
Retain the operation result atomically with the mutation where the provider
supports it. Otherwise, the provider must document and test its durable recovery
protocol. A network timeout is an unresolved result, not proof of failure.

Use a single issue storage adapter as the coordination authority for a project.
It can delegate internally, but the application cannot independently choose a
report provider and a claim provider and assume their writes form a transaction.
A checkpoint must be confirmed before its claim is released. An atomic checkpoint
and release is preferable. A recoverable protocol that keeps the claim on failure
can preserve the existing safety rule.

Keep domain decisions above storage. Eligibility, approval, acceptance, configured
lifecycle transitions, evidence freshness, and merge permission remain Timey
rules. The adapter atomically enforces the revision and ownership conditions that
those rules rely on. It does not infer permission from a provider status field.

### Retain Markdown without maintaining two authoritative states

Initially, retain the complete current Markdown report as the canonical document.
Parse frontmatter for queryable fields and update any derived indexes in the same
transaction or through a documented versioned projection. Preserve unknown fields
and original report wording.

Do not make both a database `state` field and frontmatter `state` independently
editable. The mutation produces one canonical result and its derived fields.
The provider's storage revision can change when a claim changes, while the public
issue revision should identify report and decision changes. An internal S3 ETag,
Git object ID, or SQL row version need not become the domain's revision format.
For object-store compare-and-swap, include a new storage generation on every
mutation so that a record cannot return to identical bytes and accidentally
accept an old ETag after ownership changes.

History can be immutable report revisions with actor, request ID, reason, time,
and evidence references. Reconstructing every issue from an event log is optional.
Provider backups, S3 versioning, and database recovery do not automatically supply
the human-readable decision history that Git currently helps retain.

### Keep persistent claims until recovery is proven

The current policy requires confirmation that an interrupted runner stopped.
Preserve that policy in the first adapters. Do not replace it with automatic TTL
takeover as an incidental storage change.

An expiring claim would need renewal, a generation token, and rejection of stale
generations at every protected mutation. Even that cannot make an independent
Git push, code merge, or worker process participate in a database transaction.
External effects require their own ownership and recovery protocol. A timer alone
does not prove that the earlier runner has stopped.

## Tracker adapters need an ownership policy

Two modes are plausible, and both should use the same Timey issue interface.

- In Timey-owned mode, Timey stores the complete issue. A tracker adapter publishes
  selected fields and links through a retained outbound queue. Failed publication
  remains visible and retryable. Imported user edits follow an explicit policy.
- In tracker-owned mode, Jira or GitHub owns agreed report fields. Timey stores
  claims, execution records, operation receipts, and provider mappings separately.
  A tracker write and a Timey write are a recoverable multi-step operation, not a
  distributed transaction. Shared execution stays disabled until conflict and
  recovery behavior meet the claim contract.

Define ownership for title, description, comments, lifecycle state, closure reason,
and acceptance separately. Retain external IDs and URLs alongside Timey's stable
ID and number. A remote close can request reconciliation but must not silently
become accepted Fixed closure. Trackers must preserve unknown Timey metadata
somewhere explicit rather than losing it during a Markdown rewrite.

Webhooks are notifications to reread authoritative records. Deduplicate repeated
events and tolerate delayed or missing events. An ambiguous external issue create
must be reconciled against the original operation before another create is sent.
A failed mirror must not hold Timey's execution claim indefinitely once its own
required authoritative checkpoint is confirmed. Tracker-owned mode has a different
finish condition because the external write is part of its authoritative result.

## How the providers would implement the contract

- SQLite and PostgreSQL can keep issues, retained revisions, number assignments,
  claims, and operation results in transactional tables. PostgreSQL can serialize
  conflicting issue updates with a row lock or conditional update. Never hold a
  database transaction open for the duration of agent work.
  Factory storage needs its own ownership and deployment boundary. The rhythm
  app's existing PostgreSQL domain database is not evidence that every Factory
  runner already has an appropriate shared database.
- DynamoDB can use conditional writes and transactional items for the same
  responsibilities. Reads used for eligibility must use an appropriate strong
  read path. TTL may clean obsolete data later. It must not decide current ownership.
- S3 can put the report, report revision, claim, and recent operation identity in
  one issue aggregate and condition each replacement on the previous ETag. A durable
  request ledger, retained history, and the global number allocator still need a
  protocol. Alternatively, publish immutable objects through a conditional manifest
  update. A single project-wide manifest serializes publication across issues.
- The Git adapter can preserve today's queue branch, claim refs, and receipts.
  Keep queue commits distinct from code revisions and verification identities.

For S3, confirm the required immutable report and history objects before advancing
a current pointer. An interrupted preparation may leave unreferenced objects.
Readers must follow a confirmed manifest, and cleanup must preserve referenced
history and unresolved operations. This is a new storage protocol to prove.

## A bounded path to a decision

1. Approve an adapter contract against today's behavior. Build a provider contract
   suite using disposable queues and the existing shared-queue race scenarios.
2. Put the current local-file and Git behavior behind that interface. Migrate all
   authoritative readers and writers, including factory ledger code and installed
   issue helpers. A remote database adapter cannot replace only the publication path.
3. Implement SQLite to prove that reports and decisions can operate without a Git
   queue. Retain Markdown import and export for humans and existing tools.
4. Implement PostgreSQL if several runners need shared authority. Choose DynamoDB
   instead if an AWS deployment's operational constraints favor it. Prototype S3
   before selecting it as a full authority.
5. Add one tracker adapter after agreeing field ownership and synchronization
   direction. Test human edits and workflow transitions as well as machine writes.

The contract suite should race two owners for one issue, race creates for numbers,
reject stale updates, and preserve concurrent changes to different issues. It must
also cover lost responses, repeated requests, mismatched replay input, delayed
release, crash after checkpoint, pending publication, and interrupted archive.
Test that an unavailable authority permits cached reads but no new shared work.
Use real provider instances or suitable disposable installations for provider
proof. Mocked API responses alone cannot establish a provider's concurrency rules.

Before cutover, stop writers and reconcile existing claims and pending publications.
Import exact reports and the complete number registry, including reserved numbers.
Compare identities, bytes, locations, and history policy before selecting the new
authority. Avoid two writable authorities during migration. After new writes,
rollback requires importing those writes rather than pointing back to an old Git
snapshot. Git can remain a backup or export destination.

## Scope and decisions still open

This proposal changes the storage described in ADR 0011. A selected design needs
a replacement ADR. Moving archives into shared storage would also change the
local archive decision in [ADR 0012](../adr/0012-retain-closed-issues-and-archive-locally.md).
This investigation makes neither change.

The remaining product choices are whether the default is one local host or several
independent runners, whether a tracker owns user edits, and whether Flow records
and evidence must travel between runners. Reports and claims alone do not provide
execution handoff. Full handoff needs a separate scope covering attempts, chats,
artifacts, credentials, and worktree availability.

The working recommendation is local SQLite plus shared PostgreSQL, with Git
retained as a supported provider and Markdown export. DynamoDB is the AWS-specific
alternative. Jira and GitHub Issues remain valuable integrations with an explicit
coordination design.
