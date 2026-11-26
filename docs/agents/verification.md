# Verification

`node --test --test-name-pattern='late provider output' scripts/flow-executor.check.mjs`
delivers response fragments during connection shutdown and after completion.
The completed investigation response must keep its original bytes and checksum,
so Generate report can verify and reuse its findings.

`node scripts/flow-browser.mjs --investigation-reports` checks retained Markdown
and HTML reports in the actual reader. The editorial HTML fixture checks embedded
styles, mobile width, hidden mobile navigation, scroll restoration, retained and
missing evidence links, blocked scripts, and blocked external resources. It uses
saved fixture content, not live model generation, so it does not establish that a
model follows the report design prompt.

`node scripts/flow-browser.mjs --investigation-flows` runs the inquiry and output
blocks with a fixture provider. It creates two approval-needed issue records and
checks the links in the published report. The next run links to matching work,
so its own report has no created issues.

`node --test scripts/discussion-evidence.check.mjs` checks temporary discussion
protocol configuration, complete context/input references above the provider
limit, small follow-up messages, and cleanup that preserves the project. It uses
a disposable provider process; it establishes read-only/never-approve settings,
not actual OS sandbox enforcement or live model availability. The same suite
checks that Request clarification disables shell tools, starts outside the
project, and retains complete wording above 16,000 characters inline. It checks
oversized-input rejection before dispatch and bounded failure diagnostics for
provider startup and generation timeouts, without retaining prompt or provider
text. The timeout fixture advances a mock clock; it measures no live latency.
`node --test --test-name-pattern="Retro reads|Retro links" scripts/flow.check.mjs`
checks linked-thread ordering, unavailable history and complete oversized retro
evidence. The initial message stays below 16,000 characters; the referenced files
retain beginning, middle and end, matching digests and survive session closure.
These fixtures start no live model or production retro.
`node scripts/discussion-evidence-provider.mjs` separately checks the configured
live provider against a disposable Git repository and a linked input above the
provider text limit. It verifies actual native file/history reads and retrieval
of a middle marker, retaining command observations under its printed temporary
path. It does not test OS write denial or run a production retro.

`node --test --test-name-pattern='manual branch update|oversized input' scripts/flow.check.mjs scripts/flow-executor.check.mjs`
reproduces Update Branch being blocked by an uncertain Work attempt. It checks
that an active provider blocks the update and a confirmed idle provider permits
it while retaining the failed attempt and recording reconciliation. It also
checks recovery of retained oversized rejections, refusal when a receipt exists
or the request cannot be confirmed, and rejection of new oversized input before
provider dispatch.

`node --test --test-name-pattern='large source issue history|retained source publication|Retry replaces' scripts/flow-executor.check.mjs`
checks small inline source context and large source history supplied by file
reference. The large-history fixture exceeds the provider limit before the fix;
the bounded request retains the full report in a file with a matching digest.
The Retry scenario verifies a new conversation is created for a confirmed
rejected first input instead of resuming a thread with no persisted history.

`node --test scripts/github-call-history.check.mjs` checks individual GitHub
CLI request traces, including pagination, failed status, pending state, and
credential exclusion. It checks the 30-entry limit, durable totals across
processes, and a reset while a call is running, using disposable state.

`node --test scripts/diagnostic-activity.check.mjs` checks attribution across a
resumed Codex conversation, repeated inputs, failure and store timings, durable
counts beyond retention, reset with a turn in flight, and quota
windows for ChatGPT versus API key sessions. It starts no model turn.

## Commands and evidence

The Verify workflow splits its first Flow browser part into `--ci-part=1a`
and `--ci-part=1b`. `--ci-part=1` still selects both for local use. The former
second non-browser job runs its Factory shard and the app tests and build
in separate jobs. The aggregate `test` check requires all jobs and combines
evidence for the same candidate.

`node scripts/flow-browser.mjs --inbox-details --manual-close --local-notes`
uses a disposable project to exercise playback, block Details, the Close menu,
and contextual note recommendations.

`node scripts/flow-browser.mjs --request-save` holds Request clarification after
saving Your words on an existing issue. Rename, Close, Stop, and the editor remain
usable while clarification runs, and the wording survives completion and reload.
A rejected save retains the editable draft. The focused `flow.check.mjs` tests
check acknowledgement after admission, synchronous input validation, retained
background failure, and the existing awaited Request result.
The focused shared-store check in `project-stores-flow.check.mjs` verifies that
the same save persists the wording and admits clarification when the Request
definition has changed.

`node --test --test-name-pattern='confirmed coordination writes' scripts/project-stores.check.mjs`
uses the real record provider and makes subsequent reads of each written operation
unavailable. Opening, updating, and confirming must still return the committed
records, and confirmation must release its claim. This checks unnecessary remote
read dependencies, not live Git latency.

`node --test scripts/artifact-working-set.check.mjs scripts/folder-view-snapshot.check.mjs`
checks an artifact working set above the former entry limit and shared folder
discovery within one view, with fresh discovery on the following view.

`node --test scripts/idle-view-work.check.mjs scripts/clean-environment.check.mjs`
checks unchanged display reads, changed file generations, staged flow priority,
caller isolation, evidence resolver changes, and fresh evidence actions. Environment
checks retain per-command filtering while avoiding repeated Git-name discovery.

`node --test scripts/store-snapshot-scope.check.mjs` checks overflow decoding
through pinned Coordination and Issue readers, artifact relocation identity,
concurrent scope isolation, scope completion, and fresh mutation authority. Its
disposable Git fixture counts remote lookups while decoding several overflow
records. It makes no production requests.

`node --test scripts/store-atomic-publication.check.mjs` checks the single-store
report transaction, retained history and confirmation, replay, ownership, migration,
concurrent revisions, and uncertain replies with disposable stores.
`node --test scripts/approval-refresh.check.mjs` checks selected approval admission,
full and selected refresh overlap, cold initialization, and direct controller
freshness. Its HTTP fixture checks a peer update without reading unrelated reports.

`node --test scripts/store-atomic-flow.check.mjs scripts/flow-save-git.check.mjs`
checks idle flow saves against claims, migration seals, changed revisions,
concurrent saves, and uncertain replies. The real Git fixture reorders
investigation outputs while retaining attempt bytes. It counts remote-head
checks and pushes for small flows and flows with overflowing history, verifies
the saved results, and checks fresh peer reads and idempotent retries. All Git
remotes and artifacts are disposable. These counts measure store operations,
not live GitHub response times.

`node --test scripts/closure-menu.check.mjs` holds a shared-store refresh while
opening the Close menu through the real HTTP route. The menu must return saved
issue context without waiting for that refresh. Confirming closure still waits
for fresh authoritative state. Confirmed report writes and recovered publications
refresh only the selected issue, without rereading unrelated histories or dropping
other saved issues. The dialog shows loading feedback when context
is pending and keeps confirmation disabled if loading fails. These checks never
close a live issue or launch work.
The HTTP action regression also requires exactly one shared refresh before
dispatch and verifies that direct controller calls retain their own fresh read.
Close and Reopen each publish one authoritative report with its destination,
retain decision history, and preserve the prior report when publication fails.

`node --test scripts/flow-delivery.check.mjs` checks publication against a
GitHub-observed destination commit absent locally. A disposable SSH transport
serves a local Git repository. Publish fetches the missing commit without changing
the issue commit or files, pushing, or creating a PR. The fixture uses no live
GitHub credentials or network requests.

`pnpm run test:stores` includes the `storage-profiles-*.check.mjs` fixtures. They
check metadata-only registry activation, pinned destination pairs, profile edits
and retirement, local and remote mode validation, inherited folder settings,
issue-owned artifact routing, failed and resumed group moves, nested immutable
snapshots after source storage becomes unavailable, and bounded catalog cutover
with long histories. Move receipts retain copied artifact ownership per issue so
deleting a child can release its exclusive evidence while preserving shared proof.
The Issue-store-only move regression makes unrelated retained payloads unavailable
and forbids artifact reads and writes when the Artifact destination stays fixed.
It checks report history, destination readback, released claims, and same-ID retry.
`node scripts/flow-browser.mjs --stores` drives the profile selectors, saved
destination readback, settings, bulk moves, interrupted moves, outages and recovery
using disposable stores. It also checks progress during resumed moves and clears
storage errors when navigating to a different issue. These checks use no live model
or cloud publication.

`node --test scripts/github-refresh.check.mjs scripts/store-runtime.check.mjs scripts/project-stores-flow.check.mjs scripts/factory-env.check.mjs`
checks idle reads after a simulated day without remote refresh, explicit refresh,
retained observations across observer recreation, failed refresh without automatic
retry, operation-time rejection after an external merge, and credential reuse.
Shared-store checks retain fresh mutation admission and coalescing. The fixtures
use disposable stores and injected GitHub responses, with no production requests.
`node scripts/flow-browser.mjs --block-inspection` checks that navigation and idle
polling send no automatic block mutation or explicit remote refresh request.
Clicking Refresh sends one explicit refresh, preserves the request draft, and
leaves controls usable. It also checks that the Codex request popup opens below its trigger without
moving New issue and closes when toggled.
It saves `github-refresh-on-demand.png`, `codex-requests-popup.png`, and JSON evidence.
The `--storage-status` browser scenario separately checks unavailable storage,
explicit recovery, and preserved drafts through injected responses.
`node --test scripts/store-records.check.mjs` also traces Git process launches
while reading several prefixes from one pinned snapshot. It checks one tree
listing and bounded content batches, Unicode values, sorted results and caller isolation.
`node --test scripts/factory-refresh.check.mjs` holds an open-block request while
clicking another issue. The new issue must render before the earlier action
finishes, and its view must survive the earlier action's response.

