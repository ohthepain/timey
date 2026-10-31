# Combined compiler repairs and Fallow checkpoints

Issues: `20261022T163741000-bba3` (compiler) and
`20261022T205030878-caa1` (audit checkpoints).

The user explicitly authorized reviewing the existing compiler work, combining it
with the Fallow candidate and running full verification. No merge into main or
live installation is authorized. The coordinator's queue/registry remain unchanged;
this is an isolated combined candidate, not acceptance of either issue.

## Preservation and source review

Combined branch starts with Fallow commit
`c518ee73f63e1af97352a08a5c00a2c793911bf5`, based on Timey
`565a7e1a90ccea951e76b49b93620a158a01d2ff`.
The compiler work came from the uncommitted working snapshot at
`/Users/paulwilkinson/.codex/worktrees/a374/timey`, HEAD
`9622756a93417b201200dc99fd5758ba5100c904`.

A frozen binary patch, all 15 modified/new files (including two untracked tests),
and SHA-256 inventory were captured under `/private/tmp/timey-combined-compiler`.
All 14 source/test file bases matched this branch before copying. The codebase
map was combined manually to retain both compiler boundary guidance and Fallow
checkpoint guidance. The original source checkout, HEAD, tracked edits and
untracked tests were preserved byte-for-byte; a post-copy inventory/status check
confirmed that fact. Temporary snapshots are supplementary evidence, not the
only surviving copy of the original work.

The two independent review axes reported **Standards: 0 findings; Spec: 0
findings**, including the narrow audit cleanup below. This is source review, not
physical-device or database-runtime evidence.

## Compiler changes

- Repositories acquire a checked server-only Prisma client when executing queries,
  through `getServerPrisma` or the typed `safeQuery` callback. Browser module
  imports still avoid constructing Prisma, and invalid query execution is rejected.
- Preserve the existing connection-error conditions and single reconnect/retry.
  Tests cover browser rejection, checked-client delivery, all existing retry
  triggers, exhaustion and propagation of unrelated errors.
- `withAuth` preserves handler result types. Tests cover type preservation, token
  and identity forwarding and unauthenticated rejection.
- Save-performance responses use the established plain-data `toJSON()` contract.
  The current save caller discards the response; fetch callers still reconstruct
  performance models from serialized data.
- Remove the unsupported/ignored `beat` prop passed to `Transport`; transport
  continues to use the navigation store. Correct sequence beat selection is not
  claimed by this compiler repair.

## Strict-audit cleanup

The first combined run passed typecheck, formatting, tests and build, but failed
strict audit on three inherited findings in changed files. They were repaired,
not waived:

- Make the unused `BeatProgressRepository` class export module-local; retain its
  exported singleton and all consumers.
- Preserve `methodRepository.getModuleProgress` by aliasing the identical query
  owned by `moduleProgressRepository`. Its function does not use `this`, and no
  reverse import/cycle was introduced.
- Reuse the existing `beatNoteSchema` for performance-note validation, preserving
  the exact original fields and constraints.

No audit threshold, detector, exclusion, suppression or recorded starting base was
weakened. The original compiler source was not edited for these cleanups.

## Executed verification

From the combined worker checkout:

```text
npm run verify -- --base 565a7e1a90ccea951e76b49b93620a158a01d2ff
```

**Passed all six checks:** strict Fallow (all findings in changed files), changed
formatting, 18 factory/audit tests, typecheck, 19 application tests and production
build. The 44 compiler-diagnostic lines are eliminated in this combined snapshot.

Local full-run summary:
`.issues/evidence/2026-10-23T17-04-59.505Z-5b7c45af-7810-4dcc-92db-9aa29a56d852-summary.json`.
Per-command raw logs and audit JSON share that prefix. The initial audit-failing
run is retained under prefix
`2026-10-23T17-04-19.868Z-be3aec91-d203-44a6-a38c-4ba2c033ba26`.
Later commit/step-checkpoint evidence binds the final candidate after this report.

The earlier [Fallow-only progress report](fallow-enforcement-progress.md) records
the historical red typecheck before these repairs were combined. It is not the
current combined verification verdict.

## Remaining limits

Automated verification does not establish live authenticated database behavior,
real browser sequence interaction, physical MIDI timing or human acceptance.
Architecture boundaries and policy rule packs remain explicitly unconfigured and
unmeasured. These limits remain visible; no human evidence is fabricated.

Keep this candidate local for review. No main merge, push, deployment, live skill
installation, lifecycle advance or issue closure occurred.
