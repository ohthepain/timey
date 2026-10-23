# Timey architecture assessment

Assessment-only checkpoint (historical): proposals for review; no recommendation had yet been adopted or implemented.
Retained by the coordinator after inspecting the completed worker assessment.

Source HEAD and assessment base: `28b5afcb3f7e00826317fc95a105de6e39b3135b`.
Action: `8e1b2c69-1739-4583-ad7c-afbe63d9e9e9`; kind investigate; merge none.
Issue snapshot: `20261022T205814928-1fdb`. Integration branch dev; no integration performed.

Visual report: `../../.issues/evidence/factory-results-20261023/architecture/architecture-review-20261023-8e1b2c69.html`.
Assessment date: 2026-10-23 (America/Vancouver).

## Ranked recommendations

### 1. Concentrate practice transport ownership — Strong

- src/components/Transport.tsx:11–117 — handlers, local flags, disconnected stateChange listener
- src/lib/TempoService.ts:64–109, 250–293 — clocks and transitions
- src/lib/MidiService.ts:243–294 — external clock and slave transport
- src/lib/EventRecorderService.ts:263–280 — replay

**Friction:** The transport interface requires callers to coordinate writable flags, recorder resets, timers and UI state; replay also borrows the testing clock.

**Direction:** Deepen the existing transport module so UI, MIDI and replay cross one seam for transitions, while clock scheduling stays inside the implementation. Start with state ownership; treat clock-source policy as a separately reviewed extension.

**Evidence:** Transport.handleRecordButton calls BeatRecorder.start, writes isRecording, then calls record; handleReplay writes isRecording before a file is chosen. The stateChange subscription is commented out. MIDI start/stop/continue bypass those UI flags. Replay resets shared clock state and enables isSimulatedTimerForTesting without a corresponding restore in replay.

**Deletion test:** Deleting only the proposed forwarding module would move complexity unchanged: reject that design. Removing duplicated flags and transition ordering from callers must concentrate that knowledge inside the existing transport module. Keep TempoService: deleting its timing implementation would spread real complexity.

**Dependencies/adapters:** Local/simulated/external clocks already vary, but are not interchangeable adapters today. Justify a clock seam with browser-time and deterministic adapters only if clock ownership is selected; do not add a universal event bus.

**Benefits:** Locality: one transition owner; Leverage: UI and MIDI agree; Tests cross the same interface

**Tradeoff/risk:** High timing sensitivity. Preserve slave-mode record behavior, continue/song-position ordering and MIDI output semantics. Report source hazards rather than asserting a reproduced UI defect.

**Tests/validation:** Affected: BeatRecorder.test.ts and BeatTestUtil.test.ts. Add transport-interface scenarios for play→record→stop, external start/stop/continue, replay cancellation and replay→live, checking UI state and timer ownership. Use deterministic time, then browser controls and a named physical MIDI device for timing.

**Remaining decision:** Choose state-only scope first; settle replay exit and external-clock loss behavior before including clock-source changes.

### 2. Give MIDI input subscriptions one owner — Strong

- src/lib/MidiService.ts:83–131 — initListeners
- src/lib/MidiService.ts:185–240 — listenToInput
- src/state/MidiSettingsStore.ts — input device/channel changes
- src/test/setup.ts:1–12 — MIDI mock

**Friction:** The MIDI module hides listener installation but leaks its lifetime: replacing midiInputDevice loses the old device reference before cleanup, and store/global subscriptions have no retained disposer.

**Direction:** Deepen the existing MIDI module around selecting and releasing the active input; keep exact device/channel listeners and their cleanup inside its implementation. Repeated initialization and disposal belong to the same seam.

**Evidence:** listenToInput assigns getInputById before removeListener, so cleanup targets the newly selected input. noteon uses an anonymous callback and removeListener by event name. initListeners discards the settings unsubscribe and installs anonymous connected/disconnected callbacks. listenersInitialized is set only during a later input-change subscription.

**Deletion test:** Deleting useMidiService pass-through functions alone only moves calls; no meaningful depth gain. Deleting the proposed input-ownership module should force registration, old-device cleanup and lifetime rules back into callers: that concentration is the test.

**Dependencies/adapters:** WebMidi input objects are the production adapter; a fake device/channel emitter is the test adapter. Keep that seam internal where possible, with no generic device framework.

**Benefits:** Locality: cleanup beside registration; Leverage: selection owns lifetime; Tests observe delivered notes

**Tradeoff/risk:** Medium. Removing all listeners by event name may affect other owners; preserve exact callback ownership. Empty selections, missing devices and reconnect policy need explicit expected behavior.

**Tests/validation:** Existing recorder tests mock the entire MIDI module and cannot cover subscription changes. Add device A→B, channel changes, clear selection, unplug/replug, repeated initialization and disposal tests through the MIDI interface; assert one active note/clock delivery and no old-device delivery. Follow with browser/device switching.

**Remaining decision:** Agree whether unplug waits for reconnect or clears selection, and whether all-channel input is supported; keep transport policy out of this change.

### 3. Deepen note attribution and feedback capture — Worth exploring

- src/lib/BeatRecorder.ts:134–210, 212–337 — misses, index advancement, note capture
- src/lib/PerformanceFeedback.ts:41–105 — matchNoteToBeat / addBeatNote
- src/components/BeatViewer.tsx:117–146 — feedback grading + subscription
- src/lib/BeatTestUtil.ts:35–114 — feedback assertions