`node --test scripts/flow-progress.check.mjs` checks interleaved issue output,
workspace updates, timing, terminal results and concurrent-edit protection.
`node --test --test-name-pattern='manual operation displays live progress' scripts/project-stores-flow.check.mjs`
checks live manual Update Branch summaries and steps, stable timing for repeated
steps, input and stopping guards, and retained progress after completion. It holds
a disposable operation open and supplies progress events without a live provider.
`node scripts/flow-progress-benchmark.mjs PATH` compares the previous and current
progress-save and group-eligibility paths over five alternating runs. Its
disposable project contains 27 issues and two output streams. The JSON at `PATH`
retains HTTP index latency, callback time, exact persisted output bytes and errors.
This isolates local server work and does not measure model or GitHub latency.
`node --test scripts/flow-view-settings.check.mjs` checks that each view uses its
own folder settings snapshot, issue overrides stay separate, edits appear in the
next view, and started work retains its frozen settings. The folder-settings
checks also reject grouping after its preview's settings change.

`node --test scripts/factory-server-control.check.mjs` checks that No new actions
allows chat requests across issue, project, report, temporary, and coordinator
conversations while work dispatch stays paused. Its HTTP Discuss regression
sends and drains queued prompts through an injected provider with the switch on
and another action running. It starts no live model work.
The Flow browser suite checks that the runner holding the active Work claim can
resume playback and that No new actions still prevents dispatching the next block.
It also checks that the open page disables Resume once Work finishes while No new
actions is on. The focused Flow service test verifies that the pause itself
notifies watchers after the Work completion notification.

`node scripts/flow-browser.mjs --investigation-reports` checks retained report
reading and discussion. Its draft-restoration regression holds the discussion
response and dispatches a reader scroll before releasing it. The reopened draft
must retain its text; `report-draft-restore.json` records the observed value.

`node --test scripts/ai-text-bro.check.mjs` checks bro skill loading, a separate
read-only rewrite, invalid input and provider failure.
`node scripts/flow-browser.mjs --ai-text` checks that Copy and Bro appear flush
beneath the AI text, stay visible as the pointer moves onto either button, and
give back their layout space when the pointer leaves. It also checks clipboard
contents, the blue active Bro toggle, restoring original text, caret and end
insertion, and hovered-field hotkey routing. Automate me coverage checks a short
message inside its scroller and an editable draft. The evidence directory contains
`ai-text-controls.json` and screenshots of the hover and collapsed states.
The fixture injects model output and speech recognition.
Live model quality and physical microphone recognition are not measured by it.
The Factory refresh browser scenario checks that incoming AI text still follows
the reader at the bottom. View rendering mounts text controls before restoring
scroll, focus and selection so their layout is included in that restoration.
The AI-controls scenario recreates its Discuss service before installing its
provider so earlier browser scenarios cannot supply its response text.

`node --test scripts/flow-delivery.check.mjs` checks that no-change publication
stops before pushing or creating a PR, including already delivered candidates and
empty commits. `node scripts/flow-browser.mjs --no-changes` drives the no-change
Publish preview, Cannot Reproduce suggestion, cancellation and explicit closure
in a disposable project. It saves `no-changes-close-offer.png`; no live issue is
closed and no GitHub publication occurs.
The no-change and folder-settings scenarios use `withBrowserScenarioFixture`.
It snapshots executor and provider state, Git configuration, and lifecycle files.
It waits for execution and cleanup tasks, including tasks spawned by completion,
before restoring the snapshot after success or failure.
Run `node --test scripts/flow-browser-scenario-fixture.check.mjs` for injected
failure and chained-cleanup coverage with both existing and absent configuration.
Run the scenarios individually with `--no-changes` and `--folder-settings`.
Run `node scripts/flow-browser.mjs --no-changes --folder-settings` together.
Add `--reverse-fixture-scenarios` to run folder settings before no-change publication.
Run `node scripts/flow-browser.mjs --no-changes --sidebar-scroll` and repeat
with `--reverse-fixture-scenarios`. The sidebar check creates and removes its
overflow issues both before and after no-change publication activates the
Issue Store.
The main browser workflow intentionally shares state between checks and does not
use this boundary. Independent scenarios opt in at their exported entry point.
The missing-lifecycle browser scenario removes the disposable project's lifecycle
file before opening settings, even when earlier scenarios initialized it.

`node --test scripts/flow.check.mjs scripts/flow-delivery.check.mjs` checks the
merged-issue lock, preserved definitions and attempts, external merge observation,
restart persistence, editable unmerged/local issues, and historical Fixed acceptance.
`node scripts/flow-browser.mjs --merged-issue` drives the disabled controls and
direct HTTP guards, bulk preflight, history after reload, Close, Cleanup and the
deferred reopen guard in a disposable project. It saves a screenshot and
`merged-issue-readonly.json` under its reported evidence directory and starts no
live model work.

`node --test scripts/shared-issue-claims.check.mjs scripts/shared-issue-queue.check.mjs scripts/shared-issue-atomic-archive.check.mjs scripts/source-issue-separation.check.mjs`
uses independent clones and a disposable remote. It checks same-issue exclusion,
unrelated claim races, exact-owner release, unknown push outcomes, atomic report
checkpoints, local file preservation, and legacy cutover guards. The direct status
case refreshes another runner while preserving source HEAD, source tracking refs,
staged index, source status, and unstaged files in both checkouts. The source
cutover command is repeatable and refuses unpublished report bytes. The commit
guard preserves alternate-index semantics. These tests start no production work.

`node scripts/flow-browser.mjs --actions-menu` holds two FlowService executions
with an injected executor, opens the actions menu, and checks both running rows
and their Flow output links. It also checks that the open menu removes completed
work. The disposable fixture saves screenshots and `actions-menu-proof.json`
under its reported evidence directory. It starts no live model work.

`node --test scripts/fallow-css-reset.check.mjs` runs the pinned Fallow CLI and
the unchanged strict audit policy on a CSS reset. It also adds an actually unused
selector and confirms that the same policy blocks it.

`node --test scripts/branch-repair.check.mjs` checks isolated repair candidates,
retained progress, approval, stale source and environment files, tampered patches
and check evidence, Stop, restart visibility, and bounded provider repair with
injected model and check responses. It preserves staged and uncommitted edits.
`node scripts/flow-browser.mjs --branch-repair` drives the real issue-page button,
red check-failure state, progress after reload, candidate diff, and explicit
approval in a disposable checkout. It holds an explicit issue refresh and
checks that repair controls remain available, then releases the refresh before
accepting a repair command. It waits for the injected repair worker to save
progress before reloading and checks that the reopened dialog shows that output.

`node --test scripts/block-skills.check.mjs scripts/flow-folder-settings.check.mjs`
checks per-block defaults, personal/project extensions and explicit skill choices.
`node scripts/flow-browser.mjs --block-skills` drives the graph skill picker,
missing-skill setup option, and saved No skill/skill selections in a disposable project.

`pnpm run test:factory:env` checks project `.env` credential loading, exported
environment precedence, and idempotent setup that preserves unrelated values and
rejects invalid PEM input before writing. It uses disposable directories and keys.
Each test clears and restores the inherited GitHub App environment so the runner's
credentials cannot replace the fixture values.

`pnpm run test:project-discuss` checks saved project conversations, immutable
message settings and attachment copies, explicit queue/Stop/Retry behavior,
native tool and permission ownership, skill invocation policy, and guarded
Home/issue dispatch in disposable projects. `pnpm run test:project-discuss:browser`
checks that Home opens without a selected issue or a Branch Fix control, then
drives Home/Discuss navigation, retained drafts, Markdown, model/effort and skill
selection, Tab acceptance, downloading retained attachment copies, queued edits and Stop.
The clarification dropdown offers setup while the fixture omits `grill-me` and
removes the option when refreshed discovery finds the skill.
It also checks opening a long conversation after delayed history and image loading,
reloads, returning to Discuss, and preserving manual scrolling through a polling
rerender. It retains those observations in `project-discuss-scroll.json`. Dictation
uses an injected speech recognizer in this scenario. The spoken send checks
verify automatic submission without the final "go", no submission for "go" alone,
and no automatic submission for "go" in the middle. They retain the observed
provider submissions in `project-discuss-dictation.json`. Real dictation requires
browser speech-recognition support and microphone permission; audio is not saved
by Timey. Native provider availability is a separate smoke check.
The Discuss scenario also opens enough conversations to overflow at desktop and
narrow widths. It checks container bounds, hidden scrollbar styles, and scrolling
to every tab, saving the observed styles, widths and visibility in
`project-discuss-tabs.json`.
The Discuss scenario saves `project-discuss-styles.json` beside its screenshot.
It records the source commit and each rendered message's top and bottom border
styles and widths, so divider checks can use observed computed styles.
The production closed issues are reserved for the user's own archive test and
must not be used by these checks.

`node scripts/flow-browser.mjs --interface-state` checks expanded tool activity,
editor size, drafts, caret and scroll preservation through polling, same-tab
navigation, and reload. It drags a real selection across an issue poll and checks
the copied clipboard text. Different requests and new tabs retain independent
state. The fixture uses disposable conversations and issues and starts no model
work. `node --test scripts/interface-state.check.mjs` reproduces the original
Discuss collapse and checks selection through growing and replaced activity.

