---
status: proposed
---

# Select Issue and Artifact storage per issue

The storage design interview has settled the boundaries below. The remaining
questions are open, and this design has not been implemented.
[ADR 0022](0022-separate-issue-coordination-and-artifact-stores.md) describes the
current implementation, including its project-wide Artifact store.

## Settled decisions

Each project has one Coordination store shared by all its issues. Issue and
Artifact stores are selectable per issue. This preserves a single project
authority for execution ownership while allowing different storage destinations
for issue records and retained files.

An Issue storage profile names a pairing of Issue and Artifact stores.
An issue saves its actual destinations. Creation defaults supply initial choices;
later changes to defaults or profiles do not move existing issues.

Local storage means files on the person's local machine. Remote Factory servers
do not use local file stores for issue records or artifacts. Combining local
files with a remote issue is outside the supported design.

Each project operates in either local mode or remote mode. Profiles must be
compatible with that mode. One coordination authority managing both laptop-only
issues and remote issues is outside the initial scope.

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

## Open decisions

- How existing project-wide Artifact storage settings migrate to the new model.
- How profile defaults, edits, and removal are presented and validated.
- How provider kinds map to local and remote project modes.
- How artifacts without an owning issue select a destination.
