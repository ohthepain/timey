# Software factory: discovery brief

Status: discovery complete; implementation approved. This records agreed goals
and operating decisions. See the implementation plan and progress record for
actual completion evidence; manual action boundaries remain in force.

## Stated goals

“Modern” refers to the codebase and its engineering environment. The aim is a
software factory where coordinator agents can drive work forward, adjust plans,
coordinate execution, and improve the process using retrospective evidence,
with less user micromanagement.

- Give agents “hands and eyes”: usable tools to act and inspect outcomes.
- Use verification as the basis for trust.
- Reduce reliance on conversation compaction by preserving meaningful,
  maintainable knowledge in the codebase.
- Keep documentation simple, navigable, and aligned with expectations.
- Reuse existing tools and conventions before building replacements.
- Establish clear standards and routine tool use; the user specifically named
  running Fallow against the diff before finishing a commit. Its exact tool
  interface and the intended gate remain to be established.
- Use tutorials and prototypes to make grilling concrete and improve decisions.
- Enable coordinators to understand the code directly; documentation should
  capture intent and decisions rather than duplicate readily discoverable code.

## Existing decisions

Use the local `.issues/` queue for tracking. The tracker adapter and domain
conventions live in `docs/agents/`. Local lifecycle states and optional Matt
Pocock triage classifications are separate.

## Implementation

Recorder-test isolation is the selected first pilot. The
[implementation plan](software-factory-implementation.md) is approved; follow
[the progress record](software-factory-progress.md) for remaining work.

Reserve the domain glossary for Timey's
domain terms rather than general engineering process vocabulary.

## Agreed direction from the first grilling round

- Prove the operating model on recorder-test isolation, from issue through
  investigation, implementation, verification, and review. A fresh agent must
  be able to resume from repository artifacts before generalizing the factory.
- Within approved scope, coordinators may choose tools, delegate bounded work,
  adjust implementation plans, and repair failed checks. Escalate intended
  behavior changes, material scope changes, unavailable access, and consequential
  actions beyond the authorization. Existing queue commit and closure rules
  remain in force until an explicit change is agreed.
- Human verification has at least two distinct purposes. In the inner loop,
  a human can supply evidence unavailable to the agent, such as real-hardware
  behavior. In the outer loop, a human judges larger changes, including UI
  taste and whether the result is desirable. These purposes may both apply
  to one change. Record individual obligations with their reason, instructions,
  result, and remaining uncertainty, while retaining one lifecycle state.
  Neither obligation implies that a human must implement the change, and
  neither is satisfied by changing a Matt Pocock triage classification.
- Preserve automated evidence and precise human check instructions. Passing
  automated checks does not discharge a required human check.
- Outer-loop human verification happens as late as possible, ideally once
  integrated work is finished and agent-accessible verification is complete.
  Earlier human input is reserved for genuine blocking decisions or checks,
  not routine milestone approval. Continue independent work while a verdict is
  pending; pause work that depends on it. Completed work awaits the human's
  verdict before closure; notification or silence is not acceptance.
- Retrospective process repairs may be larger than small documentation fixes.
  Notify the human of the problem, intended change, and verification plan;
  bounded work can then proceed without waiting for routine approval. Present
  the completed result for outer-loop review. Preserve inspectability and
  reversibility, and stop or redirect on objection. Weakening verification,
  expanding authority, or changing product expectations requires agreement
  first. An irreducible scope decision is still escalated.
- Use prototypes for consequential design questions that resist discussion,
  and tutorials when the user needs to inspect or verify a real workflow.
  Clear routine changes need no mandatory demonstration.
  A prototype does not imply an early approval checkpoint: request human input
  early only when its answer is genuinely necessary to proceed.

## Agreed documentation and handoff rules

- Keep `AGENTS.md` as a router, as short as possible. Linked documents must
  remain simple and useful. Agents update affected documentation as part of
  the code change, including removing stale guidance and repairing pointers.
- Start with a codebase map, a verification guide, and an operating guide,
  alongside the existing tracker conventions. Avoid duplicating facts readily
  discoverable in source or configuration.
