# Human input and optional grilling

Status: Q1–Q15 and implementation plan approved, 2026-10-23; implementation unstarted.
Local issue: `20261023T023542625-7fef`. This document changes no workflow code,
launches no workers, and completes no existing human check.

## Outcome

Extend the existing issue listing with a human-input view. A person chooses when
to answer questions, grill an issue, supply manual evidence, judge finished work,
or accept completion. Independent work stays eligible while an input request
waits; only affected steps and dependencies are blocked.

Keep lifecycle position, Matt Pocock classification, human requests, and grilling
history separate. The existing needs-grilling stage can still route clarification;
no additional triage role represents completed grilling. See [ADR 0001](../adr/0001-human-input-separate-from-lifecycle.md)
and the [glossary](../../GLOSSARY.md).

This is one reusable local-issues-skills feature plus a Timey adapter. It remains
separate from the unstarted authentication/persistence migration.

## Agreed user experience

- Open the human-input view on demand. Default to actionable requests; expose
  upcoming and deferred requests separately, with prerequisites and blockers.
  Recommend an order using useful unblocking, issue priority, and age.
- Show each request's issue, expected contribution, blocking effect, and relevant
  decisions/results. Offer Answer/refine, Grill, Defer, and appropriate existing
  verification/review/acceptance actions. Preserve selection as a read-only act.
- Allow several requests per issue. A scope question now, hardware check later,
  and final UX judgment retain independent outcomes and timing.
- Recommend grilling when useful; accept direct answers instead. Record grilling
  unnecessary separately from completed grilling. A person may request optional
  grilling even when the issue is otherwise clear.
- Complete grilling only after material questions are settled, decisions saved,
  and shared understanding confirmed by the person. Preserve past completion
  when material changes require renewed input; reopen only affected questions.
- Defer a selected request without completing or waiving it. Keep the blocker and
  its history, while leaving independent requests/work eligible.
- Offer coherent groups of related requests, explain the grouping, and allow
  narrowing. Persist outcomes per request; membership establishes no blanket
  grilling completion, approval, or acceptance.
- Save responses, validate their effect, and apply only justified readiness and
  lifecycle updates. Default to recording input only. An explicit Answer and
  continue selection may request the separately authorized next action; saving
  input alone starts no worker, implementation, integration, or decision loop.
- Accept direct report edits after revalidation. A timestamp, status change, or
  bare completed flag does not supply an answer or establish human evidence.
- Support explicit delegation of suitable decisions. Record the agent's choice
  and rationale as delegated. It supplies no human-only observation, personal
  judgment, acceptance, or completed grilling.

Final review and acceptance become actionable when the relevant work/evidence is
ready. In Timey, closure-only judgment permits verified progress commits and can
wait until the finished work is runnable. Explicit acceptance remains distinct
from an answer, worker completion, verification, or integration.

## Data and readiness contract

Use additive metadata; preserve existing YAML, comments, prose, original requests,
custom lifecycle definitions, and project policy. The following is the planned
representation, to be validated through fixtures before rollout.

