# Factory interface

Use `/factory` (or `$factory`) as the front door for coordinating the local issue
queue. `/Factory` means the same skill. Evaluation and worker launches remain
separate manual actions.

| In chat           | Result                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------- |
| `/factory`        | Evaluate the queue, existing workers, grouping and priorities; offer the next choices. |
| `/factory ID ID`  | Evaluate only the selected issues, checking dependencies and existing work.            |
| `/factory issues` | Display the existing code-generated issue table, without an evaluation.                |

Issue selection accepts full IDs or unique prefixes. Ambiguous or missing IDs
stop selection and show a useful diagnostic. Selecting issues authorizes planning
and discussion of their required input; launching work requires another choice.
Dependencies outside the selection are inspected and explained before proposing
their inclusion. Existing workers are reused rather than duplicated.

## Choose what happens next

Each evaluation offers applicable choices, names the issues/actions, and explains
what each choice will unblock:

- **Human input:** answer, grill, defer, or perform an available human check in the
  current chat. Handle only input needed for the next operation; hardware evidence
  and final judgment become useful at their own stage.
- **Launch recommended group:** explicitly start the displayed independent saved
  actions in separate worker chats. Show scope, dependencies, verification and
  merge policy before the choice. Allow narrowing the group.
- **Both:** start the displayed independent actions, then handle the selected human
  input here. Work depending on those answers stays pending.

Use native follow-up suggestions with explicit commands as fallbacks. Carry saved
action IDs in the submitted prompt so users can choose named work without copying
UUIDs. Offer only applicable choices; an unavailable choice gets its reason.
If no work or human input is actionable, explain what is pending.

| Explicit continuation           | Meaning                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `/factory human [ISSUE_ID ...]` | Handle the selected issues' human input; omit IDs for the queue.                                                               |
| `/factory launch ACTION_ID ...` | Launch exactly the selected saved actions.                                                                                     |
| `/factory both ACTION_ID ...`   | Launch those actions, then offer human input for their issues and the previously displayed human-input selection in this chat. |
| `/factory integrate ACTION_ID`  | Finalize one completed code action under its merge policy.                                                                     |

For Both, include the displayed human-input issue IDs in the follow-up's plain
language prompt as well as the explicit action IDs. With a bare Both command,
use the selected actions' issues only. Never infer an unrelated selection from
another chat or a lost conversation context.

Saving an answer records input only. Offer a manual reevaluation when answers
change readiness; old saved recommendations may now be stale. An explicit
“Answer and continue” must name the next operation. Neither answers nor worker
completion start another iteration, launch dependent work, merge, or accept issues.
Apply the installed issues skill's human-input protocol and project verification
policy; a flag or timestamp cannot establish an answer or human evidence.

## Code and coordinator responsibilities

`npm run factory --` returns a read-only inspection with `focus_issue_ids` for
the whole queue. Add issue IDs to narrow that focus. Dependency context stays in
the inspection; it does not expand the assignment. The coordinator evaluates
meaning, grouping, evidence and priorities and saves recommendations.

For listing, run:

```sh
npm run factory -- issues --output /absolute/writable/visualization/issues-unique.html
```

This calls the installed `.agents/skills/issues/scripts/list-issues.mjs` directly
with the current project. Its filters (`--state`, `--sort`), counts, diagnostics
and HTML are unchanged. Display the returned path using the issues skill's inline
renderer. Listing reads no factory registry and writes only the requested output;
it performs no model reconstruction, readiness assessment or queue mutation.
An absent helper requires installation, rather than a competing parser.

Chat operations such as launch need the skill and app tools; the shell helper
does not create chats. Each selected action retains its own reservation and chat
reference. Revalidate all selected actions before dispatch, then reserve and attach
each once. A failed or uncertain launch stops the remaining group and preserves
earlier successes/reservations for reconciliation; report per-action outcomes.
Groups are not atomic and never imply automatic retries or subsequent batches.

Read [operating rules](operating.md) for ownership, launch and integration policy,
[verification](verification.md) for evidence and human gates, and the
[factory skill](../../.agents/skills/factory/SKILL.md) for execution steps.

## Local UI adapter

The [local factory UI](factory-ui.md) is an alternative front door for the same
queue and ledger. `npm run factory:ui -- --project /absolute/project` serves the
queue and issue screens locally. This adapter uses the installed Codex CLI
app-server transport instead of native chat creation. Scope, ownership, human
gates and verification policy are unchanged. Reviewing, saving recommendations,
starting each worker and integrating each candidate remain separate manual
actions. Native chat commands continue to follow the factory skill.