`node scripts/flow-browser.mjs --project-navigation` checks the full-width header,
the order and destinations of the Home, Issues, Reports, Discuss, Automate me, and
Admin tabs, and the relocated Factory controls. It saves desktop and narrow
screenshots alongside the measured layout and navigation in `project-header-proof.json`.
The navigation fixture temporarily initializes queue configuration, waits for a
successful Issues queue response, and unloads the page before restoring configuration.
Run `--ci-part=1 --project-navigation --sidebar-labels` together to check sidebar
label styling and verify that visiting Discuss leaves no browser console errors.
`--ci-part=2 --capture-folder-issue --closed-destination` checks that closed
flows open and refresh with Destination aligned to the bottom at both tested heights.
`--ci-part=2 --capture-folder-issue --save-request-route --stop-work` checks that
the running block stays centered when the workspace header changes height after reload.

`node scripts/factory-project-account-browser.mjs` starts a disposable Timey
instance and Factory server. It opens every project tab at 390px while Login is
visible, signs in through Timey's existing form, opens Account, and signs out
from the header. The reported evidence directory contains desktop and narrow
screenshots and `project-account.json`.

`pnpm run test:project-home` checks project investigation capture, selected-branch
execution, automatic follow-up approval and retry, historical closure statistics,
project-scoped Automate me history, retained conversations, and reviewed skill
application in disposable projects. `pnpm run test:project-home:browser` drives
the actual home page and dialogs, including custom history duration, discussion,
Run, findings, draft edits, Apply, reload, and narrow layout with injected models.
The Project Home browser check waits for the archive deletion response, then
checks the displayed result and confirms that the report and selected branch are gone.
The factory and Flow aggregate checks include these scenarios. Live provider
availability remains a separate check.

The investigation checks also cover create-only navigation, one-time and reusable
runs, immutable run history, per-run destinations, fresh defaults and branch tips,
source-preserving temporary snapshots, success/failure/Stop cleanup, and direct
archive/restore. Shared-queue checks retain report freshness, protected claim
release and ordinary closed-issue behavior. Chrome drives the shared investigation
page, historical result selection and Archive/Restore using injected responses.

`pnpm run test:flow` checks flow records, cancellation, exact candidate evidence,
publication, and guarded closure in disposable projects. `pnpm run test:flow:browser`
drives the real flow page and HTTP routes with an injected executor. Its results,
logs, screenshots, and fixture stay under `.issues/evidence/flow-browser-*`. These
checks establish UI and protocol behavior, not live model or GitHub execution.
Use `pnpm run test:flow:browser --block-deletion` for the isolated click-selection,
confirmation, keyboard safety and persisted block-removal scenario.
Its fixture identifies added blocks by their new IDs so it deletes the intended
Advice blocks regardless of their insertion position.
Use `pnpm run test:flow:browser --issue-results` to check result placement below
the issue banner, independent playback status, and hiding empty results.
Use `pnpm run test:flow:browser --human-input` for required-review instructions,
PR links, sidebar and block indicators, persisted requests, explicit Continue,
and the distinction between human input and technical failure. The fixture
injects review readiness and an open PR response for the merged-issue guard; it
performs no live GitHub review or merge.
Use `pnpm run test:folder-settings:browser` for the isolated folder settings,
repair, search, grouping eligibility, and selected Open or Closed bulk actions.
The fixture injects AI responses and execution, and uses disposable reports.
The aggregate factory and browser scripts include these checks.
Run `node scripts/flow-browser.mjs --sidebar-scroll` to check wheel scrolling over
the project menu, Notes, Files and Issues with overflowing content at desktop and
narrow widths. The fixture adds rows to the real page and checks that each wheel
moves content outside the hovered section. It retains screenshots and
`sidebar-scroll.json`, and checks that resizing remains available after scrolling.
For the isolated investigation follow-up review, run
`node scripts/flow-browser.mjs --investigation-followups`.
`node --test scripts/flow-followups.check.mjs` checks reviewed creation, lineage,
restart/replay, partial failures, and changed findings with disposable reports.
These checks inject proposal responses and create no issues in the live queue.
For an installed Chrome when the Playwright Chromium cache is unavailable, run
`TIMEY_BROWSER_CHANNEL=chrome pnpm run test:browser`.

`node scripts/flow-browser.mjs --connection-recovery` checks expired sessions and
recovery after a lost action response in Flow and Classic with a disposable issue.
It waits for initialized controls and the pause request before dropping health
responses, then checks the selected issue, saved pause state and single dispatch
after recovery. The action uses a click because its deliberately lost response
can reset the checkbox before reconnection restores the saved state.

