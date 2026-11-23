# Evidence for issue storage providers

Historical provider research. The [store specification](issue-stores.md) records
the later decision to separate issue storage from coordination and artifacts.
Its recovery protocol replaces this note's proposed single-provider coupling.

Research checked against official sources on 2026-11-20. This note separates
documented guarantees from design inferences. It does not select a provider or
change Timey's accepted architecture.

The [current recommendation](issue-storage-adapters.md) retains local files and
focuses on isolating shared Git metadata from source workspaces. SQLite remains
in this comparison as a technical option, not a proposed local migration.

Timey currently keeps shared reports and display numbers on the `issue-queue`
branch. Remote claims coordinate runners. Local execution state and evidence
remain local. Claims do not expire automatically. Recovery requires confirmation
that the old run stopped. See [ADR 0011](../adr/0011-share-issue-reports-on-the-target-branch.md)
and the [shared queue design](shared-issue-queue.md).

## Documented provider guarantees

### Local files and SQLite

SQLite supplies atomic transactions and crash recovery through its journal. Its
guarantees depend on functioning filesystem locks and disk flushes.
[SQLite atomic commit](https://sqlite.org/atomiccommit.html).

WAL allows readers alongside a writer, but only one writer can append at a time.
All participating processes must share one host. WAL does not work over a network
filesystem. Its WAL file can contain committed data that is absent from the main
database file. The online backup API creates a consistent snapshot of a running
database. [SQLite WAL](https://sqlite.org/wal.html),
[SQLite backup API](https://sqlite.org/backup.html).

Design inference: local SQLite is a strong candidate when one Timey server owns
the data, including several browser clients using that server. Separate SQLite
files on several runners do not create shared authority. Plain Markdown files
remain useful exports, but a file implementation must supply its own locking,
revision checks, multi-file publication, and recovery protocol. SQLite supplies
those transaction mechanisms within one database. Neither format supplies
application-level issue history automatically.

Browser `localStorage` is different. The HTML standard tells authors to assume no
locking mechanism between agent clusters. IndexedDB supports transactions and
offline browser data, but browser storage has quotas and eviction rules.
[HTML Web Storage](https://html.spec.whatwg.org/multipage/webstorage.html),
[IndexedDB transactions](https://www.w3.org/TR/IndexedDB/#transaction-concept),
[Storage Standard](https://storage.spec.whatwg.org/).

Design inference: browser storage suits cached views and offline drafts. It does
not provide cross-machine claim ownership or the same backup contract as a local
server database.

### PostgreSQL

PostgreSQL supports row locks and transaction-scoped advisory locks. Serializable
transactions detect conflicting execution and can abort, so callers must retry
the whole transaction. [Explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html),
[transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

WAL supports crash recovery. A base backup plus archived WAL supports point-in-time
recovery. Durability depends on settings such as `fsync` and `synchronous_commit`,
and failover behavior depends on replication configuration.
[Continuous archiving](https://www.postgresql.org/docs/current/continuous-archiving.html),
[WAL settings](https://www.postgresql.org/docs/current/runtime-config-wal.html).

Design inference: a short transaction can atomically check the issue revision and
claim owner, update the report and status, append a history record, and release
the claim. A long-running worker needs a durable claim row rather than an open
database transaction. PostgreSQL is the broadest shared-store fit here, at the
cost of operating or buying a database service, backups, connection management,
and schema migrations. Application history still needs a table. There is no
universal PostgreSQL API rate quota comparable to a hosted tracker, but server
capacity and connection limits remain real constraints.

### DynamoDB

Write conditions support create-if-absent, revision comparisons, and conditional
deletes. Transactions atomically change up to 100 distinct items totaling 4 MB
within one account and Region. Transaction client tokens provide a 10-minute
idempotency window. [Condition expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html),
[DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html).

Successful writes are durably persisted. Reads default to eventual consistency.
Tables and local secondary indexes support strong reads, while global secondary
indexes do not. TTL deletion usually happens within days, rather than at the
expiration instant. [Read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html),
[TTL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html).

PITR retains up to 35 days. Streams retain records for 24 hours, so streams alone
are not permanent issue history. Individual items have a 400 KB size limit.
[PITR](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Point-in-time-recovery.html),
[Streams](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.CoreComponents.html),
[constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html).

Design inference: DynamoDB is a credible managed AWS alternative. Store reports,
claim revisions, and durable operation IDs in a transaction, with append-only
history items. Claim eligibility must use write conditions, not a stale index or
TTL disappearance. Access patterns, item sizes, capacity, and throttling require
more design than a relational model. This note establishes the single-Region
transaction case, not a cross-Region claim protocol.

### S3 and other object stores

S3 supports create-if-absent with `If-None-Match: *`, overwrite with `If-Match`
against an ETag, and conditional deletion. Conflicts can return `412`, `409`, or
`404`, depending on the concurrent operation.
[Conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html),
[conditional deletes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-deletes.html).

S3 provides strong reads and atomic updates for a single key. It explicitly does
not provide atomic updates across keys. Versioning retains earlier complete
objects and supports recovery, subject to deletion and lifecycle policies.
[S3 consistency](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel),
[versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/versioning-workflows.html).

Design inference: S3 can compare and swap one complete issue object containing
its report, status, claim, and a revision that changes on every mutation. Separate
claim and report objects cannot atomically check ownership and publish the
report. An immutable-history-object plus current-pointer design needs a protocol
for orphan objects, retries, and interrupted pointer publication. A project-wide
number allocator is another coordination boundary. Object storage removes a
database server, but adds these application responsibilities. SDK retries must
distinguish contention from an unknown outcome.

Other stores require provider-specific evidence. R2 explicitly documents atomic
conditional writes and globally strong consistency. Google Cloud Storage
documents generation-match preconditions, including generation `0` for
create-if-absent. These are useful alternatives, not proof that every
S3-compatible endpoint has equivalent semantics.
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[Cloud Storage preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions).

### Jira Cloud and GitHub Issues

Jira exposes issue fields, workflow transitions, and changelogs. Its bulk issue
property setter supports `currentValue` and `hasProperty` filters and is
documented as transactional and asynchronous. The ordinary single-issue property
setter is a separate endpoint. [Jira issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/),
[Jira issue properties](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/).

Jira currently documents hourly points quotas, endpoint burst limits, and
per-issue write limits. App traffic and API-token traffic have different quota
rules. Clients must handle `429` and `Retry-After`.
[Jira rate limits](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/).

GitHub's issue update API documents fields and permissions, but no expected
revision or `If-Match` write precondition. Its issue lock controls conversation
participation. Timeline APIs expose issue activity. GitHub App installations
start at 5,000 REST requests per hour, with higher limits in some installations.
Secondary limits generally allow at most 80 content-generating requests per
minute and 500 per hour, with endpoint-specific exceptions.
[GitHub issue API](https://docs.github.com/en/rest/issues/issues),
[timeline API](https://docs.github.com/en/rest/issues/timeline),
[GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

Design inference: both trackers offer human workflows and activity history, but
neither reviewed contract establishes the whole Timey claim-and-publication
transaction. A Jira conditional property operation deserves a focused concurrency
prototype if native Jira authority is required. An assignee, label, conversation
lock, or read-before-write check is insufficient evidence of an exclusive claim.
Keep tracker synchronization separate from claim authority until the required
guarantees are proven. Tracker changelogs are not automatically a restorable
Timey event log. Both remote APIs require connectivity for authoritative writes.

### Redis and etcd

Redis supports isolated command groups and optimistic checks through `WATCH`.
It does not roll back commands that fail during transaction execution. Its
distributed-lock documentation warns that asynchronous replication and failover
can violate mutual exclusion, and recommends fencing tokens. Persistence options
make different data-loss tradeoffs.
[Redis transactions](https://redis.io/docs/latest/develop/using-commands/transactions/),
[distributed locks](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/),
[persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).

etcd documents durable, strictly serializable KV operations, conditional
transactions, leases, and monotonically increasing revisions. Its docs warn that
holding a lease alone does not establish lock ownership. Historical revisions
remain available only until compaction. Operating etcd includes compaction,
snapshots, and storage quota management.
[API guarantees](https://etcd.io/docs/v3.6/learning/api_guarantees/),
[coordination semantics](https://etcd.io/docs/v3.6/learning/why/),
[maintenance](https://etcd.io/docs/v3.6/op-guide/maintenance/).

Design inference: Redis is a poor default for durable issue authority when its
main appeal is expiring locks. etcd fits a dedicated coordination service, but
adds another service and does not replace long-term report history without an
application retention design. Either choice still needs downstream checks to
reject a stale worker.

## Cross-provider implications for Timey

These conclusions are design inferences from the guarantees above.

- Claim acquisition, ownership checks, report publication, and release belong to
  one authority. A storage interface should expose those operations rather than
  promise that arbitrary key-value storage can implement them safely.
- A fencing token is an ownership generation that the destination checks on
  every protected write. Lease expiry does not stop a paused worker. A token in
  a database cannot fence a Git push or merge unless that destination enforces
  the token or Timey also enforces a compatible conditional operation there.
- Preserve Timey's explicit stopped-run recovery unless automatic takeover is a
  deliberate product change. Provider TTL support alone does not justify it.
- Persist an operation ID and its outcome so a lost response can be reconciled.
  Built-in idempotency windows do not replace indefinite recovery records.
- Keep offline drafts distinct from accepted shared mutations. During a network
  partition, a disconnected runner cannot prove exclusive shared ownership from
  its cache. A local single-host deployment can continue using its local database.
- Backups restore infrastructure state. Timey still needs issue revisions and
  operation history that explain who changed what and allow conflict resolution.

A hosted SQLite API is another shared service, not a network-mounted SQLite
file. For example, SQLite-backed Cloudflare Durable Objects expose transaction
APIs and 30-day PITR. Its authority and transaction boundaries still need to
match the chosen object partitioning.
[Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

No concurrency prototype, migration, pricing comparison, benchmark, or recovery
drill was performed for this note. It establishes candidate guarantees and the
specific assumptions a provider implementation must verify.
