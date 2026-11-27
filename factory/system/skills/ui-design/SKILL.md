---
name: ui-design
description: Work through UI changes, visual or interaction decisions, and page feedback in Project Discuss. Use automatically for relevant requests or when invoked as /ui-design.
---

Start with what the person is trying to accomplish, which decisions are still
open, and which skills are available. Keep the work in Project Discuss.

- If the request is specific and follows an existing UI pattern, help directly
  within the person's authorization.
- If the goal or a constraint is unclear, ask the question that would change the
  outcome. Offer a deeper discussion through a configured or explicitly allowed
  grilling skill when one is available. Respect the chat's clarification setting.
- If a visual or interaction choice would be easier to evaluate in a prototype,
  name the choice and say what the prototype would let the person compare. Build
  it only after an explicit request or acceptance. If they decline, carry on
  with their preferred approach.
- For feedback on an existing page, offer an applicable critique skill such as
  Impeccable when available. If none is available, review the page in the
  conversation using the material the person supplied or authorized you to inspect.

Make offers and ask questions in the reply itself. Use optional skills only
when their invocation policy allows it. When a prototype is requested, use an
available prototype skill if appropriate, or build it directly.

## Review a prototype

Present the prototype, explain how to open it and what to try, and ask for
feedback on the open decision. Refine it as often as needed. For each version,
save screenshots of visual decisions and a runnable file when the interaction
matters. In Factory, give each design a unique staging subdirectory under
`.cache/discuss-prototypes/`. Call `discuss_prototype_files` with paths relative
to `.cache/discuss-prototypes/`. Use a self-contained HTML file or a ZIP with run
instructions for the interaction. Use the returned links in the reply. Each call
retains a copy, so refinements can reuse staging paths without changing earlier
versions.

If an older provider session lacks the retention tool, agree on a durable
project location with the person. Save each version under its own name and
include its exact project-relative paths and run instructions in the handoff.
Verify that the agreed location is accessible from the implementation context.

Keep the selected version's links and the reasons for the chosen direction
in the conversation. Check that the selected version can be reopened before
using the reference in an issue.

## Hand off agreed work

Treat design approval such as “That looks right” as a decision about the design.
Confirm the selection and ask whether to create an implementation issue. Wait
for an explicit instruction such as “Create the issue.”

On that instruction, use the existing `issue_create` tool. Describe the agreed
change, constraints, design decisions and rationale, acceptance criteria, and
the selected prototype's retained links and run instructions when applicable.
Reply with the issue link. Creation leaves work idle. Keep further design
discussion here and use the project's ordinary issue workflow for implementation.
