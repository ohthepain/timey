# Issue tracker

Use the project's local `.issues/` queue through `$issue`, `$issues`,
and `$fix-issues`. GitHub Issues is not this project's work tracker.

- Use local workflow roles and saved `state` values from
  `.issues/triage-labels.md` for queue operations.
- When a Matt Pocock skill uses its five canonical triage roles, read
  `docs/agents/triage-labels.md` for the separate optional classification.
- Capture one Markdown report per distinct issue using `$issue`.
- List and select reports with `$issues`.
- Implement and verify reports with `$fix-issues`.
- When another skill says “publish to the issue tracker,” save a
  report through the local queue workflow.
- Resolve tickets by full ID, unique ID prefix, or report path.
- Preserve original reports and append decisions, progress, and evidence.
- Read `.issues/triage-labels.md` for lifecycle states and transitions,
  and `.issues/preferences.json` for the commit policy.
- Follow the invoked local issue skill's queue contract for metadata,
  verification, transitions, and acceptance.

Keep specs and working plans under `docs/plans/`; link them from reports.
Record durable terminology and architecture decisions using
`docs/agents/domain.md`.

The queue remains locally excluded from Git.

## Factory policy overrides

For this repo, [verification](verification.md) defines separate human evidence
and judgment checks; [operating rules](operating.md) define manual evaluation and
launches. These explicit repo rules override the shared queue contract where it
requires all manual verification before every local commit. Passed relevant
automated checks permit local progress commits with human obligations recorded.
Unresolved checks still block affected work or closure. `resolved` means ready
for final human review here, not accepted or closed.

Only the coordinator writes the authoritative queue and dispatch registry.
Workers in isolated worktrees return evidence; they do not initialize another
queue or run a competing fixer. The factory skill never turns a decision
invocation into an action launch. Reuse `$issue`/`$issues`/`$fix-issues` within
these repo policies; manual factory recommendations do not change their meaning.

## Matt Pocock skill adapter

Use these operations when a skill assumes GitHub, `.scratch/`, a `Status:` line,
or automatic commits/closure. This repo's conventions take precedence over those
defaults. Read the installed local issue skill's `references/queue.md` before
creating or mutating reports; use its required YAML and ID format.

- **Publish a spec (`to-spec`):** save the spec under `docs/plans/`, then capture
  a local report linking it. Choose the initial lifecycle state from the queue
  contract's evidence and clarification rules. Publication authorizes no fix.
- **Publish tickets (`to-tickets`):** after approval, capture one local report
  per ticket in dependency order. Use full queue IDs in `## Parent` and
  `## Blocked by` body sections. Preserve acceptance criteria. Use YAML `state`
  from the local lifecycle, with optional `triage_role: ready-for-agent`;
  replace the skill's `.scratch/` path and `Status:` template.
- **Read or comment:** resolve a local ID or report path; append notes and
  evidence to that report. A bare GitHub-style number is not a local ID;
  ask when ambiguous. External issues/PRs require an explicit request.
- **Triage:** store a single category (`bug` or `enhancement`) in optional
  `category` YAML and a single Matt Pocock classification in `triage_role`.
  Append briefs and triage notes to the report. Applying a classification
  leaves `state` unchanged. Follow `triage-labels.md` in this directory.
- **Implement (`implement`, `implement-spec`):** follow local verification,
  commit preferences, and acceptance rules. Resolve an unset commit preference
  before committing; a skill's unconditional commit instruction is not the
  project policy. Verified implementation ends at the mapped `ready-to-close`
  state until user acceptance. No automatic push or publication.
- **Dependencies:** before starting a dependent ticket, read each blocker and
  its recorded outcome. Required implementation must exist and pass relevant
  verification, and required decisions must be settled. `triage_role` alone
  never satisfies a dependency. Record why a blocker is considered complete;
  user acceptance of closure remains separate.

The stock local issues table does not display or enforce custom categories,
triage classifications, dependencies, or claims. Skills must read report bodies
and metadata to enforce these conventions; the table is a lifecycle view.

## Wayfinding operations

- **Map and children:** capture the map and each decision ticket as local
  reports with queue IDs. Store `kind: wayfinder-map` or
  `kind: wayfinder-decision` and `labels: ["wayfinder:<type>"]` in YAML
  (`map`, `research`, `prototype`, `grilling`, or `task` as appropriate).
  Link children from the map and their parent from each child. Wayfinding
  reports use no `triage_role` and are planning work, outside the ordinary
  implementation queue.
- **Lifecycle:** keep unresolved planning reports at the mapped clarification
  state. Record answers under `## Answer`, and explicitly record planning
  resolution as distinct from implemented or verified production code.
  Close only through the local queue's explicit acceptance/closure rules.
- **Blocking and frontier:** use `## Blocked by` with full IDs. A candidate is
  an unanswered decision whose blocking answers have been recorded and whose
  claim is absent. Human-dependent answers require the user's actual input.
  Order eligible candidates by creation time.
- **Claim:** record an optional YAML `claimed_by` with the current chat or
  agent identifier before working. Reread first and preserve another claim;
  local files provide no atomic cross-chat claim guarantee. Serialize queue
  mutations and coordinate parallel work explicitly.
- **Resolve:** record the answer, clear the claim, and add a gist and link to
  the map's Decisions so far. An answer can unblock planning while its report
  awaits closure; report that distinction. Preserve the skill's human input
  requirements and one-decision-per-session limit.
- **Handoff:** implementation tickets created from planning follow the local
  capture and implementation workflow above. Wayfinding itself authorizes no
  production implementation or automatic remote publication.

## Record skipped stages

When capture starts an issue beyond Clarify, record every bypassed stage in
`lifecycle_history` with `outcome: skipped`, its own plain-language `reason`,
`source: { kind: original-report }`, the recording time `at`, and `evidence`
pointing to the original report. This records a routing decision, not completed
clarification or investigation. Explain each stage separately; do not infer old
skip decisions merely because an issue currently has a later state.

Any stage may propose that later optional stages are unnecessary. Save each
stage's reason and decision source before advancing past it. The shared writer
records `source: { kind: stage, state: <deciding-state> }`; explicit user skip
decisions use `source: { kind: user }`. Preserve the source when applying a
previously saved skip. Required exit conditions, technical checks, human checks
and explicit acceptance still apply. Existing completed work is recorded as
completed, not skipped. Unknown historical sources stay unknown.

## Closing without a fix

An explicit user decision may close an issue that has no work currently running
as Won’t Do, Duplicate, Cannot Reproduce, Not Enough Information, or No Longer
Relevant. Record the configured reason and details without passing checks,
completing skipped work, reviewing a finished worker result, or claiming
acceptance. Fixed closure still requires the normal final review, acceptance,
and review of any outstanding worker result.
Project-specific reasons live in the Closed reasons table in
`.issues/triage-labels.md`; `fixed` retains its acceptance meaning.
