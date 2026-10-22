# Software factory progress

Implementation approved on 2026-10-22. This is the bootstrap handoff, not a claim
that the live multi-chat factory or pilot has been proven end to end.

## Delivered

- Short `AGENTS.md` router plus codebase, verification, operating, tracker, and
  domain/documentation guides. Agents maintain affected documentation with code.
- npm lockfile/runtime conventions, pinned Fallow 3.35.0, isolated snapshot
  verification, staged audit hook, and CI evidence upload. The duplicate pnpm
  lockfile is removed; npm is the existing README/CI convention.
- Manual repo-scoped `$factory` skill: evaluate, separately launch a saved action,
  or explicitly finalize a completed action with `integrate`. No timer or daemon.
- Locked, atomic dispatch ledger with source/queue freshness, exclusive claims,
  duplicate prevention, pending-setup recovery, explicit lost-registry recovery,
  and completed-worker review/verification paths.
- Local human-check schema and lifecycle overrides permitting progress commits
  while preserving pending human evidence/judgment and closure acceptance.
- The shared `tutorial` manifest now declares `name: tutorial`; its packaging
  checks and all eight shared skill metadata/reference checks passed. This small
  fix is in the shared local-issues-skills checkout, separate from this repo.

## Evidence

- Disposable baseline: both Vitest files passed (10 tests); production build passed.
  Recorder tests created root CSV output and a backup, establishing the pilot's
  real side effect. Product test sources have not been changed by bootstrap.
- Baseline TypeScript diagnostics: 44 lines; unchanged after bootstrap. These
  include Prisma nullability and existing UI typing. Repository formatting also
  has 13 inherited source-file failures. Local issues capture both separately.
- The isolated verifier reports each check independently and fails overall if
  any required command fails. Typechecking remains red; it is not suppressed in
  CI or reclassified as passed.
- Factory checks use disposable Git fixtures: planning without dispatch, stale
  code/queue, duplicate and overlapping launches, independent reservations,
  human evidence/judgment separation, uncertain setup recovery, downstream review,
  lost-registry claims, integration policy, and worker-commit ancestry.
- Staged-audit fixture introduces an unused staged file and hides it with an
  unstaged import: the staged gate fails, working snapshot passes, and the original
  index/worktree remain unchanged.
- Actual browser smoke in a disposable checkout: home rendered; hydrated MIDI
  settings opened and closed. This is not hardware, authenticated database, or
  timing verification. Use the verification guide for startup/access boundaries.
- An independent agent reviewed the skill and exercised isolated fixtures.
  Its concrete findings about setup recovery, downstream claims, and registry
  restoration were repaired and covered by regression checks. No worker chat was
  launched by this validation.

Local command logs and summaries are in `.issues/evidence/`; they do not travel
with Git. Re-run affected checks when evidence is unavailable or code changes.
The staged hook is installed in this checkout; new checkouts use `npm run hooks:install`.

## Remaining work and next action

The local queue contains bootstrap, recorder isolation, inherited typecheck, and
formatting reports. No worker has been launched.

### Decision iteration 1 — 2026-10-22

The coordinator inspected all four reports and the empty dispatch registry on
bootstrap revision `3843dad`. No active worker needs reconciliation. No issue was
closed, implementation performed, or human verification marked passed.

| Priority | Recommended action                                                  | Policy                                                                        | Why / grouping                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Implement recorder-test isolation (`20261022T163741000-d582`)       | Automatic merge after evidence and an explicit integration trigger            | Selected pilot; one coherent change covers CSV paths, test independence, and cleanup. Its evidence contributes to bootstrap acceptance.                                                                  |
| 2        | Investigate inherited compiler failures (`20261022T163741000-bba3`) | No merge; diagnostic result only                                              | Restore a trustworthy full gate next. Group the shared Prisma-nullability cause within this investigation; assess the two UI typing cases separately. Can run alongside the pilot without changing code. |
| 3        | Repair remaining formatting drift (`20261022T163741000-d1be`)       | Automatic merge after a formatting-only diff and explicit integration trigger | Lower priority than the pilot and compiler blocker. Recheck the actual tracked files and exclude local/generated artifacts appropriately; preserve configuration values and source behavior.             |

The bootstrap report (`20261022T163741000-d76a`) remains open: live multi-chat
dispatch, integration, and resumption evidence are still missing, and its final
human-judgment obligation is pending. Recommend its final verification/review
after the pilot and compiler-gate work rather than offering premature closure.

Do not combine pilot, compiler repair, and formatting into one implementation:
they have different causes and acceptance evidence. Their common contribution to
verification is an effort-level relationship, not a shared code fix. Compiler
failures do not prevent isolated pilot checks, but the aggregate verifier cannot
be reported green until they are repaired.

Read-only recheck of the original formatting list found nine remaining tracked
files; bootstrap already corrected three listed docs, and the original local
queue-file finding is outside tracked source. This is a bounded recheck, not a
claim that repository-wide formatting now passes.

Next action: manually launch the recorder-isolation recommendation. Saved full
action IDs, scope, evidence requirements, and freshness fingerprints live in
`.issues/factory.json`; generate them only after this documentation update is
committed. A fresh coordinator reads this decision and that registry together.
Launching priority 2 separately permits useful parallel investigation. Starting
any action still requires the user's explicit `$factory launch ACTION_ID`.

Real parallel worker chats, live integration, fresh coordinator resumption across
those chats, and final human review are still to be demonstrated through the
manual pilot. Fixtures establish safeguards, not live orchestration success.
The complete factory remains open until those acceptance criteria are exercised.
