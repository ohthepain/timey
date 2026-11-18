# Project home and improvement operations

The user confirmed shared understanding of this design and authorized
implementation on 2026-11-18.

## Confirmed decisions

- Project home is the landing page for the currently selected project. The
  existing issue workspace remains accessible.
- Activity statistics include issues created and closed in the last week.
  Improvement operations are more prominent than statistics.
- Investigations concern a chosen aspect of the codebase or the codebase as a
  whole, including opportunities to improve working processes. Investigation is
  distinct from Retro, which reviews what happened on an issue.
- The investigation operation is available from the project menu and always
  applies to the entire project. There is no folder scope selector. A chosen
  investigation focus or prompt can still direct attention to a particular aspect.
- The user can select a branch. It defaults to the project's default branch as
  specified in project settings, rather than a separate delivery-branch default.
  Before Run, the person can review and edit the final investigation brief.
- Starting an investigation creates an Investigation issue. Its existing flow
  retains goals, conversation, findings, and resulting issues.
- Sending the first investigation message creates its Investigation issue and
  retains the discussion even if Run is never selected. A direct Run also creates
  the issue. Merely opening and dismissing the menu creates nothing.
- A person can choose a focus, add optional instructions to the investigation
  prompt, and run directly.
- The investigation menu offers Whole codebase, Architecture, Code quality, Tests,
  Performance, Working processes, and Custom. Each supplies an editable starting
  prompt; additional user instructions are included in the investigation.
- An optional conversation helps refine the goals through grilling and questions
  about the codebase. The person explicitly chooses when to run the investigation.
- Completed investigations automatically create actionable follow-up issues marked
  **Needs approval**. Approval leaves them idle until explicitly started.
- Each generated follow-up requires a concrete finding, supporting evidence, a
  bounded improvement, and a way to verify it. Generation checks existing issues
  for the same work. An investigation can produce no new issues; uncertain
  findings remain in its report.
- Follow-ups use the project's default issue folder unless the user chooses
  another destination. This controls issue filing, not investigation scope.
- Automatic follow-up creation applies only to investigations started through
  this project operation. Other investigations retain reviewed creation.
  Retries preserve earlier outcomes and do not duplicate created follow-ups.
- Project home also offers a button to run PStack's **automate-me** skill.
  It opens a guided conversation that examines working habits, asks questions,
  and drafts or updates the user's personal `-mode` skill. The person reviews
  changes and explicitly selects Apply.
- Automate me examines only the current project's available conversations. Its
  history duration defaults to four weeks and can be specified by the user before
  running. The interface identifies gaps in the available history.
- Apply defaults to saving a project-local skill, with an option to save a
  personal skill available across projects. The destination is visible before
  Apply. Activation requires an explicit choice.
- Both operations use the project's configured model settings and provide saved
  progress, Stop, and explicit Retry after failure. Returning to the page shows
  the existing run without starting another.
- Last week means the rolling last seven days. Statistics include archived
  issues and count each issue closed during the period once, even if subsequently
  reopened. The interface identifies periods with incomplete closure history.

## Existing foundations

- Project home extends the existing Flow page and sidebar.
- The default Investigation flow is Request → Understand → suggested Close.
  Understand supports a custom prompt and retains read-only investigation results.
- [Investigation follow-ups](investigation-follow-ups.md) currently use reviewed
  creation. Project-home investigations need an explicit automatic-creation
  policy; other investigations retain their current workflow.
- [Issue retros](issue-retros.md) already create follow-ups needing approval.
- Flow offers a timeline and block notes. Classic provides interactive issue
  conversations and grilling. Project-home investigation discussions will belong
  to their Investigation issues from the first message.
- Issue creation and current closure have timestamps. Archived reports need to be
  included in statistics. Reopened reports lose current closure metadata, so
  counting all historical closure events requires additional retained history.
- PStack's installed automate-me skill mines workspace conversation history and
  guides creation or revision of a personal `-mode` skill. Its current instructions
  assume Cursor transcript locations and authoring tools and need a Codex adapter.
- Codex skill discovery and interactive issue conversations already exist.
  Project-linked saved transcripts and known Codex threads provide history inputs;
  a retained project skill session needs its own identity. Temporary discussions
  have no tools or file access and cannot run automate-me unchanged.

## Implementation and verification

Investigation runs remain read-only with respect to project source. Their output
is retained findings and follow-up issues. Automate me reviews skill changes before
Apply; publication is not part of that action.

Project home shares the existing Flow page and sidebar. Project operations are
available from the project menu, including while viewing an issue. Investigation
conversations and runs use actual Understand attempts; explicit Run additionally
creates approval-needed follow-ups through the existing retained-evidence capture
path. Run snapshots the chosen branch and project model settings.

Automate me uses a retained native Codex conversation and the installed PStack
skill with an adapter for its Cursor-specific instructions. The model receives
only gathered project history and cannot apply edits itself. Apply binds the
reviewed content and destination to the existing file contents, checks for stale
changes, and saves the skill. Optional activation changes the project's default
for future work, including when the skill is saved personally.

Closure history is retained in report metadata when closing or reopening, so it
travels with shared and archived reports. The initial seven-day period is marked
incomplete because older reopened reports may lack their past closure timestamps.

Focused checks: `pnpm run test:project-home` and
`pnpm run test:project-home:browser`. The browser fixture exercises the actual UI,
HTTP routes, issue capture, findings, conversations, draft review, and Apply with
injected provider responses and a disposable project. It does not establish live
model behavior or write to the authoritative queue.

Verification on 2026-11-18 passed 31 project-operation checks, 32 workflow checks,
28 server/settings checks, the focused Chrome scenario, and the strict step audit
against starting commit `a30c91365542724cb67f2cdc79381038e9a446f1`. The audit used
the pinned Fallow executable with actual V8 coverage from the disposable backend
and workflow checks, preserving thresholds and warning enforcement.

Both real-provider smoke tests passed with the configured model and effort.
Automate me used synthetic history and returned a structured interview response.
The actual Understand executor read a unique marker from the selected branch's
managed checkout and retained its response without changing the original checkout.

Broader regression checks remain unsuccessful. The legacy UI suite has the same
128 failing test names on the unchanged starting commit. A Flow overnight case
fails and its Stop case stalls on that commit; five further Flow assertions also
fail there. The existing full browser scenario stops on a missing `folder.md`
tree row on both revisions. These results do not establish an aggregate pass.
Retained commands, counts, baseline comparisons, and evidence pointers:
`.issues/evidence/project-home-result/summary.json`.
