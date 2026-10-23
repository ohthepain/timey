# Human-input workflow coordination

## Decision iteration — 2026-10-23

The user approved the [implementation plan](human-input-workflow.md) and requested
one factory evaluation, focused on its first action. No worker launch,
implementation, merge, or automatic next iteration is authorized by this decision.

## Queue and existing work

Reviewed all eleven local reports and the existing registry. Human-input issue
`20261023T023542625-7fef` has settled product decisions Q1–Q15 and an approved plan;
no human answer blocks its bounded engineering preflight. Its clarification stage
can advance to the configured ready-for-fix state without starting implementation.

- Recorder action `a509c227-e5de-44b7-b205-285e63b322e0` completed with candidate
  `86394522d859f038f4aea5425a2941497cae556d`. Read its report, result, isolation
  summary, baseline comparison, and Git commit. Worker checks support completion;
  coordinator code review, integration, and human acceptance remain pending.
- Compiler action `b27eea90-2c17-4019-a222-5f7eeab3636e` completed its original
  read-only diagnosis, now reconciled as planning evidence. It identified the
  nullable client seam, response-type erasure, and ignored Transport prop. Its
  initial fresh baseline check had setup limitations. A later explicit user
  follow-up in that chat authorized repairs: they remain uncommitted in that
  worker's checkout and have separate reported green automated evidence. Those
  repairs are not integrated, accepted, or part of the diagnostic merge policy.
- Preserved both original chats; no replacement was launched. Monitoring cursors
  are in the local sidecar. Retained bounded reports/results under
  `.issues/evidence/factory-human-input-2026-10-23/` before worker cleanup.
- Cancelled the unlaunched first-iteration formatting recommendation because its
  saved basis is stale. The formatting issue remains open.
- Bootstrap human judgment still blocks closure only. The deferred report-repair
  test, Fallow enforcement, and architecture assessment remain separate work;
  this evaluation does not execute or close those issues.
- Auth/admin and remaining ORM plans are separate from this selected effort;
  the ORM replacement still depends on the verified auth-first phase. Preserve
  compiler work already produced instead of starting a competing repair.

## Why a preflight is first

The shared implementation belongs in local-issues-skills. Its observed HEAD is
`fc76de842cf13bc3fef5cd5f493679501f9f9c09`; unrelated changes exist in README,
validation documentation, tutorial metadata, and new consistently/handoff skills.
Preserve them. Do not assume those uncommitted sources travel with a worker's
starting revision.

Timey's current factory launch/integration procedure assumes a Timey worktree and
checks a worker commit against Timey's Git history. It has no declared shared-repo
target contract. A shared-source code action must not be advertised as safely
integrable through that path until its target, starting revision, isolated
checkout, evidence, and integration recording are specified and supported.

The first action will freeze the exact shared schema/helper interface and provide
the smallest safe cross-repository implementation handoff, supported by disposable
fixture/packaging probes. It changes no tracked production source in either repo.
This is an engineering prerequisite, not another product-grilling round or a
general factory redesign.

## Ranked recommendation

1. **Validate the human-input contract and cross-repository delivery handoff.**
   Kind: investigate. Merge: none. Issue: `20261023T023542625-7fef`.
   Cover canonical request/grilling fields, authoritative check projections,
   operation-specific blockers, installed standalone helper interface, freshness,
   legacy deferral, packaging, and supported target/integration handling together.
   Return exact fixtures/results and a bounded implementation assignment with
   source revisions, files, verification, and any minimal prerequisite change.

Keep shared contract/helper work cohesive because all consumers depend on its
semantics. The later table/view and Timey enforcement work depend on that contract;
only independent verification/review should parallelize before it is stable.
Recorder integration, compiler repair adoption, and unrelated formatting do not
share this implementation cause and are not grouped into it.

## Handoff and next action

Next action: manually launch **Validate the human-input contract and
cross-repository delivery handoff**. The saved full action ID and exact Timey
starting revision are in `.issues/factory.json`; generate the recommendation only
after committing this coordinator-owned documentation. Its launch must revalidate
the shared source revision too. Expected worker output is a reviewable temporary
artifact and final response, not code commits or edits to either authoritative
queue.

After reviewing that result, manually evaluate again to select the first shared
implementation action through a supported target path. No next action launches
automatically. Worker completion is not implementation acceptance or closure.

The installed commit hook has a worker-reported inherited Git-index environment
problem. For this documentation checkpoint, run the unchanged audit hook through
a one-command environment-clearing wrapper, retain its audit output, and inspect
the committed file list. This is a local commit workaround, not a hook repair or
completion of the separate Fallow issue.
