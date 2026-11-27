# Factory interface

Use `/factory` (or `$factory`) as the front door for coordinating the local issue
queue. `/Factory` means the same skill. Evaluation and worker launches remain
separate manual actions.

| In chat           | Result                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `/factory`        | Evaluate the queue, existing workers, grouping and priorities; offer the next choices.             |
| `/factory ID ID`  | Evaluate only the selected issues, checking dependencies and existing work.                        |
| `/factory issues` | Display the existing code-generated issue table, without an evaluation.                            |
| `/factory status` | Show compact last-recorded progress, results, remaining work and evidence links for factory tasks. |

Issue selection accepts full IDs or unique prefixes. Ambiguous or missing IDs
stop selection and show a useful diagnostic. Selecting issues authorizes planning
and discussion of their required input; launching work requires another choice.
Dependencies outside the selection are inspected and explained before proposing
their inclusion. Existing workers are reused rather than duplicated.

For changes to the block inspector's Markdown labels, follow
[Edit the Factory UI from Markdown](../../README.md#edit-the-factory-ui-from-markdown).
Use `pnpm run factory ui find` to locate the source and its consumers.

## Create an issue from an external chat

When registered chat tools are unavailable, use the supported server command:

```sh
pnpm run factory -- issue-create REQUEST.json --url http://127.0.0.1:4317
```

Use the live server's actual URL. The command verifies that it serves the current
project, then uses the same guarded capture operation as the UI. It creates an
idle issue in the folder's inherited Issue and Artifact stores. Continue the issue
from its returned server link; creation starts no clarification or implementation.

Save the request before sending it, for example under
`.issues/creation-requests/`. Keep that file and reuse its UUID for retries,
including after a timeout or server restart. Changed wording under the same UUID
is rejected rather than silently creating another issue.

```json
{
  "requestId": "a9c37a62-4dbf-41e8-866b-19a4852eb08e",
  "description": "Issue title\n\nAgreed problem, scope, constraints, decisions, acceptance criteria and requested proof.",
  "type": "feature"
}
```

`folder` and `storageProfile` are optional explicit overrides. Without them,
creation uses the project's default issue folder and its inherited storage
profile. Supported types are `bug`, `feature`, and `investigation`; omit `type`
to infer it. Put this chat's agreed work context in `description`, rather than
instructions such as "create only" or "do not start now". No external chat
connection is transferred: the server retains the work request and owns its later
execution conversation. This command grants no resume, merge or closure authority.

## Check progress

`/factory status` displays a code-generated summary from the saved factory records.
It reads no issue reports, evidence contents or chat histories, and changes nothing.
Chat references are included in the JSON output so an agent can check a known chat
without searching for it again. Status is a saved observation, not a live check or
permission to launch, merge or accept an issue.

```sh
pnpm run factory -- status
pnpm run factory -- status --json
pnpm run factory -- status ACTION_ID --details
```

Add full action IDs or unique action-ID prefixes to narrow the summary. Full saved
records, including worker prompts and unabridged evidence, require `--details` and
exactly one selected action. A saved prompt may contain an old issue snapshot;
read the current report before taking further action. Missing or damaged records
are reported rather than initialized or repaired.

Each row shows the task, saved progress, a short result, remaining work, and links
to local evidence. Long legacy evidence is shortened; when no file link can be
recovered, the link opens the saved factory records. Missing evidence files are
identified. Remaining work uses a saved list when provided, otherwise a reminder
based on the action's state; it does not assess the linked issue's requirements
or acceptance. No result is invented for tasks still waiting for a response.

When recording a reviewed result through `factory record`, keep the existing
required `evidence` and optionally provide `summary` (a concise sentence),
`remaining` (a list of next steps), and `evidence_links` (local file or directory
paths, absolute or relative to the project). These are reporting fields only.
A newer result clears older reporting fields unless they are explicitly supplied
again, so a completed merge cannot keep showing an obsolete “merge next” message.
Reading status never backfills old records or completes human obligations.

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
| `/factory integrate ACTION_ID`  | Assemble one reviewed contribution on its issue branch; complete-issue PR delivery is separate.                                |

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

`pnpm run factory --` returns a read-only inspection with `focus_issue_ids` for
the whole queue. Add issue IDs to narrow that focus. Dependency context stays in
the inspection; it does not expand the assignment. The inspection also includes shared issue progress, plan approval and outstanding
questions; consult these before proposing overlapping work. The coordinator evaluates
meaning, grouping, evidence and priorities and saves recommendations.

For listing, run:

```sh
pnpm run factory -- issues --output /absolute/writable/visualization/issues-unique.html
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

The default browser page opens [Project home](../plans/project-home.md) in the
[explicit flow workspace](../adr/0013-explicit-issue-flows.md). Its project menu
offers Investigate and Automate me. Selecting an issue opens its existing flow.
Run blocks individually or use the issue’s **Start** and **Resume** controls.
Refreshing the page reads saved state without starting work. Legacy browser
links at `/classic` open the selected Flow issue or Project Home.

Run `pnpm run factory:ui -- --project /absolute/project` to serve the workspace
for a local project. Scope, ownership, human gates and verification still apply
to the individual blocks. Native chat commands follow the factory skill’s
one-iteration contract.

Both front doors use [shared progress and completion records](factory-records.md).
Their selection scope and control loops remain separate.

## Issue PR delivery

Follow [issue delivery](issue-delivery.md) for contribution assembly, complete-issue
review, publication, recovery and server-enforced merge gates. Default delivery uses
one draft PR per issue and ends at manual handoff, including failed checks and
unfinished implementation. Explicit verified-delivery routes retain their gates. Historical records retain their original meaning.

## Review a blocked command

When a running issue block waits for permission to execute a specific command,
its **Permission required** notice shows the reason, command, and working
directory when available. Choose **Review permission** to inspect the request.
**Allow once** answers the waiting request for that command. If the command
changes, open a fresh review. **Decline** or Escape closes the review and leaves
the command waiting.

## Attach live proof for a sub-issue

Work reports any requested check that requires a live external write. Before
running that check, record explicit approval on the committed master candidate.
Use a disposable source and target. The production PR and its branches are
outside the proof scope. Factory records the approval and leaves GitHub actions
to the operator or a separately authorized collector.

1. Run `pnpm run factory -- live-proof status MASTER_ID --url SERVER_URL` to get
   the flow revision, committed head and tree, and the reported checks.
2. Save an authorization request and run
   `pnpm run factory -- live-proof authorize REQUEST.json --url SERVER_URL`.
   Include `issueId`, `revision`, `childId`, the reported `check`,
   `candidate: { head, tree }`, `scope: { repository, branch, target }`, and
   `confirmed: true`. For evidence collected separately under prior approval,
   record the same approved scope and candidate before attaching it.
3. Run the exact check under that scope and retain its observations and command
   output. For a required-check transition, record the unreviewed PR while it
   remains open with a pending or failed required check, followed by the same PR
   with successful checks and its automatic merge receipt.
4. Save an attachment request and run
   `pnpm run factory -- live-proof attach REQUEST.json --url SERVER_URL`.
   Include `issueId`, the returned `revision`, `authorizationId` from the receipt,
   `source: "live-github"`, `status: "passed"` or `"failed"`, `pr: { number, repository, branch, target, head }`,
   and `confirmed: true` to attest to actual observations. Include
   `observations: [{ at, observed }]` with ISO UTC timestamps and
   `logs: [{ name, path }]` with paths relative to the request file. Use excerpts
   from the actual logs that cover the required observations and fit in a 64 KiB
   request. Keep credentials out of the evidence. Report fixture runs as local
   proof in Work.
5. Retry Merge. Factory verifies the retained hashes, saved check, exact head
   and tree, and test PR scope. The final verification turn can read those
   observations under read-only permissions. When a candidate or requirement
   changes, use the Merge message to identify the check to authorize and rerun.
   `live-proof status` still lists the earlier attachments.

## Verify a live check from Investigate

Investigate can propose a live verification from a read-only run. Open **Review
permission** beside **Open block details** to inspect the repository, disposable
branches, exact candidate and requested writes. **Allow once** starts a separate
verification attempt under the issue's existing execution claim. **Decline** keeps
the check blocked. Enable **Reusable** to rerun a completed investigation and
request a different scope. Approval is
bound to the saved investigation attempt and expires when that scope changes.

The Full Send late-target check uses the configured GitHub App and repository.
Prepare a protected test target, a ready pull request to advance it, and an
unused source branch name, all under `factory-proof/`. The candidate commit
must already be present in that repository. Factory confirms strict branch
protection, creates the verification PR, then merges the reviewed advance PR
after the candidate passes required checks. It records GitHub's stale merge
response, branch refresh, new checks and final merge parents. A stopped or
interrupted run can leave disposable resources on GitHub. Its attempt evidence
links to the originating investigation. Each run requires its own approval.
