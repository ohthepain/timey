# Investigation flows and reports

The user confirmed the product decisions below on 2026-11-21 through the
wayfinder discussion. This brief records the agreed scope. The user's subsequent
explicit Start of its implementation issue authorizes work within that scope.
The completed planning decisions are indexed in the
[draft wayfinder map](investigation-reports-wayfinder.md).

## Confirmed product decisions

Investigations use the ordinary flow workspace. Their default route is
Request → Investigate → Create Issues → Generate report.
Both output blocks appear by default. The person can remove either block and
run either independently using the investigation's findings. Create Issues does
not require a generated report, and Generate report does not require issue
creation.

Generate report uses the selectable `generate-report` skill. It produces a
polished report inside Timey with an executive summary, findings, evidence links,
and recommendations. PDF and other exports are deferred.

The default skill now passes all source content through `/bro` for copy and
applies the [editorial HTML design prompt](../../factory/system/skills/generate-report/report-design.md).
It saves a single self-contained HTML document with embedded styles and no
external dependencies or images. This applies only to user-facing reports.
Internal issue records, evidence logs, and machine-readable results retain their
formats. Existing immutable publications remain readable in their saved format;
new deliberate generations use the updated design.

The project workspace gains a Reports tab. Each successful report generation
adds a separate dated report linked to its exact investigation run. Published
reports remain readable after the investigation is archived or rerun. Later
findings produce new reports rather than modifying earlier reports.

Opening a report shows a wide reading view. Discuss opens the investigation's
existing chat below the report, with the selected report as context. Reports
from the same investigation reuse that chat. The person can explicitly ask the
chat to create follow-up issues through existing guarded operations.

Report discussion registers the same skills and tools as the project chat.
It retains the investigation's conversation history and selected-report context.
This requirement was added explicitly by the user on 2026-11-21.

Create Issues uses the selectable `create-issues` skill. Running the block saves
actionable findings as issues in Needs approval after checking existing issues
for the same work. The block does not require a proposal-selection step. Removing
the block prevents that flow step from creating issues. Issue approval and
starting work remain separate operations.

## Existing behavior and changes required

The current investigation page replaces the ordinary graph and Start control
with a dedicated Run investigation interface. Its full run executes Understand
and automatically creates follow-ups. Its results view displays raw output and
retained evidence.

The proposed blocks replace that coupled execution path. The current approved
[project-home design](project-home.md) remains the description of existing
investigation behavior until a new implementation replaces it. In particular,
the proposal changes its automatic follow-up policy into an explicit flow block.
The [existing follow-up design](investigation-follow-ups.md) describes reviewed
creation for other investigation results.

Current investigations retain committed-snapshot execution, run history, reusable
runs, direct archive, and independent follow-up issues. Any required changes to
those behaviors must be called out during implementation planning.

## Design status

The user approved all five planning decisions below. No product questions remain
on this map. The design is ready for a separate implementation effort, with
responsibilities and acceptance scenarios recorded at the end of this brief.
Planning originally ended before implementation authorization. The user has since
explicitly started the implementation issue, authorizing the agreed work and
production skill authoring through its existing workflow. Historical planning
notes do not impose a further permission requirement.

## Implementation issue

