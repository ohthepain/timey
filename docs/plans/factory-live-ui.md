# Live factory UI

Starting revision: `6ad1274f142ae25c6fbcae514006ffc33965e184` on Timey's `dev`.
Implementation branch: `codex/live-factory-ui` in an isolated shared clone.

Connect the approved queue/issue UI to actual queue reports and the existing
factory registry. Use the installed Codex CLI for bounded queue reviews, isolated
workers and separately selected integrations. Keep all transitions manual and
preserve existing issue ownership, human-input and strict verification rules.

The adapter owns the transport and UI history, not a competing issue store.
Queue reads do not start Codex. Recommendations are saved separately; one selected
launch creates one claim and checkout. Integration uses a distinct coordinator
chat, exact candidate approval where required, a project lock and independent
combined checks. Neither completion nor integration claims human acceptance.

## Validation

All six aggregate checks passed against the recorded starting revision on the
implementation snapshot: strict Fallow, changed-file formatting, 33 factory tests,
TypeScript, 19 app tests and the production build. Evidence is retained locally
under `.issues/evidence/2026-10-24T01-14-31.682Z-6eb0a248-0b09-4440-a27a-3e5dc854e011-summary.json`.
Final saved-base and exact-index checkpoints are required before committing;
the final committed tree is also checked through `checkCandidate`, the same
independent validator used for worker results and integration.

Ten new UI tests cover inert reads, stale confirmations, one-use tokens, duplicate
claims, setup failure, exact candidate approval, chat-bound permission replies,
independent verification failure, HTTP origin checks, separate review/save/launch,
explicit resumption and pending human evidence. Existing coverage remains intact.
The Fallow detector discovery glob was expanded to include nested script modules;
no rules, thresholds, warnings or findings were waived.

The installed Codex CLI 0.164.0 created one disposable read-only chat and resumed
the same chat ID successfully, with no model override or tools requested. Its
results are retained in `/tmp/timey-cli-live-smoke/evidence.json`. Browser testing
read the actual Timey queue, opened an issue and its pending judgment, checked the
review confirmation without submitting it, and exercised a worker plus separately
selected failing integration against a disposable queue and protocol fixture.
The fixture worker finished without changing lifecycle state. The failed
independent integration check retained its lock and evidence rather than recording
integration. Those protocol fixture results do not claim live model task quality.

The live UI is served against the authoritative local Timey checkout. No real
queue review, recommendation save, worker launch, integration, report edit,
acceptance or closure was performed while validating it. Existing native chats
remain owned by their original coordinator. Native desktop sidebar visibility,
real task implementation quality and a successful live model-driven code merge
remain unverified. Human answer editing remains in the coordinator chat; the UI
shows recorded obligations and enforces structural operation guards.

## Expandable issue lifecycle — follow-up

Starting revision: `fd5293a3f77e879d507a80d5e8507b515e651b11`.

The user preferred the earlier step-based issue view and asked to keep every step
visible, expandable and able to carry issue history. Replace the compact stage
rail with numbered stage cards driven by the configured lifecycle. Keep saved
assignments, worker results, recorded commits, separate manual integration and
report notes accessible within the issue. Display actual saved timestamps, not
invented stage-transition history. Preserve open steps across live updates.
No queue, CLI transport or dispatch behavior changes.

Validation: browser-check the real issue view, stage expansion/collapse, recorded
assignment history, issue notes and queue navigation; run the required strict
saved-base checkpoint, aggregate verification and exact-index commit hook.

Follow-up result: the real compiler issue displays all nine steps, including the
separate integration action. Its saved investigation expands to the original
assignment, actual saved/requested/updated timestamps, checks and recorded result.
Expansion and collapse survive queue navigation. Browser inspection confirms
future steps expose their empty state and no invented completion marks. All six
aggregate checks passed against the recorded follow-up base; evidence is
`.issues/evidence/2026-10-24T01-24-35.469Z-080535cd-c812-49bd-a7f7-6f64117b5226-summary.json`.
The real queue and CLI action behavior remain unchanged.

