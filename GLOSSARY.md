# Timey

Language used to coordinate work and review changes.

## Language

**Clarify**:
The issue stage that brings human intent and available technical evidence together
to establish enough understanding to begin useful work. Remaining technical
uncertainty can be resolved during implementation.

**Human input**:
A person's contribution to an issue through clarification, grilling, observed
evidence, judgment, or acceptance. Its timing and purpose determine which work
depends on it.
_Avoid_: Triage role

**Human input request**:
A specific contribution requested from a person for an issue, with an expected
outcome and the work that depends on it. One issue can have several independent
requests.
_Avoid_: Issue status

**Grilling**:
A structured interview used to settle an issue’s intent, scope, and design
decisions. Some issues need no grilling.
_Avoid_: Verification, acceptance

**Completed grilling**:
An interview whose material questions are settled, decisions are recorded, and
shared understanding is confirmed by the person.
_Avoid_: Skill invocation, implementation approval

**Implementation-plan approval**:
The user's authorization to implement an agreed outcome within its approved scope.
It leaves room to adapt the technical approach as implementation reveals more.

**Stale grilling**:
Previously completed grilling whose conclusions no longer settle the issue's
current scope. Its earlier decisions remain part of the history.
_Avoid_: Never grilled

**Deferred human input request**:
A request the person has chosen to address later. Deferral leaves the requirement
and its effect on dependent work intact.
_Avoid_: Completed request, waived requirement

**Delegated decision**:
A choice the person explicitly authorizes the agent to make within a defined
scope. It records the agent's judgment, not an observation or acceptance supplied
by the person.
_Avoid_: Human verification, completed grilling

**Human evidence**:
An observation or measurement a person must supply when the agent cannot establish
the required behavior itself.
_Avoid_: Human approval

**Human judgment**:
A person’s assessment of work against expectations, including usability and taste.
_Avoid_: Automated verification

**Acceptance**:
The user’s explicit decision that an issue is complete.
_Avoid_: Worker completion, integration

**Stage outcome**:
A recorded decision that a lifecycle stage completed or was skipped, with its
reason, decision source and evidence. A finished worker is evidence for review, not this decision.

**Planned route**:
The saved expectation of which future issue stages will be taken, skipped or
remain undecided. It can change and does not authorize bypassing required checks.

**Readiness**:
Whether anything currently blocks the next selected action. It must be checked,
can expire, and is distinct from completing the whole stage.

**Issue reconciliation**:
Bringing an issue report up to date with work already completed and checked.
It records evidence-backed stage outcomes without repeating implementation,
integration or human acceptance.

**Implementation checklist**:
Work items from one issue's implementation plan, grouped by its work versions and
checked against explicit acceptance criteria. A passing criterion has supporting
evidence; it does not imply human approval, integration or issue acceptance.
_Avoid_: Lifecycle stage, triage role

**Manual checklist skip**:
The user's explicit decision that an implementation criterion is not required for
this issue at the recorded plan and source revision. It preserves the earlier
result and reason without claiming a pass or accepting the issue.

**Record-only update**:
A coordinator update to one local issue that records corrections already made.
It checks preservation of other records and source, requires no code commit, and
leaves unperformed demonstrations and final acceptance explicit.

## Lifecycle Progress

An explicitly started run that continues one issue through work covered by its
approved implementation plan. It composes individual factory actions, retains
its activity and answers in the issue UI, and pauses for actual human input.
It is separate from a single `/factory` decision iteration and never supplies
human-first integration approval or final acceptance on the user’s behalf.

**Coordinator conversation**:
The shared conversation used to coordinate work across the issue queue. Each
issue retains its own issue conversation; coordination does not transfer an
issue’s execution or approval authority.

**Coordinator working notes**:
Computed findings retained to help the coordinator continue its reasoning. They
are distinct from chat history and the current issue records, and do not grant
execution authority or replace approvals.

**Issue conversation**:
The single continuing conversation that is an issue's home for human messages,
all lifecycle role contributions, questions, decisions, outcomes, and retrospectives.
_Avoid_: Temporary chat, worker chat

**Revision request**:
An explicit request to reconsider an issue's agreed work, retained for review
before continuing under an approved plan. It is separate from a comment or approval.

**Issue priority**:
The relative urgency of an issue, independent of its lifecycle stage. The
project’s ordered Issue Priorities list defines adjacent levels and colors;
issues without a saved value use Major. A priority change does not complete work.

**Issue delivery**:
One issue's contributions retained on a stable branch and published through one
pull request. The default outcome is a draft PR handoff; an explicitly selected
verified-delivery route can continue through checked integration. Both remain
separate from human acceptance.

**Draft PR handoff**:
The end of factory work at draft PR creation, with actual check results, unfinished
work and unverified obligations disclosed for manual repair and merge. It leaves
the issue open and unaccepted and starts no automatic PR maintenance.

**Assembled contribution**:
A worker result with its actual check outcome retained on its issue branch with its
original base, scope, authority and merge policy. Assembly releases its worker
claim; it does not deliver code to the target branch.

**Completion manifest**:
The coordinator's evidence-backed review of every item in the approved issue
plan, the exact aggregate candidate, all contributions and required local checks.
Further issue work or changed evidence invalidates readiness to open the PR.
