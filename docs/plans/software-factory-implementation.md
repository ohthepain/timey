# Software factory implementation plan

Status: approved; bootstrap, verifier correction and recorder pilot are integrated.
Remaining factory validation and explicit human judgment/acceptance are pending.
Current results and remaining work are in [the progress record](software-factory-progress.md).
Agreed goals and boundaries are in
[the discovery brief](software-factory.md).

## First version

A manually invoked coordinator evaluates the local issue queue and recommends
ranked actions. The user separately triggers chosen actions, which run in Codex
chats; coding workers use isolated worktrees. The coordinator records dispatches,
reconciles outcomes, and owns integration and the authoritative queue.

Keep evaluation and action execution distinct. Evaluation may reconcile observed
results and save recommendations, but launches no workers, merges no code, and
does not start the next iteration. Action triggers validate the selected saved
recommendation and its scope; they are not another evaluation invocation.
Finalizing a completed worker's code uses a separate manual coordinator trigger,
`$factory integrate ACTION_ID`, which serializes the authoritative target merge.

Workers can run concurrently. Decision iterations remain manual even while
workers are active. At the end of evaluation, expose the highest-priority next
action as a native follow-up suggestion, with a copyable prompt fallback.
Do not claim that suggestions prefill the composer.

## Implementation slices

### 1. Establish evidence and navigation

- Run existing checks and record their actual baseline. Inspect test side effects
  and use a disposable checkout where necessary before treating tests as safe
  repeatable gates; preserve unrelated user changes.
- Add `docs/agents/codebase.md`, `verification.md`, and `operating.md`. Link through
  existing routing docs, keeping `AGENTS.md` short. Map domain concepts to module
  responsibilities; create glossary entries only for resolved domain terms.
- Document safe startup, browser readiness, useful logs, fixture/data boundaries,
  and recovery. Exercise the actual app; report unavailable dependencies honestly.
- Reconcile the tutorial skill manifest/invocation mismatch at its shared source
  as a separately scoped change. Reuse prototype, tutorial, review, and retro skills.

Acceptance: a fresh agent can locate the relevant code, start or diagnose the
environment, and distinguish automated, simulated, browser, and hardware evidence
without reading this chat. Missing access remains an explicit blocker.

### 2. Make verification repeatable

Depends on slice 1's baseline; may proceed alongside slice 3 once scope is clear.

- Reconcile the package manager and runtime with actual project requirements and
  CI. Establish named, reproducible formatting, typechecking, test, build, and diff
  audit commands; reuse existing tooling before introducing new dependencies.
- Install a pinned Fallow version. Confirm TanStack entry detection and validate
  new-finding gates against the intended comparison base. Verify staged-snapshot
  behavior with unstaged edits before declaring a pre-commit command authoritative.
- Wire appropriate checks into CI and the local commit workflow. Preserve full
  reports for context; distinguish inherited findings from introduced failures.
  A missing or failed required check never silently becomes a pass.
- Keep the recorder-test isolation change for the pilot in slice 6; run the
  current tests safely in the meantime. Establish a real-browser smoke check for
  environment readiness without inventing browser coverage for a backend-only
  pilot. Mechanical standards belong in checks; genuine judgment standards belong
  in concise reviewer guidance.

Acceptance: deliberate introduced failures in disposable fixtures are caught by
the relevant gates; verification preserves the user's workspace and states what
was actually exercised. Integration uses the same relevant gates. Recorder test
output isolation itself remains the pilot's deliverable.

### 3. Adapt the queue for human verification and coordination

Depends on slice 1's conventions.

- Keep local lifecycle `state`, optional Matt Pocock `triage_role`, and human
  verification obligations distinct. Each obligation records a stable identity,
  evidence/judgment purpose, instructions, result, relevant revision, and which
  work or closure it blocks. One report may have several obligations.
- Update repo lifecycle exit conditions explicitly to allow local commits after
  relevant automated checks pass while human checks remain outstanding. Pending
  checks remain visible and block dependent work or closure as appropriate.
  Preserve existing state strings and reports; do not mutate shared skill rules
  merely to implement this repo's policy.
- Set the agreed local commit preference explicitly. Preserve per-issue evidence
  and acceptance even when work is grouped. Human closure remains explicit.
- Keep the coordinator as sole queue/dispatch writer. Workers receive bounded
  issue snapshots and artifact pointers; they do not mutate the source queue.
- Use tracked effort plans for scope, decisions, evidence pointers, and next
  action. Keep volatile action/thread records with the local queue. On a fresh
  checkout, recover active work from known artifacts and chat tools before
  proposing another dispatch; missing registry data is not proof work is absent.