[Implement investigation flows and reports](http://127.0.0.1:4317/?issue=20261121T104937769-06e3427f667db7d9)
was created through the existing issue creation form on 2026-11-21 as an idle
Feature in Inbox. It contains the agreed implementation scope, verification
requirements, and references to this brief and the prototype. Capture started
no block and created no implementation worktree.

The initial capture described the planning artifacts as local and uncommitted.
That was historical handoff context, not a permission gate. The user subsequently
started the issue. Its implementation may recover the agreed artifacts from the
supplied destination revision into the saved checkout through normal branch
synchronization, preserving unrelated work. The original capture-only restriction
was corrected after it caused Work to request redundant authorization.

## Reading and discussing a report

The user initially selected layout A on 2026-11-21, then revised the direction
while reviewing the prototype. The current direction is layout C with full-width
discussion below the report. The user then approved the revised prototype and
explicitly moved to Connecting investigation outputs to flow blocks.

The Reports list opens a wide reading view. The report identifies its title,
publication date, source investigation, and exact run. All reports returns to the
list, and Open investigation returns to the source investigation. The run
selector contains only runs from the current investigation, labeled by run and
date. It does not list unrelated reports or their titles.

The first visit opens in reading mode with discussion hidden. Discuss opens the
investigation's existing conversation below the report. The conversation history
and composer each use the full width of the lower section. Recommended prompts
appear as pill buttons. In the revised prototype, a pill fills an editable draft
and leaves sending explicit.

A resizable horizontal divider separates the report and discussion. Dragging it
changes their heights. Its thin line and hover treatment match the sidebar
dividers, with a larger invisible area for dragging. The prototype also supports
keyboard resizing and keeps enough room for the composer controls. Hide discussion returns that space to the
reader. Returning to a report restores the reading position, discussion visibility,
and draft. The prototype retains divider height in memory for each report.

The next chat message uses the selected report as context. Earlier messages keep
the report and run they were sent about. The reader already identifies the
selected report, so the discussion has no duplicate report banner or next-message
status text. It displays actual conversation messages, prompt pills, and the
composer. Sample history is omitted. Reports from the same investigation share
its conversation history. Report discussion uses the same registered skills and
tools as project chat.

### Shared chat UI and behavior

The user confirmed that report discussion uses the same send button and chat
styling as project chat, including user messages aligned on the right. The thin
divider's hover highlight remains part of the selected design.

All chats follow the same spoken send command. A final dictated word "go"
submits the remaining prompt through the normal send action. Remove the command
word before submission. "Go" alone sends nothing, and "go" within the prompt
does not trigger submission. This rule applies to dictation rather than literal
text typed into the composer. See the existing
[project conversation design](project-discuss.md#confirmed-decisions).

The implementation design shares the chat UI and behavior across the app through
a reusable module for the message view and composer. It owns common styling,
send controls, and dictation submission behavior. A CSS class alone would share
appearance while leaving the spoken send behavior duplicated.

Each conversation retains its own history, settings, and ownership. Report
discussion binds to the investigation conversation and supplies the selected
report as context. It registers the same skills and tools as project chat. This
shared UI design does not require a generic conversation journal or alter the
existing separation between project discussion and issue execution.

### Prototype evidence and limits

The throwaway [report-reading prototype](../../scripts/factory-ui/report-reading.prototype.html)
compares A, the focused reader with optional discussion on the right, B, a
persistent report list beside the reader and discussion, and C, discussion below
the report. The current revision develops C according to the user's subsequent
feedback. The earlier confirmed context-switching and return-state behavior still
applies.

Run `python3 -m http.server 4318 --bind 127.0.0.1 --directory scripts/factory-ui`
from the project root and open
`http://127.0.0.1:4318/report-reading.prototype.html?variant=C&report=quality-21&discuss=1`.
The bottom arrows switch layouts. All reports and chat replies are fixtures.

Browser inspection confirmed all three layouts render. A simulated message sent
about Run 2 remained labeled Run 2 after selecting Run 1 in the same investigation
conversation. An earlier revision displayed a composer context label, which the
user subsequently removed as redundant.
The revised C was exercised in the browser for pointer dragging, keyboard
resizing, a minimum split that retains the composer controls, prompt pills that
fill without sending, and return navigation that restores the draft and divider
height. The run selector showed only the current investigation's runs.
After the subsequent simplification, browser inspection confirmed the duplicate
labels and sample history were absent. The thin divider still supported pointer
dragging and keyboard resizing.
The prototype now loads the existing `project-discuss.css` for its send button
and message styling, using the existing send icon and message classes. The
browser preview confirmed a submitted user message aligns on the right, its
simulated reply aligns on the left, and the round send button uses the project
chat's upward arrow icon. The prototype still uses simulated replies.
The shared production module and spoken send behavior remain implementation work.
The prototype does not verify restored reading positions or production chat,
tools, storage, and report publication. Those remain implementation obligations.

## Connecting investigation outputs to flow blocks

The user resolved this planning decision after confirming these behaviors:

- Generate report and Create Issues may investigate newer code as well as use
  the retained investigation findings and evidence. Their inputs identify their
  source investigation run without restricting further inquiry to its revision.
- Create Issues automatically receives additional findings and evidence from
  Generate report when available. It remains runnable from the investigation
  findings if no report was generated.
- Rerunning an output block adds an attempt under its original investigation
  run, with its own timestamp and any newer code revisions it inspected. Only
  Run again starts a new full investigation run.
- For a reusable investigation, Run again starts a fresh investigation on the
  selected branch, then runs the output blocks still included in its flow.
  Earlier runs and outputs remain in history.
- A Generate report failure pauses the route. Create Issues remains manually
  runnable from completed investigation findings, independently of that failure.

The default execution order is Request, Investigate, Create Issues, and
Generate report. Either output block can be removed. Both use the investigation
findings, and Create Issues also receives any additional findings from Generate
report. Supplemental findings retain their originating attempt and inspected
revision so readers can distinguish new observations from the original inquiry.
Earlier findings and published reports remain in history.

Exact findings formats, skill instructions, publication operations, and retry
rules belong to Defining the output skills and their guarded operations. These
choices settle the connection model without approving implementation.

### Existing foundations and implementation requirements

The existing Investigation definition contains Request and Understand.
Understand declares one response file. The proposed findings and evidence output
must support both report generation and issue creation without requiring either
output block's result.

Current flow links combine predecessor relationships, eligible input sources,
and cascading invalidation. A simple four-block chain would make changes to
Generate report invalidate Create Issues. The implementation design must address
that coupling to fulfill independent execution and optional supplemental input.
It must distinguish a report presentation change from a change to findings
actually consumed by Create Issues.
Autoplay already visits incomplete blocks in saved order and pauses on failure.

Input snapshots already retain the producer block and attempt identity.
Investigation history identifies a run by its Understand attempt and retains its
revision, settings, evidence, and resulting issues. Current input resolution uses
the latest current attempt and can expose artifacts from failed or stopped
attempts. A completed-run input therefore needs deliberate selection rules rather
than an assumption that every retained artifact represents a successful inquiry.
The confirmed skill contract permits automatic handoff only from successfully
completed blocks. New code inquiry by an output block must remain
distinguishable from retained evidence for the original revision. Already
published reports retain their agreed immutable history. The retention decision
below defines report publication and history behavior.

Source pointers are `factory/system/flow/definitions/investigation.md`,
`factory/system/flow/blocks/understand.md`,
`scripts/factory-ui/flow-block-data.mjs`,
`scripts/factory-ui/flow-service.mjs`, and
`scripts/factory-ui/investigation-history.mjs`.

## Defining the output skills and their guarded operations

The user resolved this planning decision by confirming these choices:

- Each skill chooses how to save its outputs. The proposed split in which
  skills only choose content and Timey owns all saving was rejected. The
  implementation must support skill-owned save workflows.
- Reports use rich content in a consistent Timey reader. The skill chooses the
  structure and visual emphasis through headings, tables, diagrams, and evidence
  links, rather than defining a separate full-page layout.
- Create Issues links existing issues covering the same work without changing
  them. It creates new issues only for uncovered work.
- Only successfully completed blocks pass additional findings forward
  automatically. Failed or stopped attempts remain inspectable, and saved
  outputs remain retained.
- An explicit Retry after partial issue creation preserves successful creations
  and creates only the remaining work. This applies to replacement skills as
  well as the default skill.
- A replacement output skill must return saved-result references and enough
  source information to attach those results to the investigation run. The
  skill still chooses its saving method.

Skill-owned saving must fulfill the earlier product outcomes: generated reports
appear in Reports, new issues appear in the normal queue as Needs approval, and
results retain their investigation-run relationship. The precise saving method
has not been selected, and this design discussion starts no saving operation.

The earlier decisions already establish `generate-report` and `create-issues`
as selectable defaults, automatic report publication and Needs approval issue
creation when their blocks run, optional removal of either output block, and
the same registered skills and tools in report and project chat. Those choices
are inputs to this decision.

The existing follow-up path accepts completed investigation output and retains
per-issue capture results with stable request identities. An explicit retry skips
saved successes and retries the remainder. These existing foundations can support
the confirmed contract for selectable output skills. Neither new default
skill exists in the inspected Factory, project, or agent skill directories.
The report-retention decision below defines report identity and publication recovery
details. This discussion does not author either production skill or implement
the operations.

## Retaining reports and their discussion context

The user resolved this planning decision. The earlier decisions establish immutable
published reports, separate reports for successful generations, a retained source
run and output attempt, and reuse of the investigation conversation with the
selected report as context. Skills own saving and return references to their
outputs.

The user confirmed these retention and continuation rules:

- After a skill saves a report, Timey retains its own copy of the report content
  and supporting evidence. Published reports remain usable if the skill's
  original files move or disappear. The skill still chooses how to save the
  original.
- Retry recovers the same attempted report publication without creating a
  duplicate. Deliberately running Generate report again creates a new dated
  report, even if its content matches an earlier report.
- Report discussion and explicit requests for follow-up issues remain available
  after the investigation is archived. The investigation remains archived.
  Discussion does not start another investigation run or implicitly restore it.

- Reports remain readable if an evidence item cannot be retained or later
  becomes unavailable. The reader clearly marks affected evidence as unavailable
  or unverified and preserves the report and intact evidence.

Current investigation responses and declared evidence already have retained,
digest-recorded copies outside the disposable source snapshot. Archived
investigations remain readable, but the dedicated discussion form and backend
both reject new discussion while archived; Classic issue chat does not select
archived issues. Continuing report discussion after archival would require
conversation access independent of starting another investigation run.

Existing foundations are in `scripts/factory-ui/flow-executor.mjs`,
`scripts/factory-ui/investigation-history.mjs`,
`scripts/factory-ui/project-investigations.mjs`, and
`scripts/factory-ui/issue-chat.mjs`. These observations are not evidence of a
completed report-retention or archived-report-chat implementation.

## Adopting the flow for existing investigations

The user resolved this planning decision with these adoption rules:

- Existing idle investigations using the standard flow adopt the new block
  layout automatically. Their settings and history remain intact, and adoption
  starts no work.
- Completed inquiries and already-created issues remain recorded as completed.
  Generate report is an explicit new action that does not repeat the inquiry
  or recreate its issues. The completed state is backed by retained outcomes,
  rather than a new attempt that pretends to have run.
- Customized investigation flows retain their layouts until explicitly rebuilt.
- Active investigations finish their current run under its existing
  configuration before adopting the new layout.

Approval requirements remain intact, including Needs approval on an existing
investigation. Failed, stopped, and interrupted attempts keep their history and
explicit Retry or recovery requirements. Loading the app starts no work.

The existing records impose these implementation requirements:

- Investigation classification comes from the saved request or flow type; it
  does not identify Project Home origin through a separate flag.
- Understand attempts and original attempt IDs must remain available when the
  new Investigate block adopts their history. A regular rebuild alone retires
  blocks when their definitions change, and history currently recognizes only
  Understand attempts.
- The linked default definition's name or ID does not prove a saved flow is
  unmodified. Its actual graph, prompts, inputs, and skills can have changed.
- Active, stopping, and uncertain work already has rebuild guards. Adoption
  must preserve original configurations and explicit recovery requirements.
- Existing source-attempt links, saved issue IDs, and partial-creation receipts
  must survive migration. They are evidence of what already happened.
- Existing Retry preserves the original inquiry configuration and source. A
  partial follow-up failure retries remaining issue creation without repeating
  the completed inquiry. Migration must retain that distinction from Run again.

Source pointers are `scripts/factory-ui/investigation-records.mjs`,
`scripts/factory-ui/flow-store.mjs`,
`scripts/factory-ui/investigation-history.mjs`,
`scripts/factory-ui/project-investigations.mjs`, and
`scripts/factory-ui/flow-followups.mjs`. This is source inspection, not a performed
migration.

## Implementation responsibilities

The implementation handoff covers these responsibilities within this repository:

- Flow definitions and execution expose Investigate, Generate report, and
  Create Issues, with independent output execution and optional supplemental
  findings. Historical Understand attempts remain identifiable.
- Default output skills and the existing skill picker support selectable
  alternatives. Skills own saving, return saved-result references, and meet the
  completion and partial-retry contract. Existing issue operations retain
  approval, ownership, and creation safeguards.
- The project report library registers skill-owned results, retains copies and
  source references, distinguishes Retry from new generation, and renders
  unavailable evidence honestly.
- The Reports tab and reader follow the approved C prototype, using shared
  chat UI and behavior throughout the app. Archived-report conversation access
  remains independent of permission to run the archived investigation.
- Adoption preserves settings, approval requirements, historical attempts,
  created-issue references, custom layouts, and active work.

Exact storage paths, schemas, module interfaces, and implementation sequencing
remain engineering choices within these requirements. Queue publication of the
planning map remains a separate handoff because the registered issue tools were
unavailable in this chat. No production source refactor, skill installation,
issue execution, or migration was performed by this planning effort.

## Acceptance scenarios for implementation

These are future checks against the implemented behavior, not passing test results.

| Scenario                                    | Expected behavior                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create an investigation                     | The default flow contains Request, Investigate, Create Issues, and Generate report in that order. Creation and page loading start nothing.                                            |
| Remove either output block                  | The other output remains runnable from investigation findings.                                                                                                                        |
| Investigate newer code from an output       | The attempt retains the original run and records additional inspected revisions and evidence.                                                                                         |
| Pass supplemental findings                  | Create Issues receives available additional findings from successful report generation; failed or stopped attempts remain historical.                                                 |
| Fail report generation                      | The route pauses, and Create Issues remains manually runnable from completed findings.                                                                                                |
| Retry partial issue creation                | Existing successes remain linked, only remaining work is created, and matching existing issues remain unchanged.                                                                      |
| Use a replacement skill                     | The skill chooses how to save and returns references sufficient to associate saved outputs with the run. New issues still need approval.                                              |
| Retry report publication                    | The same report publication is recovered without a duplicate. A deliberate new generation produces a separate dated report, even with identical content.                              |
| Read and discuss a report                   | The first visit opens in reading mode. Discussion opens full-width below, uses the thin highlighted resizer, and shares project-chat styling, controls, registered skills, and tools. |
| Use a recommended prompt                    | A pill fills the editable composer without sending.                                                                                                                                   |
| Use the spoken send command                 | Final dictated "go" submits the remaining nonempty prompt. "Go" alone sends nothing, and an interior "go" does not submit.                                                            |
| Return or switch runs                       | Reading position, discussion visibility, and draft restore. The selector lists only the investigation's runs, and earlier messages retain their source report context.                |
| Move original report files or lose evidence | The retained report remains readable. Missing or unverified evidence is clearly flagged.                                                                                              |
| Archive the source investigation            | Reports and discussion remain available; explicit follow-up requests work without restoring or rerunning the investigation.                                                           |
| Start another full reusable run             | Run again records a new inquiry and configured outputs, preserving prior runs. Output-only reruns stay under their original run.                                                      |
| Adopt an idle standard flow                 | The layout updates without starting work or changing settings, history, or approval requirements.                                                                                     |
| Adopt a completed investigation             | Completed inquiry and issue creation stay completed. Explicit report generation repeats neither.                                                                                      |
| Encounter a custom or active flow           | Custom layouts await explicit rebuild. Active runs keep their original configuration until finished.                                                                                  |
| Encounter failed or uncertain history       | Attempts, saved outcomes, and original Retry or recovery requirements remain intact. Adoption does not restart them.                                                                  |

## Initial investigation-start finding

At the initial inspection, Reconcile blocked-attempt candidate metadata was
awaiting approval. The code-supported path was Approve issue, then Run investigation.
The approval controls are in `scripts/factory-ui/flow-ui.js`; the investigation
Run control is in `scripts/factory-ui/investigation-issue-ui.js`.
This was established from local source and records, without starting the issue
or verifying the rendered interface.
