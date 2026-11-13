# Issue Progress tab

Approved in chat on 2026-11-01; implementation authorized after shared understanding.

Add four tabs: Progress (default), Issue output, Issue thread and Discussion. Preserve the selected tab while viewing the issue. Progress derives current step, explanation, milestones, next action and status from existing structured operation/question/approval records and public output events. It stores no independent workflow record.

Reuse actual question wording, answer handlers, freshness identities and drafts. Continue immediately overrides old status with request feedback until fresh progress is observed. Blocking input leads; concurrent work remains visible. New active operations outrank old failures. Quiet output alone proves neither failure nor blockage.

Statuses: running, waiting for you, blocked, failed, complete, not started and progress unavailable. Name the operation's finish line explicitly; operation completion does not imply issue acceptance or closure. Retain confirmed historical milestones, distinguish superseded checks, and never invent missing history.

Verification shows the current command and known result; fall back to Running verification where check granularity is unavailable. Issue output retains public diagnostic output and offers access to earlier retained logs without increasing normal polling payloads. Issue thread remains the work conversation; Discussion remains conversation about work.

Verify derived precedence, missing data, retries, input controls/drafts, verification results and output pagination with focused checks and rendered browser scenarios. Run the saved-base step audit. Human usability acceptance remains separate.
