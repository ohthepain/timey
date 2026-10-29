# Rebuild coordinator chats from working notes and current records

Use small coordinator prompts with local source references and reuse each chat
within a modest working-context budget. Rotate early into a fresh chat carrying
only useful computed findings and their supporting references; reload current
queue and issue facts rather than replaying or summarizing the predecessor.
Archive the predecessor for audit after continuity is established, and explicitly
name the active chat “Timey coordinator”. This keeps current decisions grounded
in current records while avoiding oversized contexts and visible chat clutter.

This applies to ADR 0007’s shared-coordinator exception, preserving each issue’s
own conversation and all existing execution and approval boundaries. The
[user-confirmed design](../plans/coordinator-context-and-chat-reuse.md) records
the initial tunable 20,000-token budget and the agreed context/retention behavior;
implementation has not started.
