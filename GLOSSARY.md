# Timey

Language used to coordinate work and review changes.

## Language

**Spoken send command**:
The person's explicit choice to send a dictated prompt by saying “go” as its
final word. The command word is excluded from the submitted prompt.

**Local note**:
A quick project-owned thought or todo saved outside version control. It can be
discussed in the project conversation or used to prefill an issue. Capture starts
no work, and issue creation retains the note until the person deletes it.

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

**Needs your input**:
An issue has a specific outstanding human input request that prevents dependent
work from continuing. The person handles the request and explicitly continues
the affected block.
_Avoid_: Failed, needs retry

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

**Progress view**:
An explanation of an issue's current work, confirmed milestones, outstanding input
and next action. An operation's completion names its finish line and remains
separate from issue acceptance.
_Avoid_: Lifecycle stage, issue acceptance

## Lifecycle Progress

An explicitly started run that continues one issue through work covered by its
approved implementation plan. It composes individual factory actions, retains
its activity and answers in the issue UI, and pauses for actual human input.
It is separate from a single `/factory` decision iteration and never supplies
human-first integration approval or final acceptance on the user’s behalf.

**Coordinator conversation**:
The shared conversation that selects which eligible issue advances next from a
compact queue summary. Planning, implementation, recovery and verification belong
to the issue conversation. Each
issue retains its own issue conversation; coordination does not transfer an
issue’s execution or approval authority.

**Coordinator working notes**:
Computed findings retained to help the coordinator continue its reasoning. They
are distinct from chat history and the current issue records, and do not grant
execution authority or replace approvals.

**Issue conversation**:
The single continuing conversation that holds the issue's history from creation
through closure, including human messages, lifecycle contributions, decisions,
outcomes, and retrospectives.
_Avoid_: Temporary chat, worker chat

**Revision request**:
An explicit request to reconsider an issue's agreed work, retained for review
before continuing under an approved plan. It is separate from a comment or approval.

**Issue priority**:
The relative urgency of an issue, independent of its lifecycle stage. The
project’s ordered Issue Priorities list defines adjacent levels and colors;
issues without a saved value use Major. A priority change does not complete work.

**Issue number**:
A stable sequential local label for a queue issue. It is stored separately from
the report ID, never reused after deletion, and distinct from a GitHub pull request
number.

**Issue folder**:
A project folder configured to show assigned issues and issue actions alongside
its files. Every issue belongs to a folder, and its report lives in the queue.
_Avoid_: Issue group

**Project Issues view**:
A project-level view of issues across issue folders, with filtering and bulk
selection. Folder views use the same issue workspace scoped to one folder.
_Avoid_: Virtual folder

**System folder**:
A browsable folder without issue settings. The term describes its issue behavior,
while installed content describes who owns its files.

**Default issue folder**:
The single issue folder used for a new issue when the person has not chosen a
folder. Each project has its own default issue folder.

**Inherited setting**:
A setting whose value comes from a parent folder, or from the project when no
parent folder supplies a value.

**Selection strategy**:
A rule for recommending which issues to select and explaining why they fit
together.

**Master issue**:
An issue that combines requests from selected issues and owns the work needed to
fulfill them.

**Sub-issue**:
An original issue whose work belongs to a master issue. It keeps its own identity
and report and cannot start work independently while attached.

**Issue claim**:
Exclusive permission for one factory run to start or continue work on an issue.
A claim can remain held while the run's outcome is being published. Shared
claims are records on the dedicated issue queue branch, separate from source revisions.

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

**Issue strategy**:
An explicitly chosen delivery finish line for one issue. Full Stop produces a
merge-ready PR and leaves it unmerged. Full Send additionally merges through
provider-enforced protection. Neither implies deployment or human acceptance.
Lifecycle roles are historical context rather than execution requirements.

**Blocker repair**:
A necessary technical correction within an explicitly active issue strategy,
including inherited test/format failures, target-branch conflicts and new audit
findings. It retains the original issue scope and base, separate repair commits
and bounded attempts. It does not authorize unrelated product changes or weaken
verification, merge protection or acceptance.

**Sol Loop**:
An optional bounded review of an issue's current candidate by one Sol reviewer.
It may be selected with either strategy or requested afterward on retained work.

**Issue acceptance**:
The person's explicit judgment that an issue's recorded result satisfies their
intent. Publication, merge, successful checks and strategy completion do not imply acceptance.