- The codebase map connects domain concepts to module responsibilities and
  implementation boundaries. It complements the domain glossary (meaning)
  and ADRs (decision rationale), and supports `/domain-modeling` without putting
  implementation details into `GLOSSARY.md`.
- Substantial efforts have tracked plans carrying scope, decisions, evidence
  pointers, and the next action. The coordinator supplies relevant local issue
  context to workers because `.issues/` is excluded from Git. Keep detailed
  report history in the queue instead of duplicating it throughout the docs.
- Local commits may preserve progress once relevant automated checks pass,
  even while human verification is outstanding. Record that outstanding work
  explicitly; a commit does not assert acceptance. Required human checks still
  gate closure, and an unresolved check blocks any work that depends on it.
  Apply this as an explicit repo adapter when implementing the operating model;
  until then, do not silently infer a changed lifecycle from this discovery brief.

## Agreed coordinator and improvement rules

- Implement and prove the first version in Timey with existing skills/tools;
  extract reusable pieces after the pilot. Repair shared-skill defects at their
  source rather than copying skill forks into the repo.
- Start batches manually. A skill triggers one coordinator iteration that
  examines the queue and available worker outcomes, evaluates grouping, and
  prioritizes actions for the next iteration. Save progress and recommend the
  highest-priority next action instead of automatically continuing the loop.
  The decision invocation does not launch actions. The user separately triggers
  recommended actions, allowing the decision process to be refined before any
  future autonomous loop. Starting an action is not another decision iteration.
  Continuous unattended operation is a later capability, not part of the first
  version.
- Actions should run in separate Codex chats so independent work can progress
  in parallel, matching the intended future coordination model. This is a
  design decision, not a request to launch worker chats during discovery.
- Coding workers use separate Git worktrees. The coordinator owns authoritative
  queue and dispatch mutations; workers return scoped changes and evidence.
  Starting approved actions authorizes creating and following up their worker
  chats within scope. The coordinator skill chooses automatic merge or prior
  human approval based on the work and evidence, and makes that policy explicit.
  Worker completion alone never proves integration, verification, or closure.
- Prefer a recommended next action directly usable from the chat. Native
  follow-up suggestions are available; actual composer prefill/default prompt
  control has not been established and must not be promised.
- Use the accumulated queue to find shared causes and coherent changes before
  implementation and reconsider grouping between completed groups. Grouping is
  an important benefit of queue-based work, not just an incidental optimization.
  Keep each issue's scope, evidence, dependencies, verification obligations, and
  closure separate. A group does not expand authorization or transfer one
  issue's autonomy to another. Honor explicit narrowing or priority instructions.
- Integrate related issues before presenting one outer-loop review package for
  the approved outcome: runnable result, evidence, limitations, and specific human
  checks. Keep per-issue progress visible. A genuine blocking decision or hardware
  check can interrupt dependent work sooner.
- Establish the initial check baseline. Distinguish inherited failures from
  regressions, repair prerequisites needed for the assignment, and capture
  unrelated defects separately. Existing failures never justify ignoring new
  failures or claiming a failed check passed.
- Use `/retro` strategically and frequently when evidence warrants it, such as
  recurring friction, consequential failures, difficult handoffs, or completion
  of a substantial batch. Do not run one mechanically after every issue. Inspect
  existing checks and tooling before proposing replacements. Prefer deterministic
  checks for mechanical errors and concise reviewer guidance for judgment calls.
  Apply repairs under the agreed authority/notification rules, then verify the
  repair addresses the observed failure. A retrospective itself does not prove
  improvement.

## Inspection findings to address during planning

Existing commands provide build, formatting, and Vitest checks. There is no
dedicated Fallow command or detected installation, and mocked MIDI tests do not
establish hardware behavior. Actual check health has not yet been established.
The project's `tutorial` skill directory currently declares `name: proto-tutorial`
in its manifest, so the intended invocation needs reconciliation before relying
on it as a standard tool.
