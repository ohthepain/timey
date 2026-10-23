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

## Non-human-input decision — 2026-10-23

The user approved the new interface and requested progress without a human-input
session. Interface commit `2b68526340ed7fe7605f741953dd52768aa9f07f` is already on
the integration branch, `dev`; a separate merge of that commit is unnecessary.
This is one manual evaluation, not authorization to launch its new recommendations.

Current evidence supersedes the bootstrap/first-iteration status above:

- Compiler repairs and strict Fallow checkpoints are already integrated into dev
  at `38229f14bd5a3243694c8c8108e46d286517c7cf`, following the user's explicit
  approval in the existing preflight chat. Reviewed the tracked adoption report
  and `.issues/evidence/dev-integration-38229f1-20261023/integration-evidence.json`.
  Full target verification passed. Do not launch duplicate compiler/audit work;
  runtime DB/browser/MIDI evidence and acceptance remain separate.
- Recorder candidate `86394522d859f038f4aea5425a2941497cae556d` is completed and
  remains outside dev history. Its retained worker report is useful, but needs
  review against the current strict checks and combined dev revision before a
  separately triggered integration. The old hook-environment problem was fixed
  by the integrated audit work; verify current behavior instead of repeating the
  workaround. Recorder/compiler snapshots are unchanged and idle.
- Original preflight `95cba5a3-dd1a-4e9c-bccc-9d4df3232135` is reconciled as
  non-code planning evidence after recovering its original ready chat reference.
  Contract, assignment, probes and logs are retained under
  `.issues/evidence/factory-nonhuman-2026-10-23/preflight/`. Its offline clean
  install failed; subsequent checks used matching copied dependencies. Contract
  oracle checks were proposed semantics, not production acceptance. Later work
  authorized in the same chat is separate from that investigate/none action.
- The new interface tests are in `npm run test:factory`, but `scripts/verify.mjs`
  still hardcodes only the three older check files. Its successful aggregate run
  therefore covers 18 tooling tests, while the package command includes four
  additional interface checks. Close this observed coverage gap without weakening
  checks or treating the earlier aggregate result as evidence for omitted tests.
- Nine previously identified tracked formatting files still fail the bounded
  Prettier recheck. Keep this separate from semantic fixes and lower priority.
  The auth/admin/ORM plan awaits its own review/selection, and the explicitly
  parked report-reconciliation test remains parked. No report lifecycle or human
  result is changed by this evaluation.

### Recommended independent group

1. **Review and verify the recorder isolation candidate against current dev.**
   Kind: review; merge: none. Issue `20261022T163741000-d582`; dependency is the
   completed original recorder action. Inspect the diff/evidence and exercise the
   combined candidate only in disposable source. Return an integration-readiness
   verdict and any concrete blockers; perform no authoritative merge or closure.
2. **Include factory-interface checks in aggregate verification.**
   Kind: implement; merge: automatic after evidence and a separate integration
   trigger. Issue `20261022T163741000-d76a`. Reuse the complete factory check entry
   point and demonstrate that an interface-check failure fails aggregate verify.
   Final factory judgment remains closure-only and pending.
3. **Assess architecture opportunities without starting implementation.**
   Kind: investigate; merge: none. Issue `20261022T205814928-1fdb`. Use the located
   improve-codebase-architecture skill's assessment/report phases and current
   domain vocabulary. Return evidence-backed recommendations and the report;
   candidate selection/grilling and architectural implementation remain later work.

These actions have different causes and deliverables; run them as independent
worker chats rather than one combined code change. Review can explicitly run the
complete factory test command while the verifier fix is pending, so neither is
a prerequisite for the other. Architecture assessment reads a fixed revision;
recheck affected recommendations before any later implementation.

Next action: offer **Launch recommended group** with the three saved action IDs
from `.issues/factory.json`, generated after this coordination checkpoint is
committed. Allow narrowing to any member. No human answer is required before
these bounded assignments; their outputs may create later decisions. This
iteration creates no worker chats, performs no recommended code work, and merges
or accepts nothing.