Acceptance: a report can simultaneously await hardware evidence and human taste
review without either becoming a triage role or being satisfied by a commit.
Worker results cannot accidentally close issues or overwrite queue updates.

### 4. Implement one coordinator skill with explicit action triggers

Depends on slices 1 and 3; coding actions require slice 2's relevant gates.

- Put a repo-scoped skill in `.agents/skills/`, using the skill-creator workflow.
  Make invocation explicitly manual. Keep substantive operating rules in the
  operating guide and avoid copying them into every worker prompt.
- Evaluation reads the queue, effort plan, and compact worker snapshots. It
  reconciles evidence, evaluates shared causes/grouping, dependencies and active
  claims, then saves prioritized recommendations with reasons.
- Candidate actions include investigation, clarification, prototyping, scoped
  implementation, verification, integration, human review, and retrospective.
  Prioritize urgent impact, prerequisites, and coherent shared fixes. Do not
  introduce waiting periods or timers to accumulate issues.
- Each recommendation has an identity, scope and issue IDs, expected current
  revisions/states, dependencies, evidence requirements, and execution/merge
  policy. Return one prominently recommended next action and useful alternatives.
- A separately triggered action validates those preconditions, reserves a
  dispatch record, and creates the worker chat. Record ready thread IDs/hosts or
  pending setup IDs accurately. Duplicate or stale triggers must not dispatch
  duplicate work. Reconcile an uncertain launch before retrying.
- Give coding workers an explicit starting revision and isolated worktree.
  Supply boundaries, acceptance criteria, check requirements, and result location.
  Collect outcomes through supported chat snapshots. Follow-ups stay within the
  human-authorized assignment; a worker message never expands authority.

Acceptance: evaluation creates no chats. Triggering two independent approved
actions starts two isolated workers, while triggering one action twice starts
only one. Completed, failed, pending-setup, and blocked workers remain distinct.

### 5. Integrate, review, and improve

Depends on slices 2–4.

- Serialize integration through the coordinator. Make merge policy visible in
  the recommendation. Automatic integration is available for approved scoped
  work with sufficient evidence; require prior human approval when unresolved
  behavior, consequential scope, or correctness uncertainty requires judgment.
- Revalidate the current target revision and run relevant checks on the combined
  result. Clean merge mechanics and a worker's success report are insufficient.
  Pending outer-loop taste review alone need not prevent local integration;
  unresolved evidence that correctness depends on must block affected progress.
- Keep integration as a separately triggerable action when outside the selected
  worker action's authorized scope. Group only coherent changes and preserve
  per-issue results and the user's ability to narrow scope.
- Present outer-loop review as late as possible: runnable integrated result,
  issue outcomes, automated evidence, remaining human checks, and limitations.
  Use tutorials where they improve judgment; human verdicts remain distinct
  from merely visiting tutorial steps.
- Recommend `/retro` strategically after meaningful failures, recurring friction,
  difficult handoffs, or substantial batches. Process repairs follow the agreed
  notification and authority boundaries and must demonstrate the improvement.

Acceptance: a safe fixture demonstrates integration catching an interaction
failure missed by isolated worker checks. Neither automatic merge, tutorial
completion, nor notification closes
an issue or claims a pending human check passed.

### 6. Prove the factory on a bounded real task

Depends on slices 1–5. Selected pilot: recorder-test isolation.

- Capture the approved outcome as a local issue: investigate and isolate
  recorder-test CSV outputs, preserving the recorder assertions and verifying
  workspace cleanliness. Reproduction and actual check results are still to be
  established; selecting the pilot does not establish a verified failure.
- Run recorder tests repeatedly and with concurrent independent invocations in
  disposable fixtures. Verify isolated outputs, cleanup on success and failure,
  preserved behavioral assertions, and no change to tracked workspace files.
- Also exercise grouping with related reports and parallel dispatch with an
  independent bounded action. Do not invent product changes just for a demo.
- Resume coordination in a fresh chat using the repo and saved artifacts.
- Test stale recommendations, duplicate triggers, blocked workers, missing
  registry data, and simultaneous human evidence/judgment obligations in safe
  fixtures. Use an independent forward-test of the coordinator skill.
- Finish with one integrated review package and a targeted retro. Record gaps
  as local issues rather than claiming the factory is reliable from docs alone.

Acceptance: agreed work can be inspected, delegated, resumed, integrated, and
verified without repeating the original chat or routine user micromanagement.
Unattended looping and extracting a reusable factory remain later work.