**Friction:** Understanding one performed note requires tracking current index, quantization, missed/extra outcomes, mutable feedback and logging across modules; tests seed their shared state directly.

**Direction:** Concentrate attribution and feedback accumulation in one deep in-process module, with timing/note input and observable outcomes crossing its seam. Keep transport, persistence and the visual grading policy outside the first scope.

**Evidence:** BeatRecorder owns currentNoteIndex and missed-note accumulation while PerformanceFeedback.addBeatNote reads singleton tempo and writes the event recorder. makeBeatNote creates an index before later advancement (explicit TODO). BeatViewer reads the singleton feedback array to compute its last-eight grade. This is coupling evidence, not proof of an attribution bug.

**Deletion test:** Do not delete PerformanceFeedback as a data name merely to shorten navigation. Its matching behavior earns depth only if the module absorbs attribution and accumulation; a new facade that leaves caller-owned arrays/index sequencing intact fails the deletion test.

**Dependencies/adapters:** Core attribution is in-process: no adapter needed. Live MIDI and recorded replay can feed the same capture seam, with deterministic fixtures; logging belongs outside the calculation. Do not introduce an adapter for a pure calculation.

**Benefits:** Locality: attribution with accumulation; Leverage: live and replay outcomes; Tests avoid singleton state surgery

**Tradeoff/risk:** High semantic risk, lower confidence than transport/listener ownership. Timing tolerance, loop wrap, simultaneous drums and repeated-note advancement must stay unchanged unless separately selected. Coordinate with transport work because both touch BeatRecorder.

**Tests/validation:** Affected: BeatRecorder.test.ts perfect/missed/extra/auto-advance/replay cases, BeatTestUtil.test.ts and checkBeatNoteFeedback. Preserve behavioral coverage while replacing direct state mutation with tests at the chosen interface. Add loop-edge, repeated note, simultaneous drum, wrong note and timing/velocity outcome fixtures; compare live versus replay outcomes.

**Remaining decision:** Select attribution scope only after characterizing existing matching semantics. Decide whether grade calculation is a later presentation-only change; no grading redesign is proposed.

## Decisions and source constraints

No candidate adopted, declined or implemented. No final interface specified. Top choice is transport state ownership; smaller alternative is MIDI subscription ownership. Capture and transport overlap in BeatRecorder: avoid concurrent uncoordinated edits. No speculative generic framework proposed.

No conflict with ADR-0001. Its human-input implementation is separate work. Preserve the pending auth/persistence plan: direct typed queries and staged migration remain untouched. The checked getServerPrisma/safeQuery/withAuth repairs are already integrated and were not proposed again. Recorder CSV isolation candidate 86394522d859f038f4aea5425a2941497cae556d remains a separate action; this assessment did not inspect or adopt it. Recheck any tests touched by its later integration.

## Investigation evidence

- Confirmed HEAD exactly equals saved source; initial worktree clean. Read guides, glossary, map, sole ADR and current progress section.
- Walked 45 repository commits and 65 application commits; inspected timing/MIDI/capture/replay/UI code and existing test setup. One internal subagent independently assessed capture/feedback; no user-owned chats launched.
- Relevant application hotspot commits: 0853fb8, 35f4a31, 89ebed0, f9c66f5, e40adce, 7c96330. Newer compiler repair 38229f1 was considered complete source work.
- Existing tests examined, not executed: BeatRecorder.test.ts (7 active cases) and BeatTestUtil.test.ts (3 active cases); setup replaces MIDI module, so this is not subscription/hardware coverage.
- No product test/build/typecheck/Fallow execution: no implementation performed. Full future implementation requires relevant tests, complete factory checks where applicable, typecheck/build, and strict audit:step/verify against that implementation’s actual starting commit. The known aggregate factory-interface coverage omission is a separate dispatched action.
- No DB/browser app/MIDI timing behavior verified. Source hazards are not reproduced defects.

## Retention and next obligations

The coordinator retained this assessment here and its HTML, original handoff and
rendering evidence under `.issues/evidence/factory-results-20261023/architecture/`.
These remain proposals, not adopted architecture or reproduced bugs. HTML structure
passed; browser preview was blocked by security policy. Visual layout and CDN
loading remain unverified; no alternate preview route was attempted.

Select a candidate or defer. Settle its listed scope/behavior decisions before
implementation. Keep transport and capture edits coordinated because they touch
BeatRecorder. No human answer, implementation approval, device evidence or issue
acceptance is implied by retaining this report. The issue report remains at its
saved state; the parked report-reconciliation task is separate.

## Subsequent user decisions and implementation

The user selected recommendation 1 (transport state ownership), confirmed shared
state and safe replay cleanup, then explicitly authorized the dependency/audit
repair required by strict verification. Recommendation 2 (MIDI subscription
ownership) is deferred because the selected work concerns transport state.
Recommendation 3 (broader note attribution/grading) is deferred apart from the
explicit dependency cleanup overlap; matching/scoring policy is preserved.

The [transport implementation and evidence](transport-state-ownership.md) records
the bounded scope, source changes, passing checks and remaining runtime limits.
The user subsequently authorized committing, merging into dev, and closing the
architecture issue. Closure records that decision; it does not claim physical
MIDI or authenticated/database-backed practice was verified. No new prototype
was needed for this behavior-preserving ownership change.
