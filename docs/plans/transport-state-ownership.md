# Transport state ownership

## Selected scope

Starting revision: `28b5afcb3f7e00826317fc95a105de6e39b3135b`.
Architecture issue snapshot: `20261022T205814928-1fdb`.

The user selected transport state ownership and confirmed this bounded change:
Play, Record, Stop, external MIDI controls and Replay share one authoritative
playback/recording state. Controls reflect that state. Cancelling file selection
leaves practice unchanged; completed or failed replay leaves transport stopped
and ready for normal practice. Timing and note scoring remain unchanged.

This follows the assessment in factory action
`8e1b2c69-1739-4583-ad7c-afbe63d9e9e9`; implementation was separately authorized
in this chat after the assessment ended. The original action remains
investigate/none. No queue, registry, integration, acceptance or migration work
is authorized by this implementation.

## Design

Deepen the existing TempoService module rather than adding a forwarding module.
It owns read-only transport snapshots, subscriptions and transitions. Existing
stateChange events remain available to capture, playback and metronome callers.
The controls read the same snapshot and invoke the same play/record/stop methods
as MIDI. Recorder reset occurs through its existing stateChange listener, once
per recording start.

Replay's clock-mode setup and cleanup belong to TempoService, with event
iteration in EventRecorderService. Both success and failure stop the transport
and restore its previous clock mode. File selection and reading happen before
entering replay. There is no new clock adapter or change to pulse math, external
clock-loss policy, song-position ordering, scoring or MIDI listener lifetime.
Continue preserves the existing clock-only running state if no play/record mode
is active; the controls must still provide Stop in that state.

The interface is the test surface: use the real transport transitions and
recorder interaction, deterministic time and observable control state. Replace
existing direct recording-flag writes in tests with record(). Physical MIDI
checks remain separate from mocked evidence.

## Verification and remaining obligations

The final implementation passed formatting, typechecking, 32 application tests,
production build, all 22 factory checks, and the strict Fallow audit with zero
findings in changed files. Full verification uses a disposable snapshot because
inherited recorder tests write CSV files. Exact evidence and detector limits are
recorded below. Physical MIDI and authenticated/database-backed practice remain
unverified; automated checks do not establish human acceptance.

## First implementation checkpoint — completion blocked (historical)

The user confirmed the scope above. The [retained assessment](architecture-assessment.md)
records the other recommendations as unselected. Production changes are limited
to TempoService, Transport and EventRecorderService; existing recorder tests now
call record() instead of mutating a transport flag. No scoring implementation,
external MIDI handling, clock-loss policy or pulse mathematics was changed.
The codebase map records ownership and test starting points.

### Actual evidence — 2026-10-23

- Clean offline dependency install succeeded with lifecycle scripts skipped.
  The first Prisma generation attempt hit a read-only cache timestamp; generation
  succeeded using the existing cached query/schema engine paths explicitly.
  No credentials or database connection were needed or verified.
- Initial baseline verification used the unchanged source. Types/tests failed
  because generated Prisma client files were missing; these setup failures were
  corrected before the implementation verification. Its empty-scope Fallow JSON
  omitted diagnostics, so the validator correctly failed closed. Baseline log:
  `.issues/evidence/2026-10-23T19-22-34.732Z-eb73027c-3d61-4cd4-b078-2bd8084a11b3-summary.json`.
- Focused transport/control tests: **11 passed**, using real transport/capture
  behavior with mocked MIDI and persistence. Includes snapshot/subscription
  lifetime, one capture reset, clock-only Continue, slave timer suppression,
  replay scoring parity, failure cleanup, file cancellation and delayed selection.
  Log: `/private/tmp/timey-transport-focused.log`.
- `npm run verify -- --base 28b5afcb3f7e00826317fc95a105de6e39b3135b`:
  changed-file formatting, typecheck, **30 Vitest tests**, build, and the verifier's
  factory checks passed. **Overall failed: strict Fallow did not pass.** Source
  snapshot tree: `a03c919e3dcf727f349ca2cd1d853ffb7591168d`.
  Summary: `.issues/evidence/2026-10-23T19-25-59.162Z-569b6159-3c9c-4431-a79f-71e1752cbaa0-summary.json`.
