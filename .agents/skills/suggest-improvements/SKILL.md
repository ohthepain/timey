---
name: suggest-improvements
description: Explore concrete improvements to an issue as a selectable branching tree, then prepare a reviewable revision. Use when asked to suggest or explore issue improvements.
---

# Suggest improvements

Help the user improve an issue through proposals and branches. Read the issue and available conversation or project context first. Check relevant facts yourself; ask the user only to choose among meaningful improvements or settle decisions you cannot infer.

## Explore the tree

1. Identify the issue's intended outcome, existing constraints, and unresolved gaps. Keep the issue's purpose and scope intact.
2. Offer a concise, prioritized round of concrete improvements. Give each a stable ID, a short title, why it would help, and suggested wording or a specific change. Include only useful proposals, not generic advice.
3. Ask the user to select IDs to explore, or to reject all. Treat selection as permission to develop that suggestion's branch only; it does not approve or apply the change.
4. For every selected suggestion, offer its own related follow-up improvements with IDs that retain their parent path (for example, `2.1`). Ask for selections across the current frontier together. Do not develop unselected branches or ask a question whose answer depends on an unresolved choice.
5. Continue from the selected frontier until the user says the tree is complete or no useful follow-up improvements remain. Keep accepted, rejected, and unresolved choices distinct.

## Present the result

When exploration is complete, summarize the selected improvements and prepare a proposed revised issue statement, including relevant acceptance criteria or scope wording. Show unresolved choices separately. Ask the user to review the proposal. The proposal is not an issue edit, implementation plan approval, or authorization to start work; apply it only if the user explicitly asks.

Do not invent requirements, broaden the issue for completeness, or describe suggested changes as already saved or implemented.
