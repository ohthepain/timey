# Issue retros

Agreed design. See the [Close and Cleanup design](flow-close-cleanup.md) for
the closure sequence.

## Agreed behavior

- The Request block owns the **Run a retro** setting. Create issue offers the
  same setting, unchecked by default. When the setting is on, the open flow
  shows a planned **Retro** block.
- The Close dialog uses the Request setting for Fixed and starts Retro unchecked
  for every other reason. The checkbox sets the choice for that closure.
  Automatic Fixed closure uses the Request setting.
- When Retro is enabled for the closure, the sequence is **Close → Retro → Cleanup**. Both the
  issue header and the flow follow this sequence. Retro can read the history
  before Cleanup removes the worktree transcript or archives chats.
- If Retro fails, the issue stays Closed and Cleanup waits. The user can retry
  Retro or explicitly continue to Cleanup.
- Retro creates follow-ups immediately in the **Retro items** issue folder.
  Each follow-up retains its source issue ID. Subsequent blocks receive a sanitized
  snapshot of that issue's report and timestamped attempts from the coordinator,
  including verified retained GitHub response artifacts. They do not need the
  source queue copied into their checkout.
  Approval is required before work starts on those follow-ups.
- Automatically generated issues default to **Needs approval**. Create issue
  offers **Needs approval** as an unchecked option for manual capture.
- An issue awaiting approval shows **Approve** and **Delete** in place of
  **Worktree** and **Close**.
  **Approve** restores the normal controls, keeps the issue in its current
  folder, and leaves it idle.
  **Delete** removes the proposal with one click. The issue does not enter Closed
  issues or Archive.
- Issue creation and implementation can happen on different machines. Saved
  issue conversations can start before an issue worktree exists.
- Closing a reopened issue can run a fresh Retro using the new closure choice.
  Retrying a Retro preserves earlier approval and deletion decisions for its
  follow-ups.

## Conversation history today

- Flow model blocks start and continue separate Codex threads in the managed
  issue worktree. The local timeline stores block prompts and responses, and
  the Flow UI shows its last 100 entries. Codex owns the native threads.
  [Flow executor](../../scripts/factory-ui/flow-executor.mjs#L352)
- Request clarification, the prompted flow builder, and artifact Restate use a
  temporary workspace. Request keeps its result in the saved attempt. The flow
  builder keeps the resulting structure.
  [Temporary discussion runtime](../../scripts/factory-ui/discussion-codex.mjs#L20)
- Classic can start a conversation in the project root before an issue has a
  worktree. It can resume the same thread in the managed checkout when work
  starts. The local transcript moves to the checkout when Factory finds it.
  Legacy workers can use separate worktrees.
  [Classic issue chat](../../scripts/factory-ui/issue-chat.mjs#L318),
  [Conversation storage](../../scripts/factory-ui/conversation-store.mjs#L18)

## Retro input

Use the issue report and the history Retro can access from the saved timeline,
flow attempts, and linked Codex threads. Include earlier attempts, retired
blocks, and recorded worker results. Preserve the order within each thread.
Use recorded times and saved attempt order to place events across threads.
Report missing history and uncertain ordering in the retro. Save the result
outside the worktree so it remains available after Cleanup.

Retro retains the complete redacted report, timeline, attempts, and linked turns
as separate JSON files with a small index, byte/character lengths and SHA-256
digests. Its initial message contains only that index. The index is linked from
the saved result outside the issue worktree, so Cleanup does not remove it.
No section is truncated. Missing provider history remains explicitly marked.

Retro and project-owned temporary discussions use an isolated Codex process
with the project checkout as the working directory, native file/search/Git
inspection enabled, a read-only sandbox and no approval escalation. They can
inspect relevant source, linked evidence and recent Git history/diffs. Writes
and workflow actions remain unavailable. The issue checkout path is supplied
when available; the runner must distinguish revisions and uncommitted state.
Temporary discussion context is supplied through a complete JSON file, and
inputs/instructions over 16,000 characters are supplied through file references.
Those temporary files are removed when the session ends. Model instructions
require bounded searches/reads, citations and disclosure of uninspected evidence;
access to the full history does not claim every record was read. This bounds
initial input rather than history collection memory or cumulative model context.

In shared queue mode, the report can travel with the queue. Local transcripts,
worktrees, and runtime records stay on their runner.
[Shared queue design](shared-issue-queue.md)

Shared closure and deletion follow the queue's configured publication route.
Cleanup waits for closure to reach the shared queue so the runner can retain its
worktree while the report is pending.

When the shared queue uses PRs, merge the proposal’s queue PR before selecting **Approve**.
Flow checks that the PR landed as part of approval, even if the last queue
refresh still showed it as open. Approval opens a separate queue PR to record
the decision and leaves the issue idle. Work can start once that update lands.
