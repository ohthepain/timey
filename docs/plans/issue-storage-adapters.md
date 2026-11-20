# Alternatives to Git for issue storage

Research and proposal, 20 November 2026. This document proposes a direction. It
does not select a new provider or authorize a migration. Provider facts and
official sources are in the [provider evidence](issue-storage-provider-evidence.md).

## Recommendation

Keep local issues in files. The user's clarified concern is shared issue visibility
and status changes advancing source branches, which then require workspace updates.
Replacing local storage with a database does not address that concern.

First complete the separation already described in ADR 0011. Shared reports,
lifecycle state, display numbers, and any shared execution summary belong on one
dedicated metadata branch. Claims can become files on that same branch instead
of separate remote branches. The shared adapter reads and writes that branch
without checking it out into a source workspace.

Retain the broader provider comparison for deployments that need it. PostgreSQL
and DynamoDB remain credible shared alternatives, but neither is required to fix
source-branch churn. Jira and GitHub Issues remain possible tracker adapters with
explicit field ownership and a proven claim protocol.

These are design judgments based on the current code and the cited provider
guarantees. No provider was benchmarked or connected to a live Timey queue.

## One metadata branch can hold reports, statuses, and claims

Use one branch such as the existing `issue-queue`, with separate paths for reports,
claim records, and number assignments. Lifecycle state is already report metadata.
It does not need its own branch or a second authoritative status file. If a shared
execution summary needs its own record, keep it on the same metadata branch.
Full local Flow attempts and workspaces remain separate in scope.

Each mutation reads the current remote tip, checks the relevant issue revision and
ownership token, and builds a commit whose parent is that tip. A normal push can
advance the branch when no competing writer won first. Otherwise, fetch again and
revalidate the operation against the new tip before building a new commit. Preserve
unrelated changes. Never force past another writer or retry a stale claim decision
without revalidation. Git documents this protection in its
[push rules](https://git-scm.com/docs/git-push#_push_rules).

Acquiring a claim means committing a record only when the latest tree has no claim
for that issue and its report is still eligible. Start work only after confirming
the operation and current ownership. Releasing a claim checks the exact attempt
token. A status checkpoint and its claim release can be one commit and one branch
update. Lost push responses still require durable operation IDs and reconciliation.
Preserve stopped-run recovery rather than adding automatic claim expiry.

The adapter can construct trees and commits using an isolated index and private
refs, as today's publication path already does. Git's
[commit-tree command](https://git-scm.com/docs/git-commit-tree) creates a commit from
a tree and parent without requiring the source workspace to check out that tree.
An isolated bare repository is another implementation option. Readers fetch the
metadata branch into a private ref and refresh an ignored local cache. Metadata
refresh must not merge, rebase, move source HEAD, dirty source files, or invalidate
code verification merely because the metadata commit changed.

The tradeoff is one shared publication point. Two different issues can compete
for the same branch tip, so the adapter must retry unrelated updates safely.
Claims add commits to metadata history, but do not require source workspace
updates. This is a reasonable initial design for Timey's stated problem. A shared
database becomes more attractive if measured contention or operational limits
make this publication protocol burdensome.

Automatic commits need a metadata-only path allowlist and narrowly scoped writer
permission. Existing code-review, source-branch protection, acceptance, and merge
authorization remain independent.

### The checkout does not yet match its configured separation

At investigation time, `factory.config.json` enables `sharedIssueQueue`, selects
`issue-queue`, and enables direct publication. However, the current source branch
still tracks issue reports. Its `.gitignore` contains `!/.issues/*.md`, which also
permits new report files to enter source commits. These observations establish a
remaining source-tracking path, not a complete diagnosis of a running deployment.

Recheck those observations with the following read-only commands.

```sh
git ls-files -- ':(glob).issues/[0-9]*.md' ':(glob).issues/closed/[0-9]*.md' .issues/issue-numbers.json
git check-ignore --no-index -v .issues/EXAMPLE_ISSUE_ID.md
```

Complete the report cutover before attributing workspace churn to Git storage as
a whole. Back up and verify authoritative shared copies, remove tracked report
copies from source through the normal source-change process, and ignore report
caches while retaining explicit policy-file exceptions. Existing workspaces need
that source migration once. Subsequent status changes should refresh issue data
without changing their source revisions. Consolidating claim branches is an
additional simplification and can follow independently.

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
| Local SQLite                 | Transactions can save report, metadata, history, receipt, and claim together. No separate database server.                                                           | Conditional updates and uniqueness constraints suit one host. Multiple local processes can share the database, subject to SQLite's writer serialization.                        | Technically viable, but outside the clarified need. Keep local files.                                                                                                                |
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
2. Complete the dedicated-branch cutover. Prove that an issue status update changes
   shared metadata while source HEAD, source status, and code verification identity
   remain unchanged in two independent runner checkouts.
3. Put shared operations behind an adapter and consolidate claims into files on
   the metadata branch. Race claim acquisition, checkpoint, and release against
   unrelated issue writes. Preserve local issue files and existing reports.
4. Retain PostgreSQL, DynamoDB, S3, and trackers as optional shared adapters. Build
   another provider only when its deployment or collaboration benefits justify it.

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

The dedicated metadata branch follows ADR 0011. Consolidating claims changes the
remote-claim design and needs its own recorded decision and contract proof.
Selecting a non-Git shared authority would supersede ADR 0011. Moving archives into shared storage would also change the
local archive decision in [ADR 0012](../adr/0012-retain-closed-issues-and-archive-locally.md).
This investigation makes neither change.

The remaining choices concern which execution summaries need shared visibility,
whether a tracker owns user edits, and whether full Flow records and evidence must
travel between runners. Reports and claims alone do not provide
execution handoff. Full handoff needs a separate scope covering attempts, chats,
artifacts, credentials, and worktree availability.

The working recommendation is local files and one shared Git metadata branch,
accessed through an adapter without updating source workspaces. First complete
the source-report separation. Consolidate claim branches as a separate improvement.
