# Explicit issue flows

The `number_2` design makes each operation a visible block that the person starts.
The graph is the planned route. A completed block never starts its successor.
This addresses the strategy runner's coupling of work, target synchronization,
verification, publication, and readiness.

The flow workspace is the factory server's default page. `/classic` retains the
strategy interface and its historical records. This decision supersedes ADR 0009's
bundled execution for explicitly started flow blocks. It preserves existing
strategy assignments, human-input obligations, protected merge checks, and explicit
acceptance. Reading or refreshing a flow does not migrate or launch old work.

Each issue has one JSON flow under `.issues/flows/ISSUE_ID/flow.json`. The flow
stores the request type and fields, target, workspace identity, blocks, dependencies,
lanes, comments, and attempts. Revision checks reject conflicting edits. Retrying
appends an attempt. Interrupted ownership remains uncertain until the original
provider thread is reconciled. The flow survives workspace deletion.

The optional `startingPoint` stores a full Git ref, display name, and exact commit.
It is independent of the delivery target. Project defaults remember only the ref
in `.issues/flows/defaults.json`; each new capture snapshots its current commit.
Selecting a starting point does not switch the project checkout. Attempts and
retained workspaces lock the selection. Existing flows without the field retain
their saved base or legacy target behavior.

The controller owns flow writes. The executor owns one bounded block and returns
results and evidence. The observer reads Git and PR facts independently of model
turns. Local Git queries have short timeouts. PR reads run separately and retain
freshness and failures. An externally merged PR is an observation, not acceptance.
Target changes produce a dotted merge-from-target suggestion, never an automatic
merge. Git fetches remain explicit operations or external Git-tool work.

One saved conversation belongs to each issue and lives in its managed checkout.
Before the checkout exists, the existing conversation store uses its project
fallback. Classic and flow writers cannot own the same issue concurrently.
Parallel graph lanes describe independent branches. The owning Arena or Swarm
skill can coordinate isolated parallel workers inside its block; ordinary blocks
serialize through the one conversation.

Installed skills are discovered explicitly through the existing Codex transport.
The chosen skill remains bound to a block's continuation. Missing skills stop that
block without substituting another method. Skill instructions do not authorize
later verification, publication, merge, closure, or cleanup blocks.

Verification runs only when selected. Publication and merge use the recorded,
unchanged candidate and retained verification evidence. GitHub App publication,
provider-enforced protection, explicit acceptance, and cleanup ownership checks
remain required. Missing project policy or credentials are visible blockers, not
reasons to invent passing evidence or a legacy approval.

The artifact inspector lists issue records, flow attempts, conversation files,
command evidence, cleanup backups, and the worktree. Deleting a listed evidence
file makes it missing and invalidates any proof that requires it. Workspace
removal uses the protected cleanup adapter and retains its backups.