- `npm run test:factory` separately passed **22 checks**, including interface
  checks omitted by this revision's aggregate verifier. That known verifier
  omission remains a separately dispatched action. Log:
  `/private/tmp/timey-transport-factory.log`.
- Strict Fallow reports **12 findings** (seven circular dependencies and five
  reported unused members) plus **one duplication group** in changed files.
  No complexity findings. Some unused-member reports concern existing calls via
  an inferred recorder getter; they are not permission to delete used behavior.
  Architecture/policy detectors remain unconfigured and unmeasured.
- Confirmed inheritance independently: exported the saved revision to a disposable
  clone, appended only a blank line to the five existing changed source/test files
  to select their full-file audit scope, and ran the same pinned strict command.
  It failed with 17 findings, one complexity finding and the same duplication
  fingerprint. Every current finding ID was present in that baseline. This is
  evidence of inheritance, **not a waiver or passing audit**. Baseline tree:
  `a98dc1787a6b65aa410aea82fc28755f4d4fe749`. Logs/comparison:
  `/private/tmp/timey-transport-baseline-7pb0wc8a/`.
- Browser smoke: home rendered and hydrated MIDI settings opened/closed using
  the real local dev server. Console reported Keycloak initialization timeout
  and failure; authenticated/DB-backed practice was not verified. No physical
  MIDI device evidence. Dev server log: `/private/tmp/timey-transport-dev.log`;
  the temporary server was stopped afterward.

### Blocker at the first checkpoint (superseded by the repair below)

The repo's verification guide requires every finding in changed files to be
addressed before a commit or step completion, including inherited findings.
The remaining circular dependencies span TempoService, EventRecorderService,
BeatRecorder, MidiService and PerformanceFeedback. Repairing their ownership
would expand into the unselected capture/feedback recommendation; removing
reported members without checking real callers would be unsafe. Checks were
not weakened or suppressed. This implementation is **not step-complete or ready
for integration** while the strict gate fails. No commit, push, merge, issue
closure, queue mutation or acceptance was performed.

Next human decision: authorize a separately bounded dependency/audit repair, or
leave this candidate pending. Re-run the strict checkpoint against the original
starting revision after any repair; then recheck affected automated behavior and
perform real MIDI/device and final experience checks. The final step checkpoint
is repeated after this evidence record; its raw summary remains under
`.issues/evidence/`. No passing result is claimed in advance.

## Dependency and audit repair — authorized 2026-10-23

The user explicitly approved fixing the dependency and audit findings after the
first blocked checkpoint. This expands the bounded implementation to remove
clock/capture/event-data cycles and their full-file audit findings. It does not
adopt a new scoring policy, MIDI subscription redesign, auth migration or generic
event framework. The original starting revision remains the audit base.

### Resulting ownership

- TempoService publishes pulse intervals and owns transport state/clock lifecycle;
  it no longer imports recorded events. Synced start/stop/continue output shares
  one implementation, preserving its emitted event names and output ordering.
- BeatRecorder attaches timestamp/index context, logs each timing pulse before
  advancing the index, and logs feedback before publishing it. Its replay entry
  resets the selected beat inside TempoService's replay lifecycle and supplies
  timing/note callbacks to the event recorder.
- EventRecorderService owns event data/CSV iteration, with explicit event position
  and replay targets. It no longer imports TempoService, BeatRecorder or MIDI.
  Stored derived feedback remains a no-op during replay; original inputs generate
  feedback again through the same capture path.
- PerformanceFeedback receives BPM explicitly and calculates/accumulates feedback
  without clock or logging lookups. Matching tolerance and note timing formulas
  remain unchanged. The current/next-note decision in BeatRecorder is a private
  helper with the same ordering, reducing the handler's measured complexity.
