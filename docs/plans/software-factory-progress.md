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
formatting reports. The registry is initialized with no recommendations or workers.
Its empty state means no factory action has been launched by this implementation.

Next manual entry point: `$factory`. Evaluate the queue, choose prerequisite work
and useful grouping, and save ranked actions. Do not dispatch during evaluation.
The user separately selects `$factory launch ACTION_ID`. The recorder-test
isolation pilot is approved but its worker launch remains manual.

Real parallel worker chats, live integration, fresh coordinator resumption across
those chats, and final human review are still to be demonstrated through the
manual pilot. Fixtures establish safeguards, not live orchestration success.
The complete factory remains open until those acceptance criteria are exercised.
