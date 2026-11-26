# Block models and blocking errors

Status: implemented after the user confirmed shared understanding and authorized
implementation with “lfg”. Focused automated and browser checks pass; the broader
suite retains one independently reproduced existing folder-membership failure.

## Requested behavior

- Surface model choices in the right-hand block details where a block permits
  model selection.
- Show an error when the model required by a block is unavailable.
- Add a named error section beneath the issue name.
- Show the last error that prevented the issue from progressing in that section.

## Design review status

The user accepted questions 1–7. The behavior below is the consolidated design
and authorized implementation. The implementation is being verified against these decisions.

## Confirmed decisions

The current model name opens the selector in the block's Details panel. The
default choice uses the resolved issue model. A block can save its own model
override. An unavailable selection retains its identity and displays its
blocking reason.

Request defaults to the native Codex configuration and offers enabled,
available Codex models. Selecting a model saves it for the next Request
attempt.

The issue page shows the current blocker in a red banner. It covers errors that prevent
progress, including model availability, authentication, quota, verification and
publication failures. It identifies the affected block and gives the reason.
Ordinary UI failures, such as a failed rename, remain beside their controls.

The blocking error persists across reloads and block selection. It remains until
the failed step succeeds or is explicitly skipped or removed through permitted
controls. The original failure remains in block history. Fixing a cause requires
explicit Resume and does not restart work automatically.

An idle block's override remains editable after issue execution starts. Changes
apply to its next attempt. Running work must stop, and uncertain work must be
reconciled, before its model can change. The frozen issue settings and past
attempts retain their original values. Model choice alone starts no work or rerun.

Blocks with a constrained model, including Sol, display their actual required
model as read-only and explain the constraint. An unavailable required model is
a blocker. Blocks that use no model have no selector. A conditional repair path
must identify its model as a repair model rather than imply that ordinary command
execution uses AI.

Showing a block's Details checks and displays model availability immediately.
Browsing a block does not replace the issue's last blocking error. A rejected
Start or Resume, or a failed execution, records a durable issue-associated error,
including when admission fails before an attempt exists.

Show the most recent unresolved blocking error. Resolving that step's failures
reveals the next remaining unresolved error, if any. Hide the section when none
remain. Successful retry resolves that step's earlier blockers without deleting
their history; other blocks' unresolved errors remain.

## Implementation decisions

- Use the issue heading area for the blocker banner and the existing
  right-hand Details panel for model controls. This adds no workspace column.
- Resolve Use issue default through the frozen issue snapshot when one exists;
  otherwise use the existing issue, folder and project inheritance.
- Offer enabled, available models compatible with the block. Retain an unavailable
  saved selection with its reason instead of selecting a replacement.
- Apply availability checks to the model actually required by the block or helper,
  including a block override. Keep quota observations live despite frozen settings.
- Save ordinary block changes with **Save changes**. Request saves its model
  selection immediately. A provider change on a retained conversation follows
  the existing explicit handoff policy and preserves history.
- Identify each error's affected operation and block where applicable, preserve
  its reason and recorded time, and keep resolution separate from deleting history.
- Dismissing the global banner does not resolve the retained blocking error.
- Preserve all existing restrictions on skipping, removing, approving and resuming
  work. Model edits and error resolution do not waive required checks.

## Existing behavior and constraints

Ordinary model-driven blocks currently share the issue model. The execution
snapshot freezes issue settings after execution starts; block-specific overrides
would introduce new execution behavior. Past attempts must retain their actual
settings and results.

Sol chooses a Codex Sol model explicitly. Request clarification and Retro use
temporary Codex discussion runtimes. Command blocks may use a model for repair
without using one on their ordinary path. Required model information must reflect
the actual execution path.

Block attempt failures are durable, but route pause reasons currently live in
memory. Preflight rejection can happen before an attempt exists. The existing
Results section and dismissible global banner do not provide the requested
durable, issue-associated error behavior.

Existing provider choices, quota pauses, explicit Resume, and native conversation
ownership remain the starting constraints from the
[provider settings design](ai-provider-settings.md) and
[native-agent decision](../adr/0025-integrate-native-coding-agents.md).

## Verification

- The focused execution, model settings and view suites pass all 110 tests.
- Block model/error, progress, view and provider settings checks pass all 26 tests;
  additional focused checks cover skipped Retro, closure errors and disabled Sol.
- The browser model scenario passes with saved selection, unavailable model,
  reload, navigation, explicit retry, and retained-result assertions.
- TypeScript and repository-wide formatting checks pass in both the isolated
  implementation checkout and the working checkout. The strict Fallow audit passes against the starting revision.
- The broader Flow, closure and discussion run passes 82 of 83 tests. Its sole
  failure is `moving an existing issue folder preserves report membership by ID`
  (`Copy` versus `Releases`). Running that test in the unchanged main checkout
  reproduces the same failure before applying this implementation.
- Evidence is retained under `.issues/evidence/block-model-errors-20261123/` in
  the working checkout. These scenarios use disposable state and injected
  execution, not live paid model turns or vendor entitlement checks.
