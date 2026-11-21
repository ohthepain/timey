# Issue thread workspace

Implement the agreed [issue conversation decision](../adr/0007-codex-owns-issue-conversations.md).
Each issue has one continuing Codex chat. The **Issue thread** panel lets the
user read its history, run skills, and direct work in that same chat. A retro
or a question about what was done can follow the issue from capture through
closure.

Use the Timey repository root for implementation. Check the current branch and
diff, and preserve unrelated work. This plan covers the Issue thread experience
and its runtime. The [earlier Codex-owned execution plan](codex-owned-issue-execution.md)
has a broader scope, including model-free capture and moving orchestration out of
Factory. Those changes are outside this handoff.

## 1. Prove the shared Codex thread

- Use the saved issue-to-chat binding as the source of identity. Start with
  [issue-work-chat.mjs](../../scripts/factory-ui/issue-work-chat.mjs) and the
  [native handoff proof](codex-native-handoff-proof.md). Create the chat on
  the first explicit discussion or work request. Seed the history from the
  saved report and capture decisions, including capture before the chat existed.
- With a disposable issue, prove that Factory and native Codex can open the
  same saved chat, see each other's turns, and establish which turn is active.
  Verify which surface can steer, interrupt, and answer permission requests
  using the installed transport. If a required operation is unsupported,
  record the capability gap before enabling that control.
- Reuse an existing issue chat. For older issues with multiple chats, keep
  their history and bring a sourced summary and links into the selected issue
  conversation. Switch active work at a safe stopping point. When the active
  turn or chat binding is uncertain, show the status and hold dispatch until
  reconciliation. A retry must reuse the same binding or pending creation.

## 2. Make the conversation usable from capture through closure

- Route capture grilling, **Grill me**, and **Discuss this step** to the
  issue conversation. Preserve stage context and the existing action that
  records reviewed decisions. Route implementation and model-assisted
  lifecycle work to the same chat.
- Build on [conversation-view.mjs](../../scripts/factory-ui/conversation-view.mjs)
  and [conversation-context.mjs](../../scripts/factory-ui/conversation-context.mjs).
  Use the same lifecycle history for Issue thread, retros, and history
  queries. Include the original request, decisions, work performed, confirmed
  verification and merge outcomes, local target update status, and closure.
  Keep event identities stable across reloads. Link records to their evidence
  and retain the distinction between observed outcomes and conversation text.
- Keep deterministic checks and GitHub operations with their existing owners.
  Bring their confirmed outcomes into the conversation as labeled Factory
  events. Independent reviewers can keep their own context and return sourced
  findings. Show confirmed GitHub merge and local target update separately.
- Provide the history to skills through the normal skill mechanism. Verify a
  retro and a query such as `what-did-you-do` from the same thread. Check
  which skills are installed during implementation and use an ordinary
  history query to verify coverage if that named skill is unavailable.

## 3. Add the composer and durable queue

- Extend [issue-chat.mjs](../../scripts/factory-ui/issue-chat.mjs) and
  [issue-chat-ui.js](../../scripts/factory-ui/issue-chat-ui.js). Place **Pause**
  and **Stop** beside **Send**. Show queued prompts above the composer with
  their selected skills. Reuse skill expansion and keep its selection attached
  to the prompt through editing, dispatch, and steering.
- Persist queue entries and pause state through the existing
  [conversation store](../../scripts/factory-ui/conversation-store.mjs) or
  the owning issue records. Give each entry a stable identity. Track waiting,
  dispatch in progress, and uncertain outcomes so the user can see what
  happened after a reconnect. Keep all queue controls bound to the issue and
  prompt identities.
- Send starts a turn when the issue can dispatch. If a turn or Factory
  operation is active, or the issue is paused, Send queues the prompt.
  Waiting entries offer **Edit**, **Remove**, and **Steer**. Edits keep the
  entry's position. The first version uses FIFO order.
- Steer targets the confirmed active Codex turn, including a turn started in
  native Codex when supported. Remove the entry only after receipt is
  confirmed. If the turn ends before accepting it, keep the entry queued.
  If a response is lost, reconcile the original attempt before retrying.
  Serialize dispatch, edit, remove, and steer for the same entry so two
  tabs cannot send it twice.

## 4. Coordinate user prompts and Factory work

- Reuse the existing turn and action controls in
  [issue-chat-runtime.mjs](../../scripts/factory-ui/issue-chat-runtime.mjs)
  and [server-action.mjs](../../scripts/factory-ui/server-action.mjs). Keep
  one active turn per issue across Factory and native Codex. Show a turn
  started in native Codex and queue user prompts behind it.
- Pause holds both queued prompts and automatic Factory work after the
  current turn or operation finishes. Stop interrupts the current prompt,
  retains its partial output and edits, and holds later work until Resume.
  Resume drains user prompts oldest first, then allows Factory to continue
  through its existing approvals.
- Show the active server operation and keep queueing available. Offer Stop
  for an operation that can be cancelled. During merge, offer **Pause after
  this operation** and reconcile any request already sent to GitHub.
- Allow discussion and history queries before a checkout exists. Use normal
  issue checkout setup on the first request for code work. Run editable
  turns in that checkout with normal Codex permission prompts. Keep explicit
  Factory merge and acceptance decisions in their existing controls.

## Verification for handoff

Extend the existing chat, native chat, strategy, server control, and Factory
browser checks. Use disposable issues to verify these flows.

- Capture an issue, start its first chat, grill, implement, verify, and
  record a merge. Reopen the same chat from Factory and Codex. Confirm that
  a retro and a history query cover the lifecycle with evidence links.
- Queue several prompts with different skills, edit one, remove one, and
  resume in FIFO order. Verify Factory waits for the user queue before
  advancing. Exercise reload and restart while paused.
- Pause while a prompt is active, then stop a different prompt. Verify
  the first finishes and the second is interrupted. Partial output, edits,
  and queued prompts remain visible.
- Start a turn from native Codex and send from Factory. Race Steer against
  turn completion and lose a send acknowledgement. Confirm the original
  prompt is reconciled and never steers a replacement turn or runs twice.
- Queue a prompt during verification and during a merge. Check the visible
  status and available controls. Verify that permissions, check results,
  merge approval, and acceptance retain their existing authority.

Run the relevant Factory and browser checks and the required audit checkpoint.
Update the Factory UI guide and codebase map with the implemented behavior.
Follow the [verification guide](../agents/verification.md).
