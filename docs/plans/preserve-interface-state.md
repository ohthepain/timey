# Preserve interface state across refreshes

The user confirmed this plan and authorized implementation in this chat.

## Reported behavior

Routine refreshes collapse expanded conversation tool activity. The Your words
editor in the Request block also returns to its original size during editing.
The reported scope is the whole app.

In chats and issue views, refreshes also clear text selection. The user cannot
reliably highlight an error message long enough to copy it.

## Agreed behavior

The user confirmed that expansion choices and editor size must survive automatic
refreshes, manual browser reloads, and navigation away and back within the same
browser tab. A new tab or browser session may use the defaults.

The user confirmed that new output, changed counts, completion, and edits within
the same request preserve expansion. Only genuinely new activity or a different
request may reset the corresponding state.

The scope includes unsaved text, cursor position, scroll position, and expanded
sections throughout the app. Automatic updates preserve the current reading and
editing state. Reloading or returning within the same tab restores drafts,
editor sizes, expansion choices, and reading position.

Automatic updates must preserve highlighted text in chats and issue views,
including error messages. They must also allow a person to finish dragging a
selection and copy it while background updates continue. Text selection and
focus restoration after a full browser reload are outside this requirement.

State belongs to its original project, conversation, issue, request, or activity.
It must not transfer to a different item. If selected text is actually removed
or replaced, the old selection need not survive.

## Required demonstrations

- Expand Tool activity, allow several polls and new events, and confirm it stays
  open. Collapse it explicitly and confirm it stays closed.
- Resize Your words and edit its text while the issue updates. Confirm that the
  dimensions, draft, caret, and editor scroll remain stable.
- Highlight chat text and an issue error message across live updates. Confirm
  that selection remains and copying yields the highlighted text. Include a
  selection drag that spans an issue update.
- Navigate away and back, then reload in the same tab. Confirm restoration of
  drafts, sizes, expansion choices, and reading position for the original item.
- Open a different item and confirm it does not inherit another item's state.

## Inspection evidence

The codebase map already describes preservation of expansion, drafts, and scroll
state around live refreshes. See [the browser state boundary](../agents/codebase.md).

In `scripts/factory-ui/project-discuss-ui.js`, the Tool activity renderer emits
closed details elements. The render comparison includes the live DOM's open
attribute, so expanding activity makes the next comparison trigger replacement
with collapsed markup, even without new server data.

In `scripts/factory-ui/flow-ui.js`, inspector replacement captures several kinds
of editing state but omits the textarea's resized dimensions.

The original regression command, `node --test scripts/interface-state.check.mjs`,
failed because an opened Tool activity became closed after one refresh.

## Implementation

`scripts/factory-ui/view-state.js` owns shared view preservation. Routine renders
reconcile nodes by stable item identity and leave unchanged text nodes intact.
Selections retain their original endpoints and selected text. A replacement can
restore a selection only when the same text exists at the matching endpoints.
Pointer gestures defer replacement of the affected region until the gesture ends.

Session storage retains expansion, textarea dimensions, and scroll positions by
view identity. Draft owners retain unsaved text separately and clear it after
successful submission. Flow also retains the inspected block and tab. Existing
longer-lived preferences and Discuss drafts keep their previous storage policy.

Flow, Discuss, issue chat, investigation results, Automate me messages, and branch
repair output use the shared preservation boundary. Classic keeps its full redraw
and event binding lifecycle, with selection and view restoration around replacement.

The browser scenario is `node scripts/flow-browser.mjs --interface-state`.
It uses disposable issues and conversations, checks that an idle issue issues no view requests across the old polling intervals,
preserves a real mouse selection across atomic report changes, and reads the clipboard after Copy. Other checks cover growth of tool
output, explicit collapse, reload, navigation, and isolation between requests and tabs.

## Verification

The original Discuss reproduction passes after the change. The broader UI, chat,
and project suite passed 324 tests before the final audit refactor. The final
candidate passed 46 focused render, refresh, chat, and source-boundary checks.

Final browser verification passed all 21 Classic scenarios and nine affected Flow
scenarios, including the original interactions, clipboard copying, investigations,
branch repair, folder settings, and independent request state. Evidence is retained
locally in [Classic browser results](../../.issues/evidence/browser-60503905-251d-40e5-abff-dc46f5a3b1ad/results.json)
and [Flow browser results](../../.issues/evidence/flow-browser-b5a8dcf8-b525-49b9-9006-56b62d6adb4c/results.json).

The enforced step audit passed against starting commit
`3bf7715836bd1ca3276e76a56b22ad0dddb9c984`, with warnings treated as errors.
Its [local summary](../../.issues/evidence/2026-11-21T08-50-10.569Z-50f37b4c-64b9-44b4-8888-b0293305ec58-summary.json)
retains the exact command, source scope, and raw output. The initial audit's new
complexity findings were repaired. An inherited unresolved Markdown script URL
was replaced with the explicit installed dependency path and its allowlisted HTTP
route. No audit thresholds or exclusions changed. Formatting and whitespace checks
passed for the changed files.

Human usability acceptance remains outstanding. The running app was not restarted
or deployed by this work. A server restart and browser reload load the new assets
and Markdown route.
