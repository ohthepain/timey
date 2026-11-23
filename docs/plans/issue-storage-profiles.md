# Issue storage profiles implementation

Implement [ADR 0023](../adr/0023-select-issue-and-artifact-storage-per-issue.md).
Starting revision: `a591c367703743d16d51fb3f8d318bcabce3b773`.

## Work checklist

- [x] Ground the existing registry, catalog, artifact routing and UI.
- [x] Compare two implementation sketches and select the contract.
- [x] Confirm the product design with the user.
- [x] Implement registry migration, profile selection and per-issue artifact routing.
- [x] Implement checked group moves and UI controls.
- [x] Remove obsolete selection paths and update documentation.
- [x] Verify storage behavior, browser controls and the saved-base step audit.

## Implementation contract

The registry owns configured destinations, project mode, Coordination storage,
Coordination artifact storage and named profiles. Each profile pairs an Issue
store with an Artifact store. Each catalog entry saves its actual destinations.
Profile edits and defaults affect future choices only.

Provider record overflow uses the Coordination artifact store. Issue-owned
evidence and progress use a router bound to the saved issue Artifact store.
Reads retain physical artifact references and migration history.

Checked moves protect the complete master group, copy and verify owned artifacts,
and switch both catalog destinations only after verification. Existing destination
references stay authoritative after a failure. No shared artifact is deleted as
part of a move.

## Verification contract

Disposable fixtures must prove profile edits do not reroute issues, mode validation,
metadata-only legacy configuration migration, group compatibility for both store
IDs, per-issue evidence routing, and failed/resumed moves. Browser checks must
exercise profile selection and actual saved readback. Tests must not operate on
production records or require live cloud credentials.

## Design comparison

Selected explicit catalog `storeId` and `artifactStoreId` over a separate immutable
binding registry. Both sketches favored concrete saved destinations because they
avoid synchronizing another historical registry on each runner. Borrowed the
alternative's resolved pair in retry identity and saved-pair UI readback. Issue
routers bind their write destination without changing the shared provider router.
Per-issue moves preserve immutable references and use issue-bound readers that
prefer verified copies in the saved Artifact store. This also handles nested
references in immutable snapshots without global digest redirects or unbounded
cutover transactions.

The available models do not include the skill's Claude or Grok runners or judge.
Both sketches used the inherited model; the parent compared them against migration
safety, authoritative ownership, artifact separation and reader load.

## Verification results

- `pnpm run test:factory`: 1,348 passed, six opt-in provider cases skipped, no failures.
- Final runtime and UI checks: 19 passed. The legacy folder migration checks also
  pass after proving the old override cannot return when inheritance is restored.
- `node scripts/flow-browser.mjs --stores`: passed with real browser, HTTP and
  saved destination readback. A later focused UI regression verifies profile edits
  invalidate the selected issue's cached choices.
- `pnpm run typecheck`: passed.
- Strict saved-base step audit: passed with no new or worsened findings.
- `pnpm run build`: fails on installed TanStack router-core missing exports.
  An unchanged archive of the starting revision, using the same installed
  dependencies, reproduces the reported missing exports and build failure.

Local test and build evidence: `.issues/evidence/storage-profiles-3d4f426f-f8bd-4d3e-8b2d-27549e22ff52/summary.json`.
Browser evidence: `.issues/evidence/flow-browser-8337133d-824f-4670-a030-0320fe79a031/results.json`.

No live cloud cutover, deployment or production issue migration was performed.
Network isolation and authentication remain deployment responsibilities; the
profile change uses the existing guarded Factory APIs. Project mode changes after
version 2 activation require a future whole-project migration. Application-wide
build verification remains blocked by the reproduced dependency failure.

## Closure latency follow-up

Opening Close now reads saved issue context without waiting for a full shared
refresh. Confirming closure still refreshes authoritative state and runs the
existing acceptance checks. The dialog displays loading feedback if context is
not ready. A held-refresh HTTP regression proves preview and confirmation retain
their separate behavior.

Live closure of issue 197 exposed another queue-wide wait after a confirmed
report write. Publication and replay now refresh only the affected issue through
the existing scoped snapshot path. A regression forbids reads of an unrelated
issue and checks that its saved snapshot remains intact.

Issue 197 was closed as Fixed through the UI and remained closed after reload;
all six flow blocks, including Cleanup, completed. The menu was ready in 518 ms
in one live UI observation, including automation overhead. Closure acknowledgement
was observed by polling and is not a precise server-duration measurement.

## Issue 200 monitoring and confirmed writes

After committing and loading the profile and latency fixes, issue 200 was approved
and started through Factory. Its Request, Investigate, Generate report and Create
Issues blocks all completed without errors; the UI showed Flow complete and zero
running operations. The generated report explains the candidate revision change
and maps the five behaviors, while retaining the unavailable historical proof as
an explicit limitation. Create Issues linked the existing report rather than
creating a duplicate. No new application checks or issue acceptance were claimed.

Monitoring exposed unnecessary remote reads after confirmed coordination commits.
Operation creation, updates and confirmation now return the exact records in the
commit result. Fresh admission reads, revision checks, claim release and uncertain
commit recovery remain enforced. The regression failed before the change and
passes with reads of just-written operations made unavailable. The storage suite
passes with 185 checks and six opt-in skips. The strict step audit against
`d1033b047fb12bc289429e5148246f48bcacf24d` passes.

The live run included noticeable remote Git storage waits. Removing redundant
reads establishes fewer required network operations; it is not a measured live
speedup or a guarantee of bounded remote Git latency.
