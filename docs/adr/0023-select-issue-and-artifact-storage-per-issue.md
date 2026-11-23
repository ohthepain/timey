---
status: accepted
---

# Select Issue and Artifact storage per issue

The design interview confirmed these storage boundaries. This decision revises
the project-wide Artifact selection in
[ADR 0022](0022-separate-issue-coordination-and-artifact-stores.md).

## Settled decisions

Each project has one Coordination store shared by all its issues. Issue and
Artifact stores are selectable per issue. This preserves a single project
authority for execution ownership while allowing different storage destinations
for issue records and retained files.

An Issue storage profile names a pairing of Issue and Artifact stores.
An issue saves its actual destinations. Creation defaults supply initial choices;
later changes to defaults or profiles do not move existing issues.

Project and folder defaults select profiles. Creation displays the resolved
profile choice and requires valid destinations. Invalid selections block creation
without a fallback. Profile edits affect future selections only. Retiring a
profile removes it from new choices and preserves existing issues' destinations.

Local storage means files on the person's local machine. Remote Factory servers
do not use local file stores for issue records or artifacts. Combining local
files with a remote issue is outside the supported design.

Each project operates in either local mode or remote mode. Profiles must be
compatible with that mode. One coordination authority managing both laptop-only
issues and remote issues is outside the initial scope.

Local mode uses file stores on the person's machine. Remote mode supports Git,
Postgres, and DynamoDB for Issue and Coordination storage, and Git, Postgres, and
S3 for artifacts. The UI distinguishes Local files from Git. Git storage is
remote-backed even when a local checkout caches its records. Mode is fixed after
version 2 configuration is saved. Converting an existing project between modes
requires a future whole-project migration.

The project also selects one Coordination artifact store for retained coordination
data that has no owning issue, including large project records and operation
receipts. Issue artifacts use each issue's selected destination. Coordination
artifacts use the explicit project selection. This selection must be compatible
with the project's storage mode.

A master issue and all its sub-issues must use the same configured Issue store
and the same configured Artifact store.
Grouping compares the actual configured destinations rather than profile names.
If either destination differs, grouping is blocked until the selections match.
Grouping never moves data implicitly.

Changing an existing issue's selected storage requires an explicit checked move
of its records and artifacts. A master and all its attached sub-issues move as
one group. A move requires affected work to be idle and verifies copied data
before switching destinations. A failed move preserves the original destinations.

Coordination storage requires private, controlled access from the owning Factory
server. Sharing a VPC is not a universal requirement. Remote debugging uses an
authenticated Factory API with permission enforcement and recorded operations.
The initial interface permits inspection of issue records, flows, attempts, logs,
and artifacts. Execution uses existing guarded Factory operations. Direct database
writes, debugger attachment, and local execution against remote coordination
remain outside the initial debugging scope.

The first implementation uses the existing providers. External trackers and
additional storage providers remain future extensions.

## Migration

Configuration migration preserves current destinations. Generate profiles from
existing Issue-store and Artifact-store pairs, and save actual destinations on
existing issues. Preserve the existing project Artifact destination for
coordination artifacts. This migration copies no artifact contents and preserves
historical references.

An existing configuration that violates the new mode or grouping rules requires
explicit resolution before the new model activates. Migration does not silently
move data to satisfy those rules.
