---
status: accepted
---

# Integrate native coding agents

For Anthropic and Google support, run the installed Claude Code and Gemini CLI
agents with their own supported authentication, billing, tools, and conversations.
This preserves existing subscription access and avoids building another coding
agent loop around model APIs. Timey adapts their execution into its chats and
ordinary model-driven flow blocks.

Timey must expose tool activity, approval requests, interruption, and explicit
recovery. Agents receive applicable project instructions, selected skill content,
and required Timey tools. Unsupported required capabilities are reported before
dispatch. These requirements must be demonstrated for each integration.

Each conversation remains with the agent that created it. An explicit provider
change starts a fresh conversation with a handoff summary and retains the original
history. Failures never silently select another provider, model, or billing method.

The user agreed to these choices during the
[design interview](../plans/anthropic-google-model-support.md) and confirmed shared
understanding before authorizing implementation. This decision revises the Codex-only ownership in
[ADR 0007](0007-codex-owns-issue-conversations.md) and the Codex-specific model-block
conversations in [ADR 0013](0013-explicit-issue-flows.md) for these new agents.
Implementation and live verification are tracked in the design plan.