- Removed genuinely unused panic/reset, deletion, debug formatting, list access
  and redundant performance/index accessors. The visible delete control still
  uses its existing server operation. Live missed/extra recording was retained;
  direct typed recorder calls make those real uses visible to the analyzer.

### Checks and remaining obligations

The first repaired strict step audit passed at
`.issues/evidence/2026-10-23T19-38-23.522Z-df05bf19-63d2-4c51-a795-ca65c3ee91df-summary.json`:
zero dead-code issues, complexity findings or duplication groups in its changed
scope. Detector configuration limits remain explicit; no exclusions, suppressions
or thresholds changed. Later final-snapshot checks are recorded below.

Focused tests passed 12 cases across transport, controls and recorded events.
The replay scenario now asserts exact CSV parity for live versus replayed inputs,
including timestamps/indexes, missed/extra events and feedback, as well as
performance timing/velocity. An independent CSV fixture verifies that only
original note/timing inputs are replayed, in order. Log:
`/private/tmp/timey-dependency-focused.log`.

The final full verification passed; see the retained evidence below. Physical
MIDI timing and authenticated/database-backed practice remain unverified; previous
browser smoke established only home hydration/settings interaction. No commits,
integration, publication, queue mutation or human acceptance are part of this action.

### Final verification and handoff

Final full command:
`npm run verify -- --base 28b5afcb3f7e00826317fc95a105de6e39b3135b`.
All checks passed: changed-file formatting, strict Fallow, the aggregate factory
checks, typechecking, **32 Vitest tests across seven files**, and production build.
The final transport test additionally checks synchronized MIDI start/continue/stop
and song-position order, plus omission of messages for outputs without sync enabled.

Summary: `.issues/evidence/2026-10-23T19-40-24.037Z-6f6dacef-7f28-488a-bda4-ce4dabbdc2bc-summary.json`.
Verified source/test snapshot tree: `f07c676ca4228c04aaec81eaa9724cb2eed06758`.
Strict audit: **zero dead-code findings, zero circular dependencies, zero complexity
findings and zero duplication groups in changed files**. Architecture-boundary and
policy detectors remain unconfigured/unmeasured, as reported by the unchanged
validator. This is not a repository-wide audit claim.

Complete factory command: `npm run test:factory`, **22 passed**, including the
four interface cases omitted by this revision's aggregate verifier. Log:
`/private/tmp/timey-dependency-factory.log`.

The final step checkpoint uses the same original starting revision and covers
this evidence-only documentation update too; its raw summary is retained under
`.issues/evidence/`. No rules, thresholds, suppressions, lockfiles or verification
scripts changed. `git diff --check` passed. HEAD remains the starting revision;
source changes are intentionally uncommitted.

Changed production files: `src/components/Transport.tsx`, `src/lib/TempoService.ts`,
`src/lib/BeatRecorder.ts`, `src/lib/EventRecorderService.ts`, `src/lib/EventList.ts`,
`src/lib/PerformanceFeedback.ts`. Tests: new Transport, TempoService and
EventRecorderService test files; adapted BeatRecorder and BeatTestUtil tests.
Documentation: codebase map, retained architecture assessment and this plan.

The dependency/audit blocker is cleared. Coordinator review and any integration
remain separate from this worker result; authoritative issue linking/lifecycle
and registry updates belong to the coordinator. Real device timing, authenticated
practice and final user judgment/acceptance remain separate obligations.

## User-authorized finalization

After reviewing the completed work and its limits, the user explicitly requested:
"you can commit and merge and close the issue". This separately authorizes the
local commit, integration into current dev, and administrative closure of
`20261022T205814928-1fdb`. The original assessment action remains investigate/none;
this later code authorization does not rewrite that action's policy or outcome.

Integrate with dev's already adopted recorder isolation and aggregate verifier
coverage fixes, preserve their behavior, and verify the combined result before
recording completion. Physical MIDI and authenticated/database evidence remain
unverified at closure; they are not fabricated as passed. No remote push is requested.
