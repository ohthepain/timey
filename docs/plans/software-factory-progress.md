# Software factory progress

Implementation approved on 2026-10-22. This is the bootstrap handoff, not a claim
that the live multi-chat factory or pilot has been proven end to end.
For the current coordinator frontier, read [completed group and integration decisions](#completed-group-and-integration-decisions--2026-10-23).

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

## Completed group and integration decisions — 2026-10-23

The user explicitly launched the preceding three-action group, then invoked one
new manual factory evaluation. All three worker chats are complete and idle.
Recovered their original ready references, retained monitoring cursors, inspected
actual artifacts and recorded outcomes through the factory helper. Full results
are under `.issues/evidence/factory-results-20261023/`; original issue reports
remain unchanged while the report-reconciliation test stays parked.

| Action                                 | Reviewed outcome                                                                                                                                                                                                                                                                                                                   | Remaining step                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `67d25227-cffe-48df-975f-9de2487d872a` | Completed code candidate `670c1183c7f0b3077af88332c9ba489858f59803`; clean worker; only verifier, its tests and verification docs changed. Full six-check verification, 23 factory tests, recorded-base strict audit and staged hook passed. Actual injected interface failure failed aggregate verification; restoring it passed. | Separate manual integration into dev; automatic merge policy after current target checks. Final factory judgment/acceptance stays pending.                                                                                                                                                 |
| `3d04b02e-4dab-4546-a183-ae6829eed33d` | Recorder review reconciled: Standards 0, Spec 0; combined source tree `d20af19c361899a96b74a40810de8b96b2f01d82`; explicit factory 22, app 19, aggregate verify and strict Fallow passed. Independent/repeated/concurrent recorder runs, assertion-failure cleanup and sentinel preservation passed.                               | Separately integrate original action `a509c227-e5de-44b7-b205-285e63b322e0`, candidate `86394522d859f038f4aea5425a2941497cae556d`, under its automatic policy. Preserve current strict verification rules while resolving the documented conflict, then verify the actual combined target. |
| `8e1b2c69-1739-4583-ad7c-afbe63d9e9e9` | Architecture investigation reconciled as proposals. Worker source unchanged; three recommendations retained in [architecture assessment](architecture-assessment.md). HTML structure checked; browser security policy blocked preview, so rendering/CDNs/runtime remain unverified.                                                | Human selection or deferral, then bounded scope decisions before implementation. No recommendation has been adopted or grilled.                                                                                                                                                            |

Checked verifier export tree `6059491d4c99531766d5d32908a4198af3dbe969` against
the exact candidate Git tree and read its raw verification/audit/probe evidence.
Dependencies were copied from an identical-lock checkout; no fresh install was
claimed. Recorder evidence covers full changed files under the strict audit; its
baseline build warnings and abrupt-termination/runtime/device limits remain
explicit. Its aggregate still used the older 18-tooling-check command, so the
separately executed 22-test suite is essential evidence. The verifier candidate
corrects that gap. No detector configuration or evidence gate was weakened.

### Next manual choices

1. **Integrate verifier correction first:** `$factory integrate 67d25227-cffe-48df-975f-9de2487d872a`.
   This improves the gate used by subsequent integrations. Recheck dev drift,
   the exact candidate and current human obligations; merge and verify only on
   that explicit trigger. Completion is recorded, integration is not.
2. **Integrate recorder pilot next:** `$factory integrate a509c227-e5de-44b7-b205-285e63b322e0`.
   Use the reviewed documentation conflict guidance in the retained recorder
   report/patch. The verifier candidate also edits verification documentation;
   preserve both changes and rerun the combined checks rather than replaying an
   old patch as proof of a verified target. Serialize these two merges.
3. **Human input, independently:** `$factory human 20261022T205814928-1fdb`.
   Review transport-state ownership (top recommendation), MIDI subscription
   ownership (smaller alternative), or note attribution/feedback capture (more
   speculative), or defer. Confirm scope and listed behavior decisions before
   implementing; optional grilling can help. Source findings are not runtime
   bug reproductions or approval of a redesign.

No new worker group is recommended while these completed results await their
explicit integration/selection. The Both launch mode therefore has no new group
to dispatch in this iteration. Architecture input can be handled independently
of the technical integration steps. Final factory judgment waits for the runnable
integrated pilot; auth/admin plan review remains separate, ORM still depends on
auth, formatting is lower priority, and the parked reconciliation test stays
parked. This evaluation performs no source implementation, worker launch, merge,
human-check completion, lifecycle advance or issue closure.

## Verifier integration checkpoint — 2026-10-23

The user explicitly selected `$factory integrate 67d25227-cffe-48df-975f-9de2487d872a`.
This checkpoint combines candidate `670c1183c7f0b3077af88332c9ba489858f59803`
with dev starting at `57418da848ad59681cd8a55647fcaeb202d479c1`. The action's
automatic policy permits this integration after evidence review. Its three-file
diff reuses the package factory entry point, tests actual public-path dispatch
and source/index/queue preservation, and updates verification documentation.
Reviewed worker evidence includes strict saved-base/staged audits, full verification,
and an injected interface failure followed by a clean 23-test factory suite.

Combined-source verification, strict checkpoints, the final checked revision,
and the integration result are retained under
`.issues/evidence/verifier-integration-20261023/`, including `integration-evidence.json`.
The dispatch registry records the checked revision only after the combined checks
pass. Matching-lockfile dependencies are reused; no fresh install is asserted.
Fallow architecture boundaries and policy rule packs remain unconfigured and
unmeasured. No check is weakened or exempted.

This trigger selects only the verifier correction. Recorder integration still
requires its separate explicit command; architecture scope selection and final
factory judgment remain pending. The parked report-reconciliation test and
original issue reports remain untouched. No issue acceptance, closure, new
decision iteration, worker dispatch, or push is part of this operation.

## Recorder integration checkpoint — 2026-10-23

The user explicitly selected `$factory integrate a509c227-e5de-44b7-b205-285e63b322e0`.
This checkpoint combines the original recorder candidate
`86394522d859f038f4aea5425a2941497cae556d` with dev starting at
`9f81c91bb985aeb09aa49edd11707f828e2d0fab`, including the integrated verifier
correction. The automatic merge policy applies after evidence review. Standards
and spec review found no issues; the recorder test bytes are the exact candidate.
The documentation conflict keeps all current strict audit and complete factory
suite guidance, updating only the recorder fixture description. No product
exporter or runtime behavior changes.

Combined full verification, strict recorded-start audit, staged commit checkpoint,
fresh disposable isolation probes, root-file preservation, and the exact checked
revision are retained in `.issues/evidence/recorder-integration-20261023/`,
including `integration-evidence.json`. The dispatch registry records integration
only after successful checks. Repeated and independent tests, concurrent processes,
assertion-failure cleanup, and binary root CSV sentinels are checked in disposable
exports. Abrupt process termination is outside the cleanup claim.

This checkpoint does not establish user acceptance or complete the broader
factory. Final factory judgment, runtime/device/database evidence in its original
scope, architecture selection, and the parked report-reconciliation test remain
pending. Original issue reports stay untouched. No new decision iteration,
dispatch, push, issue closure, or human result is authorized by this integration.