**Issue closure**:
The recorded decision to end work on an issue, either with an accepted fix or a
stated reason for closing without a fix. It is independent of historical lifecycle stages.

**Fixed by**:
The closure reason for a sub-issue whose fix the user accepted by closing its
master issue as Fixed.

**Issue cleanup**:
Removal of a closed issue's worktree and any selected local or remote issue
branches. Incomplete cleanup can be retried while the issue stays closed.

**Worktree deletion**:
Removal of an issue's local checkout, independent of its status or closure sequence.
It discards uncommitted files and preserves the issue, branches, conversations, and retained evidence.

**Issue archive**:
A retained collection of issues outside the active views. Archiving preserves
identity and history. Investigations can be archived without being closed.

**Retro**:
A review of what happened on an issue and what could improve future work.

**Project home**:
The project's landing page for activity summaries and operations that improve its
codebase and working processes.

**Project conversation**:
A retained conversation about the project as a whole, available through Discuss.
Its scope can span the project's code, issue controls, and working processes.
Issue handling remains independent of the project conversation.
_Avoid_: Coordinator conversation, issue conversation

**Clarification skill**:
The person's selected grilling skill for resolving ambiguity in a project
conversation.
_Avoid_: Looping skill

**Investigation**:
A bounded inquiry into a project's codebase or working processes, recorded as an
issue with its goals, conversation, findings, and resulting follow-up issues.

**Reusable investigation**:
An investigation that remains available for additional runs after a completed
inquiry, with each run retaining its own findings and resulting issues.

**Investigation run**:
One execution of an investigation against a chosen revision, retaining the
instructions, settings, findings, evidence, and related issues for that execution.

**Retro item**:
A follow-up issue proposed by a retro that retains its originating issue for
evidence and context.

**Investigation follow-up**:
An issue that turns a finding from a completed investigation into a concrete next
action. It retains the source finding and evidence, independently of a retro or
acceptance of the investigation.

**Needs approval**:
The state of an issue that awaits an explicit decision before work can start.

**Flow definition**:
A reusable description of how to build an issue flow and which issue types
can use it.

**Issue flow**:
An explicitly controlled graph of blocks for one issue. The graph records the
planned route. Run starts the selected block. Start or Resume runs the route
and waits for any confirmations along the way.

**Flow block**:
One visible request, advisory, work, verification, delivery, or cleanup operation.
Its Markdown declares its system prompt, Details and Artifacts. Its intent, skill,
comments, attempts and evidence are inspectable. A block reads declared inputs
from its own Details, the issue and upstream blocks. An edit invalidates the
edited block and its connected successors. Details types each input and Artifacts
types each output. An input uses either a manual value or a linked upstream
output; the inspector shows inputs before read-only latest outputs.

**Merged issue**:
An issue whose PR has a successful Merge receipt or a retained GitHub merge
observation. Its issue settings and work flow are read-only, including historical
attempts and block definitions. Close and its Retro/Cleanup sequence remain
available. Restarting work requires a future reopen operation; merged-issue
reopening is deferred. See [ADR 0020](docs/adr/0020-freeze-merged-issues.md).

**Request block**:
The required first block and owner of Your words and the derived request fields. Saving the wording
or refreshing Request reruns clarification. A change of issue type applies that
type's default flow.

**Block attempt**:
One execution of a block. Retry appends an attempt and preserves earlier results.
An uncertain attempt requires reconciliation of its original execution.

**Suggested block**:
A dotted future operation that has not started. A target-change suggestion is a
code-generated observation and grants no execution authority.

**Flow lane**:
A displayed branch of the issue graph. The issue keeps one owning conversation;
parallel workers belong to the explicitly selected Arena or Swarm block.

**Flow starting point**:
The chosen Git branch ref and exact commit used to create an issue's checkout.
It defaults to the delivery target branch. An idle, unpublished issue can change
its starting point by moving its saved work onto the new base.

**Flow candidate identity**:
The base commit, source tree, current commit and uncommitted state captured for a
flow result. Publication requires a clean committed candidate. Verification of an
uncommitted tree remains valid after that exact tree is committed, and expires when
its content changes.

**Flow destination**:
The GitHub branch used as the PR base and by Merge. It follows the
starting branch until the operator pins a branch or the issue gets a PR.

**Merge verification scope**:
The set of local checks required for a Merge attempt. The full regression suite
is an opt-in scope that adds broader regression checks to the default scope.

**Update Branch**:
The Flow block that fetches the branch recorded in Starting point and brings
its latest commits into the issue branch.
