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