For default [draft PR handoff](issue-delivery.md#default-draft-pr-handoff), attempt
relevant checks once per changed candidate and retain failures or unavailable
checks as such. They do not block the handoff or trigger a repair loop. Passing
verification, fixed closure and the explicitly selected verified-delivery route
retain the gates below. A handed-off assignment may contain incomplete code;
never describe that result as verified implementation.

Factory protocol fixtures use `factoryGitFixture` to stage project and Inbox settings
before their initial commit, so later queue reads preserve the clean source tree.
Deployment and restart fixtures copy `factory/system` with the server scripts.
The legacy UI rendering fixture loads all inline scripts in document order,
including both the embed setup and the application script.
Chat startup tests use disposable project settings and wait for actual request
dispatch before advancing their mocked timeout.

Use pnpm and the checked-in `pnpm-lock.yaml`. `.nvmrc` pins the local runtime;
`package.json` declares supported Node versions and the pnpm version in
`packageManager`. Run `pnpm install --frozen-lockfile` in a clean checkout.

The local issue helpers are a pinned development dependency packaged in
[`vendor/`](../../vendor/README.md). The relative `.agents/skills/issues` link
resolves through that installed package; verification and CI require no personal
skill checkout. Its original human-input protocol and integrity manifest are
unchanged. Install the frozen dependencies before running factory checks.
Symbolic links remain in the exported snapshot and audit scope; their link
metadata is not passed to the formatter, which rejects symbolic-link paths. Changed
regular target files retain their own formatting checks.

| Command                             | What it establishes                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm run test:browser`             | Headless Chromium interactions against candidate UI assets with disposable data; retained logs and screenshots         |
| `pnpm run test:factory`             | Ledger, live UI/CLI boundaries, verifier dispatch/isolation, and audit-result checks using disposable Git repositories |
| `pnpm run typecheck`                | TypeScript compiler result; report existing failures explicitly                                                        |
| `pnpm test`                         | Mock-backed Vitest behavior; recorder CSVs and backups use per-test temporary directories                              |
| `pnpm run build`                    | Production compilation, not runtime or device behavior                                                                 |
| `pnpm run audit:diff -- --base REF` | Fallow audit on changed files in an exported working snapshot (same new-only gate as other checkpoints)                |
| `pnpm run audit:step -- --base REF` | Required audit before declaring an implementation step complete, even without a commit                                 |
| `pnpm run audit:staged`             | Exact index snapshot audit; unstaged fixes cannot hide staged findings                                                 |
| `pnpm run verify -- --base REF`     | Changed-file formatting and Fallow gate the browser, Factory, type, test, and build checks                             |
| `pnpm run format-check`             | Repository-wide formatting, including inherited drift                                                                  |

Recorder tests create a unique directory under the system temporary directory for
each test and remove it in teardown, including after assertion failures. Replay
inputs are self-contained; individual replay tests do not depend on earlier tests
or root CSV files. Existing root CSVs are never test cleanup targets.

`verify` exports source into a disposable local clone, shares installed dependencies
only when lockfiles match, and deletes the clone afterward. Each command prints
START, streams child stdout and stderr into the console while also retaining
them in the evidence log, and emits a periodic running message during
silence. Every verification command, including CI, has a 15-minute deadline;
a heartbeat never extends it. Failed commands print their complete diagnostic output in a CI log group; Node test failures print the full final failure section, including assertions and source locations. Retained artifacts keep the complete command log.
Per-command logs are readable before completion; summaries retain the
original pass/fail and separate audit-channel assessment. Evidence stays under
`.issues/evidence/` with a JSON summary and per-command logs. Preserve relevant
results in the tracked effort plan before a fresh-worktree handoff. Reports identify
base and snapshot mode; a failed or unavailable check remains a failure/blocker.
The aggregate verifier invokes `pnpm run test:factory` inside that export so its
factory coverage follows the package entry point. A factory failure fails the
aggregate result while the other required checks still run and report separately.

The Flow **Verify** block can check saved, uncommitted source changes. Its
verification and step audit must report the same snapshot tree. The source
check records symlinks by their link targets and accounts for deleted files.
Update Branch aborts a pending merge before fetching the starting branch, then
checks that the issue branch contains the fetched commit. Its focused executor
checks cover restarting a conflicted merge against the latest upstream while
preserving committed issue work and an untracked draft. If conflict resolution
returns without resolving the files, the error includes the worker’s explanation
or decision request. Other Git operations
remain blocked. The issue header shows a red Merge in progress menu while Git
has a pending local merge. Its Abort merge action checks the observed merge and
requires an idle issue. A new Merge run also aborts a pending local merge once
before synchronization; subsequent repair steps preserve their own merge state.
`node scripts/flow-browser.mjs --merge-recovery` checks the control through reload
and abort using a disposable real conflict. Publish PR requires a clean commit.
Merge syncs the issue branch with Destination, pushes a changed candidate,
and waits for the checks and reviews GitHub requires on the exact PR head.
Work and explicit Verify remain the places for local verification.

GitHub runs Early checks first. Five jobs then run in parallel: two Non-browser
jobs, Classic Factory browser, and two Flow browser jobs. The Non-browser jobs
split the Factory Node test files. The second also runs Vitest and the build.
The Flow browser jobs split at the start of the shared issue fixture so dependent
scenarios stay together. The required `test` job passes after all six jobs pass
and their evidence matches the same Actions revision, base, and tree.
**Re-run failed jobs** reuses passing results and evidence for the same
candidate. A new commit starts a new verification run.

Factory Merge waits 15 minutes by default after pushing the candidate or first
seeing pending checks. Each completed Verify suite adds five minutes once for
that PR head, up to 30 minutes from the start of the wait. Factory refreshes the
PR and its checks once more when the deadline expires. Pending checks still
block merge. The timeout does not cancel GitHub jobs.

`node --test scripts/strategy-provider-diagnostics.check.mjs` checks that
Factory preserves the request ID on a GitHub GraphQL query error and marks it
retryable when GitHub CLI omits the HTTP status. Explicit authentication,
permission, and validation responses remain terminal.

For a PR repairing failed CI tests or typechecking, record the exact commands in
`.github/pr-repair-tests.json`. `pnpm run test:pr-repair` runs them by name and
stops at the first failure. CI runs this plan before broad verification while
the manifest differs from the PR base; after it merges, unchanged plans are
skipped. Use `node scripts/flow-browser.mjs --timers` for the isolated attempt
timer scenario. Repair workers reproduce the named failures, include necessary
predecessor scenarios, and return after focused proof so GitHub can check the repaired commit.
When the PR repair plan includes the `flow-integration` suite, its named repair
cases run first and the six shared checks follow in their recorded order. The
shared plan lives at `scripts/flow-integration-tests.json` so it travels with the
installed Factory server and is also available to the CI runner.
A named Flow browser check can include one `--ci-part` flag to use the same
fixture setup as that GitHub job.
`node scripts/flow-browser.mjs --ci-part=1 --inbox-flow` checks Inbox dates,
statuses, folder ordering and block drag in isolation. It scrolls the target
block into the graph viewport before measuring the drag, then checks the
projected order, saved revision and connections after reload.
Include `--stores` when reproducing browser failures after storage activation;
an isolated legacy-storage run does not establish that the store-backed case
passed. `--proposals --delayed-delete` holds a proposal Delete request for 16
seconds. The shared action helper allows 60 seconds for mutation responses and
still checks their actual status and result. CI prints failed checks and browser
scenario names directly from the retained verification record.

To verify an update, open the latest **Update Branch** attempt in Flow. Confirm
that it shows `completed` and records `containsFetchedCommit: true`. Copy the
exact `fetchedCommit` hash from the result.

In the issue worktree, replace `FETCHED_COMMIT` with the copied hash and run
`git merge-base --is-ancestor FETCHED_COMMIT HEAD`. Exit status `0` confirms
that the current issue branch still contains that commit, even if `HEAD` has
advanced since the update. Keep the attempt result and the Git check outcome
with the smoke-test evidence.

Drag-and-drop browser scenarios are excluded from ordinary verification and
full regression and CI. They run only when explicitly requested
with `pnpm run test:browser:drag-and-drop`. This covers legacy queue reordering,
issue-folder assignment and Flow folder dragging. These fragile browser
interactions must not gate unrelated delivery. Deterministic folder and ordering
tests remain in their existing suites. `browser-scenario-policy.mjs` applies this
selection in both browser runners; its focused check verifies ordinary, full and
explicit selection.

Before Merge invokes its repair worker, it copies the verification summaries,
command output and each failed check log into the issue checkout. The prompt
identifies failed checks separately from successful checks and references the
local copies. Each repair round has its own directory for the worker response,
declared artifacts, and the Merge log captured when the repair starts. The
Merge repair index links each failure to its committed candidate, verification
summaries, and ordered conversation entries. The regression in
`scripts/flow-executor.check.mjs` checks three rounds with repeated artifact
names and verifies the retained hashes after the final round.
GitHub artifact downloads have a two-minute transfer deadline; ordinary GitHub
CLI requests retain their 30-second deadline. This lets large failure evidence
finish transferring before the repair worker is invoked.

Merge uses GitHub readiness for the exact PR candidate on both individual and
master issues. Close confirms the exact merged PR, target branch, and required
GitHub checks.
The delivery manifest records the merged candidate tree and retained Work proof.

The Notes browser scenario leaves a pending Discuss draft, unloads the preceding
page, and closes its Discuss service before installing its own injected provider.
Its console assertion catches draft saves that cross that fixture boundary. Run
`node scripts/flow-browser.mjs --project-discuss --local-notes` to verify the
Discuss-to-Notes transition; combining focused flags runs those scenarios together.

The capture-start browser scenario waits for active route handlers before removing
its mocks. Issue refreshes can still be fetching the fixture queue when capture
finishes; removing those routes immediately can release a request before its
handler fulfills it.

When closing a delivered flow, the delivery manifest records the verified
candidate tree and the upstream Work blocks' requested proof. It retains proof
whose hash and recorded Work tree match the delivered candidate. The manifest
records missing or unavailable proof and proof from a different tree as gaps.

Work runs `verify -- --work-checks --write-format --base REF` to format
issue files and check Fallow before running focused tests for the changed
behavior and Requested Proof. Run individual test files or scenarios directly
when an aggregate command would include unrelated tests. Work leaves aggregate
suites such as `pnpm run test:factory` to GitHub CI. Add a focused test when needed. Factory rechecks formatting and
Fallow after Work's response.

A standalone focused browser check can be recorded as `node scripts/<name>-browser.mjs`
without extra arguments. A focused Flow browser command requires a scenario
flag registered in the candidate commit's `scripts/browser-scenario-policy.mjs`.
Register flags as quoted keys in the `flowBrowserScenarioNames` object. Factory
reads that declaration and the quoted flags in the candidate's
`flowBrowserCiParts = new Set([...])` during Work and publication validation.
Each focused command still requires a named scenario and accepts at most one
CI-part flag. You can add
`--reverse-fixture-scenarios` to change fixture order.
The aggregate Factory browser runner belongs to full verification.
Work accepts the Node `--test-name-pattern` value as a separate argument or
joined with `=`. It stores both forms as the same command.
When Factory rejects a focused command, its diagnostic identifies the entry in
`focusedTests`, the rejected argument when present, and the rule it violated.

Fallow 3.35.0 can miss CSS consumers in plain JavaScript HTML strings, and its
source-location attribution can mark unchanged findings as introduced when an
earlier line is deleted. Reproduce suspected inherited findings on the saved base.
When the intent is to remove a visible style, an explicit reset such as
`border-bottom: none` can preserve that intent without shifting existing findings.
Do not add meaningless padding or suppress diagnostics. The project extension at
`user/flow/extensions/blocks/fix-the-branch.md` gives repair runs this guidance.

When a Work check cannot install dependencies, the issue checkout retains
`.issues/evidence/dependency-recovery.json` and per-attempt install logs. A
continued Work resolves an unfinished recovery record before starting its model
turn. Transient network failures retry at most three times across interruptions;
the record marks dependencies ready only after the installed lock and workspace
dependencies pass `dependencyPreflight` and describes the recovery command.

Install the checked-in staged Fallow hook with `pnpm run hooks:install`. It refuses
to replace another hooks directory. It runs the audit on the index snapshot before
commit; it does not imply all tests passed. Run relevant checks as well. When the
caller does not have node on `PATH` (GUI Git clients do not load nvm), the hook
adds the `.nvmrc` Node bin, then Homebrew, and runs the staged audit with that
node. Fallow is pinned to 3.35.0. Checkpoint paths invoke the installed binary,
`fallow audit --base <resolved-commit> --format json`, in the exported snapshot,
using the existing local dependency and `.fallowrc.json`
`audit.gate: new-only`. Enforced checkpoints disable only Fallow's incremental
cache because each audit runs from a disposable export root and stale cross-root
cache warnings fail strict audits; the full configured audit and gate still run.
Full-tree `fallow dupes` and `fallow health` skip Vitest
files (`*.test.ts(x)`) and factory script tests (`scripts/**/*.check.mjs`,
`scripts/**/*fixture*.mjs`) via `duplicates.ignore` and `health.ignore`, and use
`production` mode for other conventional test paths. Dead-code analysis still
uses factory check scripts as tooling entry points. Checkpoint audit still
analyzes changed files in the diff, including tests, when those paths are not
ignored for that sub-analysis. A bare `npx fallow` (same as `pnpm run fallow:full`)
prints every function above the complexity threshold and can flood the terminal;
prefer `pnpm run fallow` (`fallow --summary`) for a short rollup, `pnpm run
audit:staged` or `audit:diff` for checkpoint scope, or `pnpm run fallow:health`
for the top 15 complexity hits only. The helper passes one Fallow `PATH` derived from the Git changed-file list (a single
file, their common directory prefix, or `.` when changes span unrelated roots) so
reported findings stay scoped to the diff instead of defaulting to the whole tree. Fallow may still build a project graph for import
resolution; the verdict uses only **introduced** findings in those changed files.
Inherited issues there do not block. They never use the always-successful
`review` mode or download another binary. Each changed file is analyzed in full;
line-only diff filtering must not hide introduced findings elsewhere in those
files. For a stricter manual check (all findings in changed files), run Fallow
with `--gate all` yourself.
An empty diff is not evidence that new uncommitted files were audited: the snapshot
helper stages its exported files before computing the diff. Sources, index, and
queue of the original checkout are not modified by verification.

For an independently empty exported index diff against the resolved base, the
pinned CLI's compact audit may omit analysis diagnostics. The verifier supplies
that Git-derived scope to the validator; a zero changed-file count reported by
Fallow alone never establishes emptiness. The result records `scope: "empty"`
and an `empty-source-diff` limitation, without claiming unrelated analysis passed.
Process success, pinned JSON/schema, zero findings, pass verdict and the all gate
are still required; warnings, degraded or malformed diagnostics and contradictory
scope fail. Every nonempty snapshot still requires analysis diagnostics, including
untracked additions and deletions. Callers without independently verified scope
retain strict validation and cannot infer empty scope from a saved tool report.

### Commit and step-completion checkpoints

GitHub Actions runs Verify for pull requests to any branch, including the
Destination selected in Flow. Direct pushes trigger Verify on `main` and `dev`.

Factory formats issue reports when it captures an issue, saves report metadata
or a lifecycle result, or completes archive. Captured original wording keeps
its literal whitespace.

Before a commit, the pre-commit hook formats staged issue reports and checks
formatting on other staged files. It updates a working copy of a report only
when it matches the original staged contents, preserving unstaged edits. It
then runs `pnpm run audit:staged`, which exports the staged snapshot
for verification bookkeeping. **Fallow is skipped by default for legacy/local commands.**
Strategy candidate checks and CI enforce Fallow with
`TIMEY_FALLOW_ENFORCE=1 TIMEY_FALLOW_WARNINGS=error`. Their new findings, including
warnings, must be repaired. Skipped or warning-bearing evidence cannot satisfy
these strategy checks or be reused from the legacy cache. Set
`TIMEY_FALLOW_ENFORCE=1` when you want the pinned Fallow audit to fail the hook,
`audit:step`, or full `verify`. Before declaring an implementation step complete,
including an uncommitted step, run `pnpm run audit:step -- --base <step-start-commit>`.
Use the recorded starting revision, not the new HEAD after committing (which could
hide that step's changes). Full `verify -- --base REF` runs types, tests,
build, and factory checks after formatting and Fallow pass. Fallow enforcement
is opt-in outside Flow, strategy, and CI checks. A successful audit
does not establish type/build/device success.

A checkpoint fails on a nonzero Fallow process exit, a `fail` or `error` audit
verdict, warning text on stderr, degraded analysis, missing/unsupported JSON, or a
mismatched gate. A `warn` verdict with exit zero passes only for legacy commands without
`TIMEY_FALLOW_WARNINGS=error`; strict strategy/CI checks reject new warnings.
The verifier uses `--no-cache` for Fallow so base/head analysis does not reuse an
incompatible graph cache or produce cache-mismatch warnings. Analysis is unchanged.
Inspect and fix findings, then rerun. Do not suppress warnings, add exclusions,
weaken thresholds, or select a later base to make the checkpoint green. An active strategy authorizes necessary blocker repairs outside the original
feature under the [approved repair policy](../plans/autonomous-blocker-repair.md).
Preserve product intent and record repair evidence. Other workflows retain their
existing scope boundaries; actual human decisions and permission denials still stop.

Summary evidence records the full resolved base, source HEAD, exported Git tree,
changed files, checkpoint kind, actual command, raw log/JSON, reasons and pass/fail.
Recheck evidence after any relevant source/index change. An empty scope is recorded
as empty, not proof that unrelated code was audited. The two unconfigured-detector
diagnostics (architecture boundaries and policy rule packs) are retained as
unmeasured coverage, not counted as successful checks; configuring those detectors
is separate architecture work. Other diagnostics fail closed. The audit covers
configured analyses in changed files, not every unchanged file in the repository.

Repository-local Git environment variables are preserved only for reading the
source index; child clone/Git/check processes receive a clean repository context.
This supports hooks and alternate indexes without auditing or changing another
repository's index. The checkpoint commands enforce failure when invoked; agent
completion still depends on following this guide and reviewing current evidence.
There is no global chat-completion interceptor.

The original baseline passed 10 Vitest tests and the production build in a
disposable checkout. Typechecking failed on existing Prisma-nullability and UI
typing errors; repository formatting reported 13 existing files. These are not
waivers: `verify` still returns failure until repaired. Use the local baseline
issues/evidence to distinguish inherited failures from new ones.

## Hands and eyes

Run `pnpm run dev -- --host 127.0.0.1 --port 3000`, save server logs outside tracked
source, and inspect readiness before opening the app. Use a free port rather than
replacing another server. The home page is the initial smoke path; check actual
rendered controls, browser console/network failures, and navigation. An HTTP 200
or a screenshot alone does not establish hydration or interaction behavior.

Database-backed/authenticated paths require configured local services. Compose
defines Postgres; inspect readiness with `docker compose ps` and logs. The domain
datasource needs `DATABASE_URL`; Better Auth needs `AUTH_DATABASE_URL`, `BETTER_AUTH_URL`,
and `BETTER_AUTH_SECRET` (see [AUTH_SETUP.md](../../AUTH_SETUP.md)). Compose uses
`DB_USER`/`DB_PASSWORD`. Use supplied local configuration, never print secrets or
reset persistent volumes as a recovery step. Document unavailable credentials or
services instead of substituting mock-backed evidence for real integration.

Use disposable fixtures for writes. A prototype is labeled simulated evidence
unless it uses the real integration. Tutorial navigation is not a verification
verdict. Mocked MIDI cannot establish acoustic or physical-device timing.

## Authentication foundation

Run `pnpm run test:auth` for the actual app HTTP/session and disposable PostgreSQL
proof; see [setup and coverage](../../AUTH_SETUP.md). This creates its own cluster,
owners and databases under a unique temporary evidence directory and retains
commands, assertions and dumps. Existing Compose databases are not targets.
Database-session acceptance and profile recovery are exercised independently of
designated-admin authorization and other pending cutover work.

Run `pnpm run test:auth -- --browser` for the separate app-native `/auth/` screen
slice against that uniquely isolated PostgreSQL cluster and local SMTP capture.
This uses actual signup/login/reset forms in two browser sessions, validates
remember-me/reload/logout cookies and password-reset delivery, expiry, reuse,
old-password rejection and all-session revocation. It retains screenshots,
console/network output, assertions and command exits under the fixture directory.
See [setup](../../AUTH_SETUP.md) for browser prerequisites and partial-rollout
limits. Screen success does not establish domain authorization, coordinated admin
work, deletion behavior, human UX approval or live SES delivery.

The verifier links each declared workspace's installed dependency directory into
the exported snapshot, preserving workspace dependency resolution without changing source
or audit gates. Both application and auth use the approved Zod 4 pin; older framework
packages retain their declared nested dependencies. Use matching `pnpm install --frozen-lockfile` dependencies before verification.

## Human checks

Each issue can have `human_checks` in YAML, separate from `state`/`triage_role`:

```yaml
human_checks:
  - id: midi-device
    kind: evidence
    instructions: 'Perform the recorded MIDI timing scenario on the named device.'
    status: pending
    blocks: dependent-work
    revision: 'commit being checked'
    result: null
  - id: final-experience
    kind: judgment
    instructions: 'Judge the integrated workflow against the agreed outcome.'
    status: pending
    blocks: closure
    revision: 'commit being checked'
    result: null
```

Allowed kinds are `evidence`/`judgment`; statuses are `pending`/`passed`/`failed`.
Record the human's actual result and relevant revision. A code change invalidates
affected evidence. Check scope before declaring older evidence still applicable.
Pending checks can coexist with commits, but block dependent work or closure as
specified. Final acceptance is separate, explicit, and as late as possible.

## Private practice slice

Run `pnpm run test:auth -- --practice` for real server-function and rendered
transport checks with two users in uniquely disposable PostgreSQL. It reuses the
foundation fixture infrastructure without rerunning the completed foundation and
screen investigations. Inspect `practice-assertions.json`, `practice-commands.json`,
application logs and `output/playwright/` in the printed absolute directory.
Rejections must correspond to real server requests; JavaScript/import failures
are test failures, not proof of authentication rejection. Retain SQL before/after
snapshots for rollback and unrelated-history checks. Report expected rejection statuses, unrelated MIDI diagnostics and unexpected errors
separately. See [partial cutover boundaries](../../AUTH_SETUP.md#private-practice-verification).
Content authorization, designated Admin behavior, content deletion, hardware timing
and final human judgment remain separate obligations.

## Method/module write slice

Run `pnpm run test:auth -- --content` for real server-function/API requests and
rendered existing creation/edit controls with two users in uniquely disposable
PostgreSQL. Retain `content-commands.json`, `content-assertions.json`, SQL logs,
application logs and `output/playwright/` in the printed directory. The fixture
asserts actual rejection response statuses and unchanged rows, trusted authors,
owner edits/moves, destination-owner checks, forged fields/cookies, expired and
revoked sessions, profile failure/retry, concurrent ownership changes, public reads,
rendered permission errors and account switching. Browser/import failures fail the
proof. Run the separate `--practice` regression; completed foundation/screen
investigations need not repeat. See [setup and explicit legacy boundaries](../../AUTH_SETUP.md#methodmodule-write-verification).
Deletion, beat/admin permissions, retirement, integration, human UX judgment and
acceptance remain outside this slice.

## Beat creation/copy slice

Run `pnpm run test:auth -- --beats`, then the separate `--content` and `--practice`
regressions. The new proof covers owner creation, public-source copy into an owned
module, no-destination recovery, forged fields and sessions, expired/revoked sessions,
profile failure/retry, account switching, concurrent destination ownership changes,
nested-write rollback and source/history preservation. Retain the printed directory's
`beat-commands.json`, `beat-assertions.json`, SQL logs and `output/playwright/`.
Expected HTTP rejections must be real requests; browser/import failures fail the check.
See [partial cutover inventory](../../AUTH_SETUP.md#beat-creation-and-copy-verification).
Existing-beat editing, deletion, Admin enforcement, retirement and human judgment remain separate.

## Existing-beat editing slice

Run `pnpm run test:auth -- --edit-beats` for real server-function/API and rendered
editing checks in uniquely disposable PostgreSQL with two users. Run `--beats`,
`--content` and `--practice` separately as regressions. Retain the printed absolute
directory's `beat-edit-commands.json`, `beat-edit-assertions.json`, SQL logs,
application logs and `output/playwright/`. The fixture checks author edits/moves,
non-owner/unowned-destination denials, immutable authorship, strict forged-field
rejection, missing/expired/revoked/forged sessions, profile failure/retry, rendered
errors and account-switch draft clearing. Concurrent author, destination-owner
and current-parent changes must not bypass checks. Deliberate note-write failure
must roll back the beat update and note replacement. Both users' history and
unrelated content must survive. Browser/import failures fail this proof.
See [inventory and limits](../../AUTH_SETUP.md#existing-beat-editing-verification).
The missing designated-admin exception, deletion, retirement, integration and
final human judgment remain separate obligations.

## Ordinary-author deletion verification

Run `pnpm run test:auth -- --delete-content`, followed by `--edit-beats`, `--beats`,
`--content` and `--practice`. Retain the printed absolute directory's
`deletion-assertions.json`, `deletion-commands.json`, SQL logs, application logs and
`output/playwright/`. The proof uses two users, actual compiled server-function/API
requests and rendered confirmation/cancellation, refresh and account-switch paths.
It covers strict ownership/session fields, both users' history, descendants,
reference clearing, preserved auth/unrelated records, concurrent changes and
rollback. Browser/import failures fail the check and never count as rejections.
See [deletion semantics and lock tradeoff](../../AUTH_SETUP.md#ordinary-author-deletion-verification).
Designated-admin enforcement, retirement, integration and human judgment remain separate.

## Workflow compatibility

Run `pnpm run test:workflow` while changing issue decisions or evidence freshness.
This shared suite uses disposable queues, the actual decision handler and installed
human-input guard. Its fixture also supplies delivery tests. Full `test:factory`
and `verify` include it; use the focused command during editing before final checks.

Exercise all supported result formats: retained delivery receipts, completed stage
history and older prose-only commit records. For each, acceptance must survive an
unrelated commit, branch switch, dirty checkout, another issue's activity and an
unrelated coordinator lock. Acceptance retains the original result revision and
explicitly records that verification was not rerun. No mutation accepts by itself.
Pair these cases with selected-report freshness, same-issue work and pending/failed
observations. For formats with retained proof, changed or missing proof must block
with its path. Prose-only records preserve their limited evidence; never fabricate
missing historical tests. Keep the matrix current when adding a record format.

Review gate meaning with [review standards](../../CODING_STANDARDS.md), including
whether the tests assert the intended policy. Queue-wide freshness is not a default
for an issue-local decision.

## Persistent issue chat checks

Run `pnpm run test:chat` for shared issue history, stable event identities,
source attribution, native identity reuse, FIFO queue persistence, selected skills,
edit/remove races, exact-turn steering, lost acknowledgements and interrupted
output recovery. These disposable fixtures distinguish confirmed verification,
GitHub merge, local target update and closure from conversation claims.

Run the discussion and Clarify checks for durable stage interviews, reopened
review, main-composer human answers and generated-instruction quote rejection.
Strategy and server-control checks cover queue boundaries, saved verification,
noncancellable merge reconciliation, checkout creation and permission routing.
`test:browser` includes queue editing with skills, reload, removal, resume and
queueing during merge against actual candidate assets with disposable responses.
The aggregate factory suite includes the protocol checks.

Use a real provider smoke separately to verify the installed skill catalog and a
retro plus an ordinary history query in the same thread. If `what-did-you-do` is
not installed, the ordinary query is the coverage check. Fixture merge records
are synthetic and establish no actual GitHub merge. Foreign native writers that
the installed transport cannot observe must hold the queue with an explicit
capability limitation. Existing lifecycle and integration tests still own reviewer
independence, actual permission, merge approval and acceptance guards.

## Deployment readiness diagnostics

`node --test scripts/factory-deploy.check.mjs` uses disposable listeners and Git
fixtures. It includes an unsuccessful candidate (HTTP 503) and unsuccessful
recovery (runtime identity mismatch) through the real deployment waits, with the
production timeouts and failed-recovery lock intact. It prints the retained
absolute evidence directory containing receipt, readiness observations and server
log. Separate probes verify transport refusal, runtime HTTP rejection, malformed
JSON, successful readiness, bounded retention and exclusion of response secrets.
These fixtures deploy no live service and do not diagnose a historical timeout
when its original readiness observations were not retained.

## Issue PR delivery

Follow [issue delivery](issue-delivery.md) for contribution assembly, complete-issue
review, publication, recovery and server-enforced merge gates. New delivery uses
one PR per complete issue. Historical records retain their original meaning.

## Issue capture checks

Run `node --test scripts/issue-creation.check.mjs` for HTTP and direct Flow creation,
multi-issue Classic capture, retry identity, and peer deletion after capture.
The disposable provider refuses unrelated report reads, so these checks detect
queue-wide refreshes during creation while confirming new report persistence and
preservation of the existing display snapshot. They measure no cloud latency.

Run `node --test scripts/factory-capture.check.mjs` for disposable reports and real
HTTP capture requests, including mapped routing, skip reasons, preserved original
wording, independent outcomes, collisions, concurrent/replayed submissions, partial
publication recovery, provider/output failures, local guards and zero work launches.
The aggregate factory suite includes these checks.

Run `node scripts/factory-capture-browser.mjs` for actual rendered keyboard/cancel,
polling and draft preservation, provider-error retry, filtered/scrolled list and
one/multiple toast navigation at desktop and narrow widths. It uses the installed
Playwright CLI and a deterministic assessor against a uniquely disposable queue.
The printed evidence directory retains `commands.json`, assertions and
`output/playwright/` logs/screenshots. Protocol fixtures establish no model access.
Run `node scripts/factory-capture-provider.mjs` separately to check the real
configured provider with synthetic single-bug/numbered-step and distinct-feature
requests. It retains generated reports/results in the printed temporary directory,
uses the existing login/model and fails closed for unsupported configuration.
Neither command targets the authoritative queue or starts factory work. Required
full verification and saved-start step/staged checkpoints still apply.

## Execution preflight and recovery

An explicitly started Flow **Verify** block prepares dependencies in the saved
issue worktree. It reuses an installation that matches the pnpm lockfile and
declared workspaces. If dependencies are missing or stale, it runs
`pnpm install --frozen-lockfile`, then checks the installation again before
running verification. The block records the install output and stops if setup
fails.

Before any verification command runs, the exporter checks the installed pnpm lock
against the exported lock and requires dependencies for each declared workspace.
It resolves the immutable comparison commit and exported tree in the clone. Full
verification also opens and closes an actual localhost listener before running the
suite, so a sandbox refusal is an immediate environment failure with no claimed
checks. Audit-only checkpoints do not require networking. Preflight never grants
permissions or installs dependencies automatically.

For model-run checks, a `listen EPERM` or `listen EACCES` refusal requires a native
permission request for that exact command. Work retains the same conversation and
checkout when the model reports unfinished work, including uncollected proof.
It allows up to three continuation turns, separately from the three check-repair
attempts. A concrete human input requirement, denied or unavailable permission,
or unavailable external dependency stops the run with its reason. Factory never
grants permission itself. `node --test scripts/flow-executor.check.mjs` checks
continuation, its limit, and actual blocker handling.

Fallow already skips hidden agent tooling. `.fallowrc.json` explicitly excludes
`.agents/**` so this intentional scope does not emit `skipped-source-dotdir`.
Application code remains checked, including new unused exports; the real CLI
regression is in `scripts/fallow-css-reset.check.mjs`.

Summaries retain execution phase timestamps and owned command PIDs. Cancellation
stops the runner's own child process group, retains a failed summary and starts no
remaining checks. Concurrent checks for the same checkout and candidate share the
running independent check; conflicting candidates wait instead of starting an
obsolete second run. Existing independent proof reuse still validates exact inputs
and retained file hashes, including dependency lock identities. Cache diagnostics
record a key and hit/miss reason without environment contents.

Planning and review retain hashed input descriptions. A changed-input failure
identifies the changed source, report, action or policy file and assigns recovery
to the coordinator. Approved lifecycle Progress gets one recovery per unchanged
work basis through the existing scope and approval guards. It preserves previous
results; it does not authorize broader work, waive verification or infer missing
human decisions. A superseded failure cannot override later passing verification
for the same assignment or a checked, assembled contribution. Codex transport
receipts record request/reply/wait/finish timing without prompts or credentials;
uncertain creation still requires discovery of the original chat.

## Browser behavior on the combined candidate

Full verification runs `test:browser` near the start, before the factory/type/unit/build
checks. It serves the exported candidate’s actual UI assets with disposable data,
using the pinned Playwright CLI and Chromium, then closes its owned browser session
and listener. Install its browser with `pnpm exec playwright-cli install-browser chromium`
(`--with-deps` in Linux CI). Missing tooling or failed interactions fail verification.
No production issue writes, provider calls, publication or acceptance occur.

Keep repeatable UI scenarios as `scripts/factory-browser-*.mjs`, exporting an async
function that exercises the page and returns passing assertions. Implement adds
the issue’s interactions; Verify executes them again on the combined source. The
legacy sorting pilot’s existing `scripts/factory-queue.check.mjs` registers its
retained browser replay in `scripts/browser-scenarios/queue-sorting.mjs`; missing
sort controls fail that replay rather than skipping it. This migrates its original
14 browser assertions without repeating implementation.

Raw logs, replay sources and screenshots live beside each verification summary,
with content hashes. Required browser proof is part of the exact-tree verification
summary and delivery evidence, including cached evidence validation. Source/tree,
dependency or runner changes invalidate the existing candidate check key; altered
artifacts cannot be reused. Older summaries without browser checks no longer
establish current delivery readiness. An unchanged candidate may reuse intact
exact-input proof; merging changed code requires new interactions. Human usability
judgment and actual provider/hardware evidence remain separate.

## Combined Clarify checks

`node --test scripts/factory-clarify.check.mjs` exercises old state aliases,
preserved active investigations and custom stages, diagnostic authority before
approval, pending answers across commits, retained plan approvals and explicit,
idempotent capture grilling. These are disposable protocol tests, not evidence
of live model availability. Full factory verification includes them.
`factory-browser-clarify.mjs` exercises the candidate's rendered capture switch,
its off default, retained retry choice and navigation to the saved issue through
the standard browser verifier with a disposable API response.

## Verification ownership and output

Implementation workers run focused checks and the saved-base step checkpoint.
The factory server owns the aggregate candidate verification; workers do not
also run the full suite unless their assignment is verification-only. Optional
Fallow enforcement follows project configuration, including in worker prompts.

An unchanged failed candidate retains its failure and immutable command evidence.
Automatic continuation reports that failure without rerunning the suite. Explicit
Retry verification can start another attempt; source, base, dependency, runtime or
environment changes also invalidate retained attempts. Failure reuse never grants
passing proof or bypasses verified-delivery gates. Draft handoff discloses failures.

The aggregate console shows check starts, heartbeats, results and a bounded list
of failure lines. Full stdout/stderr remains in per-command logs. The outer
verification log updates while commands run, and factory activity receives the
same concise progress. Protocol fixtures inject both legacy and coordinator
connections and reject accidental access to the installed model provider.

GitHub Actions receives verification stdout/stderr as each child emits it. A
`RUNNING` line is a process heartbeat, not a completed test. The final failure
summary and retained evidence logs remain available after the command exits.
An already-running GitHub job keeps the verifier from its checked-out revision;
new streaming behavior requires a run containing the updated verifier.

`node scripts/capture-grilling-browser.mjs` opens the actual Create issue dialog in
a disposable browser fixture and checks skill selection in the submitted request,
failed-save retry and retained draft. It saves a screenshot and request JSON under
`.issues/evidence/`. Provider execution is covered separately from this UI fixture.

The aggregate verifier runs both browser runners in its disposable checkout.
`verify-browser-evidence.mjs` lists the screenshot, result, log, and measurement
outputs to copy into `.issues/evidence/`. It reads direct files in the Classic
and Flow output directories and records their SHA-256 hashes in the verification
summary. Fixture repositories and browser runner internals stay in the disposable
checkout. Standalone Flow runs can still set `TIMEY_FLOW_BROWSER_OUTPUT`.
HTTP error records include the response body and originating request. Unexpected
browser errors fail verification.

Work All Night fixtures create the folders they assign, so execution reaches the
injected worker through the same settings validation as a real issue. Start/stop
checks have a 30-second test deadline and retain per-issue failure explanations.
The dependency-failure scenario also checks that an independent issue adopts its
clarified route and reaches the Merge confirmation within the owning run.
Shared-chat DOM fixtures load the production template. Browser discussion
scenarios close the preceding provider before installing their own fixture.
Pending publication joins all preceding unfinished lanes even when the standard
flow has no suggested Verify block. New blocks default to insertion before
publication; existing attempted publication dependencies remain unchanged.

Queue and settings snapshots must not create tracked Inbox or project settings
files. Startup and explicit setup own initialization. The source-cleanliness
regression in `factory-ui.check.mjs` checks repeated snapshots and a stable review
basis. Deployment and restart fixtures include the installed `factory/system`
assets alongside scripts, matching the real runtime’s schema dependencies.
Browser fixture helpers identify the block created by an add action by its ID;
they do not assume additions occupy the last position in a flow.

Flow-card reveal checks wait for the whole card to be visible in the current
scroll viewport. Card bounds and viewport bounds are measured together; partial
scroll movement alone does not mean the reveal has finished. Failures retain
relative card bounds and viewport height in the polling diagnostic.
`node scripts/flow-browser.mjs --ci-part=2 --capture-folder-issue --save-request-route --block-reveal`
also checks that clicking the selected card reveals it without adding a history entry.
The `--project-navigation` scenario preloads Chromium history so it checks the
recorded destinations even when the browser evicts older entries.

`node scripts/flow-browser.mjs --error-recovery` triggers a rejected branch update
and verifies that a successful explicit Refresh clears its old error banner.
Run it with `--manual-close --error-recovery` to exercise refresh after the
manual-close scenario has initialized the Issue Store. Set
`TIMEY_FLOW_BROWSER_OUTPUT` to a new directory under a symlink to also check
that fixture writes use the canonical project path.
Background polling retains action errors. The running-Work browser scenario also
checks that both Update Branch entry points are disabled while a block is active;
opening the worktree remains available.

`node --test --test-name-pattern='Update Branch stops conflict retries when dependency preflight' scripts/flow-executor.check.mjs`
checks that a resolved merge stops after one worker turn and one commit-hook failure
when installed dependencies are stale or their installed lock is missing. The
failure retains the install command and staged merge. These fixtures use a failing
Git hook and an injected conflict worker; they install no dependencies.

Update Branch automatically makes up to three conflict-resolution attempts in the
same conversation. Each attempt receives the previous failure, retains separate
evidence, and preserves the target, HEAD, and unrelated staged files. An explicit
`flow-result` blocker of `human-input` or a permission denial stops the loop early.
Only a fully staged resolution is committed. Failed attempts retain the merge.
Unresolved conflicts turn Fix Branch red after the operation stops, including
when an older repair record is stale or passed. The dialog offers Retry Update
Branch after automatic recovery has failed; it reuses the guarded update path.
`flow-executor.check.mjs` checks recovery on a later attempt, exhaustion, and human
input. `--branch-repair` checks the red fallback and retry through the real UI.

Merge budgets repair attempts per distinct blocker within an explicit run. Each
blocker receives up to the configured `repairAttempts`; a new failure does not
inherit an unrelated check's exhausted budget. Repeated failing source trees and
unchanged repair candidates stop without another worker turn. GitHub failures
retain the exact failed run's uploaded verification summaries and command logs in
the issue checkout. Missing artifacts fall back to failed job output. Run metadata
must match the candidate commit before evidence is used. The repair worker gets
those local files, then Factory verifies, pushes, and waits for fresh checks.
`flow-executor.check.mjs` drives this sequence through CI-only failure, changed
candidates, multiple blockers, repeated failures, and cycles.

`node scripts/flow-browser.mjs --project-issues` selects disposable closed issues
in the real Issues iframe, verifies that the editor and resize handle are absent,
archives only the checked reports, and opens an issue in the normal Flow view.
It also checks that open selections retain the bulk editor. All archive fixtures
are isolated; the user's production closed reports are never moved by this test.

The project Issues browser check switches through the visible Open and Closed
buttons in both directions, verifies that switching clears selection and the
editor, and archives a closed selection with Archive selected. It also verifies that
the disabled direction caret is hidden for fixed status ordering and reappears
for an order whose direction can change.

`node scripts/flow-browser.mjs --issue-status-folders` checks the rendered In progress
and Blocked sidebar collections with disposable reports in multiple folders. Saved
attempts and an injected active registry entry cover running, blocked, human input,
approval, interrupted and stopped states. It checks live polling after status
changes and explicit Pause, collection order, foreign-project exclusion, unchanged
report bytes and folder assignments. It saves `issue-status-folders-proof.json` and
`issue-status-folders.png` in the reported evidence directory. It starts no model.

`node scripts/flow-browser.mjs --local-notes` checks that collapsed and expanded
Notes each retain their state after refresh and saves `local-notes-disclosure.json`.
`node scripts/flow-browser.mjs --project-issues` checks the Archive selected dialog
with a successful batch and a batch with an active issue operation that blocks one archive.
It saves the title and count changes, final results, and screenshot paths in
`closed-issues-archive-progress.json`.
`node scripts/flow-browser.mjs --issue-status-folders` compares the rendered Blocked
and In progress carets with a regular sidebar folder in both states. It saves
`issue-status-carets.json` and screenshots of each expanded and collapsed section.

`node scripts/flow-browser.mjs --issue-scrollbar` checks the center issue flow's
scrollbar. It verifies that wheel scrolling moves the flow and shows its thumb,
then the thumb hides after scrolling stops. The flow width and scroll position
remain stable. It saves `issue-scrollbar.json` and screenshots of the idle,
scrolling and stopped states in the reported evidence directory.

`node scripts/flow-browser.mjs --server-heap` checks the Flow and Classic header
readings against the running Factory process. It records the header write for each
response, including two consecutive fixture responses that round to the same label.
A comparison failure includes the response bytes and the rendered label. The check
covers refresh and recovery without navigation and saves `server-heap.json` and
screenshots of the live and unavailable readings. The scenario configures the
fixture queue before opening Classic. Run `node scripts/flow-browser.mjs --ci-part=1 --manual-close --server-heap --project-navigation --sidebar-labels --local-notes`
to check the sidebar console after the intentional Close and heap errors. Each
expected failed response accounts for one matching console entry.

`node scripts/flow-browser.mjs --manual-sub-issue-removal` removes sub-issues
from both the master and child pages. It checks active membership, links,
and badges after removal and saves `manual-sub-issue-removal.json`. A long
option in the attach picker exercises whether the adjacent inspector covers
the remove button.

`node scripts/flow-browser.mjs --activity-indicators --project-discuss --automate-activity` checks
three-dot activity during streamed chat output and its removal after Stop or
failure. The issue fixture holds actual Flow execution and checks the overlay's
fixed position during wheel scrolling, mobile placement, pointer pass-through,
reduced motion, human-input waits, and completion. It also checks injected
branch-repair display states and held Automate me responses. It saves
`activity-indicator.json` and chat and issue screenshots. These fixtures start no
live model turns. `node --test scripts/interface-state.check.mjs` also checks
that streamed text preserves the same indicator node and that human-input and
terminal states remove it.

`node --test scripts/actions-menu.check.mjs scripts/factory-server-control.check.mjs`
checks two-second action-list admission, no overlapping requests, preserved feedback
and drafts, block purposes, and named triggers for operations outside blocks.
`node scripts/flow-browser.mjs --actions-menu` checks the rendered action headings,
linked issues and stable feedback height while two disposable Flow blocks run.

## Native agent integration

`pnpm run test:native-agents` checks model inheritance and the Claude Code and
Gemini CLI adapters against disposable protocol processes. The checks exercise
approval-gated file edits, denial, Stop, continuation, uncertain operations,
explicit recovery, missing installation, human questions, and guarded MCP tool
calls. These fixtures do not establish live model access or vendor sandbox
behavior. `scripts/project-discuss-provider.check.mjs` additionally checks provider
handoffs and native skill discovery without a Codex process.

`node --test --test-name-pattern='native Flow approvals' scripts/flow-executor.check.mjs`
checks a permission decision against the owning issue, block, attempt, and request.
`node scripts/flow-browser.mjs --project-settings` checks native model choices and
hiding and restoring the effort control in the actual Settings UI.
`node scripts/flow-browser.mjs --native-agents` drives the real Flow input cards,
checks **Needs your input** and **Open request**, retains a typed answer through
Refresh, and submits decisions bound to the running attempt. It uses a disposable
held executor, not a live vendor model.

`node scripts/native-agent-probe.mjs` initializes both installed vendor protocols
without sending a model prompt. Optional `--claude PATH` and `--gemini PATH` select
binaries for a disposable installation. It uses temporary configuration directories,
retains no credentials, and reports only supported protocol metadata. A passing
handshake does not prove login, billing, coding, approval pauses, or continuation
against a live model. The authenticated workflow checks remain listed in the
[native agent plan](../plans/anthropic-google-model-support.md).

## AI provider settings

`node --test scripts/provider-settings.check.mjs scripts/provider-setup.check.mjs`
checks migration, saved choices, threshold boundaries, multiple windows, scoped
quota, freshness, explicit unknown-quota permission, exhaustion, revision guards,
and metadata discovery through disposable native-protocol executables. The
executables reject unexpected methods and retain requests, establishing that
Setup discovery sends no model prompt or sign-in request. These fixtures do not
prove live vendor entitlements or browser sign-in completion.

`node --test scripts/native-agent.check.mjs` checks actual child-process
interruption when a model is disabled and refusal of a later prompt. The focused
`node --test --test-name-pattern='provider disable lets' scripts/flow.check.mjs`
checks a publication already underway: it retains its outcome, receives no abort,
and starts no later merge after provider disablement.

`node scripts/flow-browser.mjs --ai-providers` checks the real Settings form,
explicit Save, unsaved edits, unchecked discovery, filtered model dropdowns,
warning banner, and desktop/mobile layout. Its allowance observations are
fixtures; it launches no live model or vendor login.

Provider setup checks also cover missing Claude/Gemini executables, an installed
CLI that fails to start, npm prerequisites, recipe-only explicit installation,
terminal launch failure, and native executables in a user install directory.
The install launcher is injected: these checks install no software and open no
real sign-in or terminal. The provider browser scenario holds Setup responses,
checks scroll position before and after them, reads copied install commands from
the real clipboard, and verifies that only a clicked Install sends that action.
Both Anthropic and Google are exercised. Saving and ordinary Settings navigation
retain their existing checks.

`node scripts/flow-browser.mjs --investigation-toolbar` checks the investigation
controls above the graph and their removal for an ordinary flow. It uses a saved
fixture flow, starts no investigation, and does not archive an issue.
The geometry assertion also runs in the full investigation browser scenario;
that broader scenario currently stops earlier at an investigation-creation HTTP
400 and therefore does not establish coverage of the remaining workflow.

## Block models and blocking errors

`node --test scripts/block-model-errors.check.mjs scripts/flow-executor.check.mjs`
checks frozen defaults, idle block overrides, retained attempt settings and
results, live availability, admission rejection before an attempt, retained
errors after controller recreation, and successful resolution without erasing
history. It checks running and uncertain ownership guards, explicit provider
handoff and fresh conversation startup, fixed helper models, and command blocks.
Fixtures inject provider execution and make no live model turn.

`node scripts/flow-browser.mjs --block-models` saves a model through Details,
checks that earlier results remain valid, disables the saved model, and observes
its inline error. A rejected Run displays a persistent blocker banner across block
selection and reload. Saving an available replacement starts no work; explicit
Run resolves the blocker. The scenario saves unavailable and recovered
screenshots. Provider observations and execution results are disposable fixtures;
this does not establish live model entitlements or output quality.

The PR repair-first step records V8 coverage under `.issues/repair-first-coverage`.
The early suite's Fallow audit consumes that coverage when the directory exists.
The parallel test suites run without the early job's coverage settings.
With no changed repair plan, the focused step skips.
`node --test scripts/store-git-transaction.check.mjs` checks atomic Git metadata
publication, rollback, competing writes, replay, lost push responses, pinned
reads and detached callbacks. The manual operation tests in
`project-stores-flow.check.mjs` check failed admission and checkpoint ordering.
`RUNS=5 node scripts/branch-update-benchmark.mjs --compare --assert` compares the
original and current owned branch-update paths against disposable Git stores,
verifies completed work and released ownership, and counts metadata lookups and
pushes. It also measures plain fetch-and-merge. See the
[performance evidence](../plans/update-branch-performance.md) for scope and limits.

`node --test scripts/store-git-github.check.mjs` checks the GitHub metadata request
schema, exact object identities, conditional ref update, permissions and rejected
responses. The store-record tests verify that fresh writes avoid downloading their
just-uploaded payloads, while replay and later reads still validate storage.
They also check scoped payload reuse, independent values, failure retries and
expiry for detached callbacks. Git transaction checks cover disjoint peer updates
without callback replay and rejection of changed input or command prefixes.

`node --test scripts/store-snapshot-files.check.mjs` verifies legacy display-cache
conversion, scoped issue/claim/command preservation, fresh-process reads, immutable
objects, fragment corruption, failed-index rollback, deletion and authoritative
cache repair with local drafts. `scripts/snapshot-refresh-benchmark.mjs` compares
selected cache publication against a fixed Git revision in disposable directories;
it checks selected and unrelated issue values and never changes shared records.

`node --test --test-name-pattern="publication waits only" scripts/flow-delivery.check.mjs`
reproduces a successful push followed by a stale GitHub PR head. Publish briefly
waits only for that exact previous head, while another head, a changed title and
a persistently stale response remain blocking. Retries never repeat the push.

`node scripts/factory-browser.mjs --scenario=factory-browser-capture-start.mjs`
runs the capture-profile scenario on its own. PR repair accepts named Factory
browser scenarios and rejects aggregate runs, duplicate selections, and path
traversal. The ordinary and drag-only suites retain their existing selection rules.

Closure recovery checks the merged PR comparison base from GitHub, its ancestry,
and both the CI report and local step audit for that base and exact candidate
tree. It retains the original workspace base. The proof suite covers target
updates, changed PR identity and invalid comparison bases.

`node --test scripts/flow-startup.check.mjs` checks that the first issue snapshot
loads without waiting for the live-update stream to open, including background
tabs. Later stream notifications still refresh the displayed issues. These checks
hold the browser event source unopened and execute the real startup scheduler.

### Interrupted flow recovery and pending CI

Run the focused repair plan in `.github/pr-repair-tests.json` before full delivery
checks. `flow-executor.check.mjs` covers pending checks without repeated source
fetching, including the interval before GitHub registers required checks.
`issue-ownership-ui.check.mjs` holds claim lookup open to verify that recovery
controls remain hidden until their owner is known.

`project-stores-flow.check.mjs` verifies that publication conflicts retain uncertain
results without rejecting background work. `store-recovery.check.mjs` checks
confirmed receipt reconciliation and explicit interrupted-save cancellation: retain
request evidence, reject changed revisions and owners, and release only the matching
publication claim. Cancellation leaves issue reports and current flows unchanged.

`node --test --test-name-pattern='invalid chat settings' scripts/factory-chat.check.mjs`
checks that rejected local chat settings leave no uncertain startup marker, then
permits a creation request after the settings are corrected. It uses the real
Codex connection startup method with a disposable transport and starts no model.

`node --test scripts/factory-issue-create.check.mjs` creates an idle issue through
the external-chat command against a disposable server, replaces the service,
replays the request, and reads back the saved scope and unstarted route. It checks
project identity, preview refusal, strict request fields, and changed-request
rejection without starting a provider turn.
