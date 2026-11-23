---
status: accepted
---

# Separate Issue, Coordination, and Artifact stores

These accepted decisions define the implemented storage boundaries. See the
[configuration and migration guide](../agents/issue-stores.md) for setup and
provider checks.

An issue selects one Issue store for its report, lifecycle state, and metadata.
Each project selects one Coordination store for claims and full flow and attempt
history, and one Artifact store for file contents and source checkpoints. The
roles can share a configured connection or use different implementations.

Postgres storage uses a dedicated Factory database. It can share a Postgres server
or instance with the installed application, but must never use the application's
database, including through a separate schema. Factory storage roles can share
the dedicated Factory database.

Support files/Git, DynamoDB, and Postgres for Issue and Coordination stores, and
files/Git, S3, and Postgres for Artifact stores. Default all roles to files/Git.
Expose Issue store alongside Code destination, require it at creation, and support
project and folder defaults. Store selection names a configured destination.

This separates issue ownership from execution coordination so future external
trackers need only implement issue storage. Across stores, retain pending writes
and claims until their outcomes are confirmed. Preserve exact-owner release and
explicit recovery rather than introducing time-based takeover.

Share complete history, evidence, periodic progress, and committed source
checkpoints across runners. Any eligible connected runner can start idle work.
Active attempts retain their runner ownership and accept acknowledged remote Stop
requests. During an outage, allow cached reads and local drafts, and let current
Work finish locally with pending results. Block new runs and downstream delivery
until required shared state is confirmed.

Include checked migrations and shared archives. Keep each master and its
sub-issues in one configured Issue store. This revises the future local-history
scope of [ADR 0019](0019-share-issue-claims-on-the-queue-branch.md) and archive
policy of [ADR 0012](0012-retain-closed-issues-and-archive-locally.md). Their
shared-store paths now retain archives and history across connected runners.

Permanent Delete removes exclusively owned evidence after checking retained
records and receipts across store migrations. Keep shared objects and minimal
operation tombstones that prevent deleted payloads from returning on replay.
Interrupted cleanup remains resumable from Project settings after the issue
disappears. Archive retains its history and evidence.

The [store specification](../plans/issue-stores.md) records the user decisions,
resource preparation, and shared contracts.
