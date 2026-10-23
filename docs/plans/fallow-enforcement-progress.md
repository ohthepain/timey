# Fallow checkpoint enforcement

Issue: `20261022T205030878-caa1`. Starting revision:
`565a7e1a90ccea951e76b49b93620a158a01d2ff`.
The user selected the report and authorized scoped implementation with “let's go”.
Work is isolated in the existing Timey worker checkout; the coordinator-owned
report and registry are unchanged. No merge, live skill installation, publication,
factory launch or acceptance is part of this change.

## Changes

- The shared verification path invokes the pinned local Fallow 3.35.0 with
  `npx --no-install --offline fallow audit --base <resolved-ref> --gate all --format json`.
  Both the existing staged hook and new `npm run audit:step -- --base REF` use it.
- Audits cover whole changed files instead of a line-only diff. Inherited findings
  in those files are not waived. Exit zero alone is insufficient: warning verdicts,
  warnings on stderr, findings, unknown reports and degraded diagnostics fail.
- Step completion requires the recorded starting revision explicitly. Evidence
  records resolved base, source HEAD, exported tree, changed paths, command,
  result/reasons, raw JSON and logs. No global chat-completion interceptor is claimed.
- Snapshot children no longer inherit repository-local Git environment variables.
  Source reads still honor the actual staged index, including alternate indexes.
- Real disposable commit-hook tests cover failure without changing staged content,
  followed by successful commit after cleanup; source worktree/index are preserved.
- Test repository setup is shared with the factory invariant tests. The strict
  audit exposed complexity/duplication in the initial implementation; those were
  fixed without exclusions, threshold changes or suppressions.
- The audit also exposed unused `react-select`, `tailwind-merge` and `globals` in
  the modified package manifest. Repository searches found no package imports
  (Vitest's `globals: true` is unrelated). Removed those direct dependencies and
  their obsolete lock entries. Retained package versions did not change.

The verification/operating guides and codebase map describe enforcement and
limitations. Detailed factory policy remains in its existing linked operating
and verification guides; no protected skill installation is changed.

## Verification and limitations

Node 24.4.1; Fallow 3.35.0 and audit JSON schema 13 inspected from the actual
installed binary. No dependency/tool upgrade.

- `npm ci --offline --ignore-scripts`: passed for this checkout and a separate
  clean baseline checkout. The initial Prisma generation hit a protected home
  cache; generation succeeded using explicit read-only cached engine paths and
  wrote only generated dependency artifacts. No database connection was made.
- `npm run test:factory`: passed the expanded fixture suite, including actual
  hook commits, inherited findings, and step starting-ref enforcement.
- `npm run verify -- --base 565a7e1a90ccea951e76b49b93620a158a01d2ff`:
  strict Fallow, changed-file formatting, tooling fixtures, ten application tests
  and production build passed. Aggregate verification remains **failed** because
  application typechecking fails. This is not reported as full verification.
- A clean disposable checkout at the exact starting revision independently
  installed its original lock, generated Prisma, and ran `tsc --noEmit`: exit 2,
  44 nonempty diagnostic lines, byte-for-byte identical to the candidate's output.
  Compiler repairs belong to `20261022T163741000-bba3`; they were not folded in.
- Optional architecture boundaries and policy rule packs are not configured.
  Their diagnostics remain explicit unmeasured coverage, never claimed as passed
  detectors. All other emitted diagnostics and warnings fail closed.

The tooling change is suitable for a local progress commit under Timey's policy
for relevant automated checks. The app's aggregate typecheck, coordinator review,
integration and explicit issue acceptance remain outstanding. No human check was
passed, no issue was closed, and no production/device behavior is inferred.

Local raw evidence is under `.issues/evidence/` in this worker checkout. The
full-verification summary from the initial run is
`2026-10-23T16-13-32.876Z-e2b1a5ad-f991-4d47-b25e-ad2c1d95014d-summary.json`.
Baseline comparison: `.issues/evidence/fallow-caa1-baseline-pointer.json` points to
`/private/tmp/fallow-caa1/baseline-r1gans5w/comparison.json` (temporary storage).
That comparison established identical diagnostics; its facts are retained above
for a fresh-worktree handoff. Later checkpoint logs identify the final exported
source/index tree and their actual pass/fail results.