| Source                  | Planned content and authority                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human_input`           | Clarification/grilling requests with stable IDs, prompt/expected contribution, prerequisites, affected operations, status, scope reference, and recorded outcome/provenance         |
| `grilling`              | Current assessment: unassessed, not-needed, recommended, in-progress, completed, or stale; scope reference, reason, decision/evidence link, and human confirmation where applicable |
| Existing `human_checks` | Authoritative evidence/judgment checks and results; project them into the view by source ID rather than copying editable status/results                                             |
| Lifecycle/closure rules | Source for an actionable acceptance request; showing that request never records acceptance                                                                                          |
| Timey factory policy    | Source for candidate-specific human-first integration approval; reference the action and exact candidate revision rather than duplicating approval state                            |

New input-request statuses distinguish pending, in-progress, deferred, and
resolved. A resolved request carries its actual answer/decision and provenance;
request resolution alone does not satisfy other gates. Optional grilling can have
no blocking effect. Missing material decisions block their declared dependent
operations even if a grilling session is skipped.

Keep prior grilling decisions in report history with evidence links. A material
scope/decision change triggers semantic reassessment; bookkeeping changes do not.
Reassess a previous not-needed conclusion when its basis changes. Distinguish
“previously grilled” from “current scope settled.”

Use one read-only normalization/readiness module for request projection,
validation diagnostics, freshness tokens, and operation-specific blockers.
Callers provide project policy and the intended operation. Syntax validation
cannot establish human truth, interpret every prose answer, or reliably detect
semantic scope changes: dispatch still reviews current evidence and requirements.
Malformed new metadata must block affected operations with a useful diagnostic,
not silently become ready or prevent independent issues from proceeding.

Two different freshness checks are required:

- Action freshness: bind project, full issue ID, source/request ID, expected
  lifecycle/request state, and a report-content digest. Re-read immediately before
  writing; reject stale or duplicate actions and preserve intervening edits.
  An unchanged timestamp is insufficient.
- Decision freshness: assess whether the current scope still matches the recorded
  decisions or evidence. A report-content digest changing does not automatically
  invalidate grilling.

Serialize agent mutations, preserve unrelated fields/body, and use a narrow
validated update path. Direct edits require fresh validation before dispatch.
Do not claim optimistic checks make arbitrary concurrent editor writes atomic.

## 1. Implement the shared contract and standalone helpers

Owner: local-issues-skills.

1. Update canonical `references/queue.md` and the issue/issues/fix-issues
   instructions with the agreed input, optional grilling, delegation, deferral,
   completion, and continuation rules. Keep each skill independently usable.
2. Add the reusable normalization/readiness source and a minimal guarded update
   interface. Bundle the necessary helper into standalone skill distributions;
   publish a documented installed interface for consuming projects.
3. Project existing human checks without a second result store. Keep their current
   status meanings; request deferral must not falsely pass/fail a check. Preserve
   project verification/commit/acceptance overrides.
4. Apply blockers to ordinary fix dispatch, Quick fix eligibility and dispatch,
   and relevant lifecycle/batch advances. Reassess old Quick fix metadata after
   input edits; include content freshness rather than trusting only `updated`.
5. Preserve legacy `grill_later` whole-issue deferral. Migrate it to request-level
   deferral only with an explicit justified mapping; neither silently unpark old
   issues nor keep unrelated new requests blocked by an obsolete global flag.

Exit: fixture tests demonstrate independent requests, partial/direct/delegated
answers, deferred blockers, completion criteria, scoped freshness, preserved
unknown fields/prose, and unchanged valid legacy/custom-lifecycle behavior.

## 2. Extend the existing human interaction

Owner: local-issues-skills.

1. Extend `src/list-issues.ts` and `skills/issues/assets/issue-table.html` with the
   human-input view, filters, indicators, source references, grouping explanation,
   and guarded actions. Keep ordinary issue selection and existing batch controls.
2. Define documented text fallbacks, proposed as `issues human`,
   `issues ID answer REQUEST_ID`, `issues ID grill`, and
   `issues ID defer REQUEST_ID`. These are planned commands, not available today.
3. Reuse the existing supported chat callback and interactive-table/rendering
   flow. Buttons send bounded requests; browser code never writes reports.
   Answer/refine and Grill focus the selected issue/request; creating a new chat
   is not implicit. Preserve expected-state and duplicate-submission protections.
4. Validate each grouped outcome separately. Link a shared answer where it really
   applies, skip stale/blocked entries without advancing them, report per-request
   results, and refresh once. Do not reinterpret selection or an ordinary “yes” as
   acceptance of unrelated issues.
5. Use representative disposable fixtures to exercise the view before connecting
   it to live queue mutations. A throwaway prototype is useful if an interaction
   remains unclear; it must not mutate the real queue.

Exit: actual table/chat scenarios cover choosing human work, a partial answer,
optional grilling, grouped/narrowed input, deferral/resume, direct edits, and
explicit continuation. A rendered table or mocked callback alone does not prove
that the agent saved and interpreted the outcome correctly.

## 3. Enforce the same gates in Timey

Owner: Timey.

1. Consume the documented installed helper interface; do not import private
   development sources from a particular checkout of local-issues-skills or copy
   its rules into a competing parser. Missing/incompatible helpers get a clear
   blocker and recovery instruction.
2. Apply current operation-specific blockers during factory evaluation and
   reservation, ordinary/Quick fix paths, before the coordinator's actual merge,
   and before recording verified integration. Re-read current reports: a new
   human request may appear after a worker starts.
3. Preserve the existing distinction between dependent-work and closure-only
   checks. Investigation or other independent work remains eligible when it does
   not rely on the missing answer. Unresolved prose decisions still require
   semantic review; absence of new metadata proves no readiness.
4. Keep launch fingerprints for launch validation. At integration, validate the
   current reports, candidate, and blockers instead of blindly requiring the old
   whole-queue launch fingerprint, since legitimate progress changes the queue.
5. If a blocker is discovered after Git has changed, retain the actual merge
   revision and failure evidence; do not claim the work is unmerged, verified, or
   accepted. Never undo an integration speculatively to repair its ledger.
6. Project human-first approval requests from the factory candidate. Persist the
   actual approval/evidence through the factory-owned helper, bound to the exact
   candidate revision; a changed candidate needs fresh approval. Recording the
   response performs no merge or integration assertion.
7. Update factory tests/SKILL and tracker/operating/verification adapters together.
   Keep `AGENTS.md` short. Preserve coordinator ownership of queue/registry and
   separate manual evaluation, launch, continuation, integration, and acceptance.

Exit: disposable Git/queue tests cover a blocker opened after worker launch,
closure-only versus dependent-work gates, stale direct edits, independent work,
manual boundaries, and truthful integration recording. No test merges into the
real checkout or completes real human checks.

## 4. Adopt existing reports and verify distribution

Adopt reports when selected/reviewed. Reuse actual saved answers and confirmed
interview outcomes where they apply to the current scope. Missing metadata means
unassessed, not never grilled, completed, or automatically blocked. Listing is
read-only; there is no blind bulk backfill or forced re-grilling of every issue.

In local-issues-skills, rebuild the committed standalone helper with `npm run build`,
run typechecking/tests including new source entrypoints, then
`python3 scripts/check.py --sync` and `python3 scripts/check.py`. Follow
`docs/validation.md` in a disposable project and test each skill without siblings.
Keep generated queue references/helper artifacts in sync with canonical sources.

In Timey, run factory checks and relevant application/build/type/format checks,
reporting inherited failures honestly. Before commits or step completion, run
`npx fallow audit --base <recorded-ref>` against the actual candidate in each
changed repository, using snapshot/staged checks where appropriate. Inspect and
address reported findings, rerun, and record blockers instead of weakening gates.

Retain exact revisions, commands, per-request outcomes, and meaningful browser/chat
and dispatch evidence. Packaging success is not observed workflow success. Use a
finished `/tutorial` walkthrough for human judgment and explicit issue acceptance.

## Manual rollout and next action

After plan review, a manual factory evaluation can recommend the bounded shared
contract/view work, Timey integration, and independent verification/review. Group
changes sharing the same contract and serialize dependent integrations; independent
investigation/review can run in parallel only when explicitly launched.

Use separate commits in the two repositories and record their compatible revisions
and installed/bundled interface version. Shared skill implementation/publication,
worker launches, and merges remain separate authorized actions. Test only
specifically selected queues; preserve unrelated work and existing user data.

The user approved this plan and requested a manual factory evaluation. See the
[coordination handoff](human-input-progress.md) for the current recommendation,
cross-repository delivery prerequisites, and inspected worker outcomes. No code
implementation, metadata backfill, worker launch, merge, or publication has begun
for this feature.
