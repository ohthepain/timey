---
status: accepted
---

# Combine clarification and investigation as Clarify

Use one adaptive stage named **Clarify** that interleaves human questions,
code inspection and diagnostic checks, removing the mandatory handoff between
Clarify and Investigate. The agent establishes available facts before asking the
person for intent, preferences or observations it cannot establish, and continues
independent investigation while awaiting answers. Production changes still
require separate implementation-plan approval.

Implementation-plan approval covers the intended outcome and scope, rather than
fixing a technical recipe. Implementation can adapt its approach without repeated
approval; a meaningful change to the requested outcome or scope, or a real user
decision, requires the person's input.

Use judgment about when there is enough understanding to start useful work;
formal exit checklists and exhaustive diagnosis are unnecessary. Implementation
handles remaining technical uncertainty and ordinary discoveries. A report with
enough existing context can bypass Clarify with a recorded reason, including a bug
whose useful next step is already clear.

Understanding remains useful across commits. A commit or revision change alone
does not invalidate clarification or require repeating the stage. Revisit actual
changes in intent or scope when needed, rather than treating every technical
discovery as a reason to send the issue backward.

Existing Clarify and Investigate issues carry their findings, answers and history
into the combined Clarify stage. Active investigations finish their current
assignment without restarting. Preserve their original scope, authority and
evidence rather than making issues repeat completed work.

This revises the choice in [ADR 0001](0001-human-input-separate-from-lifecycle.md)
to retain a separate clarification stage; its distinction between human input,
grilling and lifecycle position remains applicable. The user confirmed these
design decisions on 2026-10-28. Implementation is pending; this accepted design
does not claim that the lifecycle has changed or authorize production changes.