## Current-stage Progress action

Starting revision: `c033a15` (the expandable issue view). The user requested a
Progress button only on the current stage, executing its recommended action in
a separate chat when needed. This includes reviewing already finished work and
recording its outcome rather than launching the original assignment again.

Add issue-focused action selection and guarded one-use confirmations. Reuse the
existing worker launch and manual integration paths. Review existing results in
a read-only coordinator chat, using the installed CLI to find the original chat
by exact action identity and verify its project. Validate freshness and evidence
files before using the ledger helper and appending selected report notes. Permit
only a reviewed configured next-stage transition with fresh target-specific human
guards; never acceptance or closure. Keep pending human obligations untouched.

Validation covers stale/current-stage guards, duplicate requests, original-worker
discovery, read-only coordinator dispatch, outcome recording, unfinished workers,
ambiguous references, exact integration approval and human-blocked advances in
disposable repositories. Native CLI inspection of the existing factory verification
chat succeeded without creating/resuming any real chat or updating its records.
The real Progress action remains for the user to select after implementation.

Progress validation result: all six aggregate checks passed against `c033a15`: 42
factory tests (including 19 UI/transport/Progress tests), 19 app tests, TypeScript,
production build, formatting and strict Fallow. Evidence:
`.issues/evidence/2026-10-24T01-49-31.317Z-4d94ab5b-a562-42ec-8ac4-8b6ec5f0cacf-summary.json`.
Browser checks established one Progress button on the real current stage, none
on other stages, and the exact Review worker results confirmation (cancelled).
A disposable browser fixture completed worker launch and separate coordinator
review, preserved the original worker ID, recorded a reconciled result and
appended issue notes without accepting or closing the issue. This fixture used a
protocol stub; real CLI native-worker discovery was independently verified.
No real Progress run, worker launch, result reconciliation or report update was
performed during development. The real issue remains pending user selection.

## Clear review results and recovery

Starting revision: `c9c36c64761178903d583d37c147053210d45b5b`.

The first real result review accepted a saved verification package but proposed
no stage advance. Recording failed because legitimate probe and project source
files were rejected by a report-only evidence extension filter. The UI exposed
the model's completed response without clearly distinguishing the blocked server
operation or offering another Progress action.

Allow regular evidence files within the canonical project, original worker and
temporary directories, retaining file size and hash checks. Explicit Progress can
perform a fresh read-only result review after a blocked review, with all existing
freshness, original-worker and stage guards. Never replay retained model output
without review. Display the recording outcome, remaining work and next action
above collapsed transcript/technical details. Chat references use the installed
desktop app's own copied-link format, `codex://threads/<id>`.

Validate legitimate source evidence and explicit retry with disposable fixtures,
retain stale-review and human-guard coverage, inspect the real blocked result in
the browser without executing it, and run aggregate and saved-base step checks.

Recovery validation and browser observations are retained in
`.issues/evidence/review-recovery-validation.json`. The live issue displays the
blocked recording separately from the reviewer's completion claim, with remaining
work and an enabled fresh-review confirmation. The confirmation was inspected and
cancelled; no real review or worker was dispatched. The desktop link format was
verified in the installed app's link builder and URL handler. Automated browser
navigation to the custom scheme was blocked, so end-to-end opening still needs a
manual click. Existing real run/report/ledger history was preserved.

A further inspection found existing passing aggregate and step summaries for the
current authoritative revision and exact source tree. The worker's older starting
revision did not establish absence of these results. Result-review instructions
now explicitly require inspecting current-project summary files and raw logs
before claiming checks are missing, and separating next-stage work from remaining
limitations or final human review. The retained validation manifest names the
actual current-project evidence for the next review; it is not itself a stage
advance or a replacement for that review.
