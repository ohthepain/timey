# Timey

Language used to coordinate work and review changes.

## Language

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

**Issue conversation**:
The persistent exchange for one issue, including human messages, lifecycle role
contributions, questions, decisions and outcomes.
_Avoid_: Temporary chat, worker chat

**Revision request**:
An explicit request to reconsider an issue's agreed work, retained for review
before continuing under an approved plan. It is separate from a comment or approval.

**Issue priority**:
The relative urgency of an issue, independent of its lifecycle stage. The
project’s ordered Issue Priorities list defines adjacent levels and colors;
issues without a saved value use Major. A priority change does not complete work.
