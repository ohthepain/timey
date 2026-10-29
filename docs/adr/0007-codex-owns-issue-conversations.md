# Codex owns each issue's conversation

Once a conversation is needed, each issue has one native Codex chat for all
lifecycle roles, human interaction, and retrospectives. The factory server starts
or continues no model conversations.
Independent verification may use a subagent of the issue chat, with its findings
brought back into that same chat. This keeps the work visible and interactive in
Codex while retaining an independent reviewer context.

This refines [the persistent issue conversation decision](0003-persistent-issue-conversation.md):
the shared conversation is the actual Codex chat, rather than a combined timeline
of separate server-managed chats. It replaces the separate review-chat requirement
for the new design. Required checks and human acceptance remain separate from a
reviewer's findings.

Saving an issue creates no chat. Only an explicit choice to discuss or work on the
issue creates its first Codex chat, once there is more than a title. Later
discussion and work use that same chat.

After the user approves a plan and asks to proceed, the issue chat continues
through applicable roles, pausing for questions, required approvals, or blockers.
Role changes alone do not require another click, and the user can interrupt.
Questions, plan discussions, and retrospectives happen in Codex. The factory
shows saved progress, results, and a link to the issue chat when one exists.

The issue chat can inspect code, implement, run checks, and conduct reviews while
the factory server is stopped, using local commands and saved issue records. The
factory UI catches up from those records when it returns.

For existing issues with several chats, select one as the issue's home, bring
across a summary and links to earlier evidence, and preserve the other chats as
history. Switch running work at a safe stopping point, retaining results and
avoiding duplicate execution.

The user confirmed shared understanding of these decisions.
The [implementation plan](../plans/codex-owned-issue-execution.md) is recorded;
implementation has started with the experimental native handoff proof. The
factory runtime has not been cut over.
Existing runtime documentation describes the current adapter
until it is changed. This decision does not establish the cause of reported factory
unresponsiveness.
