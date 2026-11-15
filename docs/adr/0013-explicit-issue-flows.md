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

Each issue has one JSON flow under `.issues/flows/ISSUE_ID/flow.json`. The flow stores blocks, dependencies, lanes, comments and attempts. Request owns
Your words and the agent's clarified fields. Target owns the starting point and
the delivery destination. A starting point records the full Git ref, display name
and exact commit independently of the PR target. Project defaults remember the
ref for future captures. Selecting a starting point never switches the project
checkout. A retained checkout or a work attempt locks the selection.

A block type's Markdown defines its system prompt and its Details and Artifacts
tables. Details declares the block's inputs; Artifacts declares its outputs. The
inspector renders inputs first, then read-only outputs from the latest run, and a
collapsed System prompt section. Each input switches between Manual and Source.
Source defaults to the unique upstream output named by the Details source; when
there is no unique match, the person chooses a source or switches to Manual.
Saved links use the producer's block ID. Request fields are the normal source for
request facts and wording; Target's branch output is the normal source for branch
fields.

Optional Type and Options columns shape the controls. Supported input types are
`text`, `long text`, `number`, `boolean`, `choice`, `filename`, and `url`; missing
types default to `text`. Choice options are a JSON array in the Options cell.
Filename inputs select a regular file inside the issue repository and save its
relative path. URL values use URL controls and valid HTTP(S) outputs are links.
Artifacts retain their `value` or `file` kind; file artifacts remain file outputs.
Earlier output values stay in attempt history. The block prompt determines
whether missing data or proof should fail the task.

Opening the block editor, starting the block or clicking its wand checks the
selected definition's checksum. A detected edit invalidates every instance of
that definition and the connected successors of each instance. A saved block edit
likewise invalidates the edited block and its connected successors. These actions
request a stop for active work in affected flows. An invalidated attempt remains
in history with the definition and resolved Details it actually used. Results
returned after invalidation remain historical. Details resolve again when the
editor opens, a block starts or a relevant edit is saved.

Saving Your words or clicking the Request wand invalidates the entire flow and
runs only Request clarification. The agent derives the issue type, goal, done
check, requested proof, known facts and constraints. A change of type offers a
route rebuild. Rebuild requires an explicit user action. It reconnects compatible
custom blocks and retains displaced blocks' history. Legacy records are read in
the new shape. The Request wand gives the user an explicit way to invalidate
legacy results and derive fresh fields.

Revision checks reject conflicting edits. Retrying appends an attempt. Interrupted
ownership remains uncertain until the original provider thread is reconciled.
The flow survives workspace deletion.

The controller owns flow writes. The executor owns one bounded block and returns
results and evidence. The observer reads Git and PR facts independently of model
turns. Local Git queries have short timeouts. PR reads run separately and retain
freshness and failures. An externally merged PR is an observation, not acceptance.
Target changes produce a dotted merge-from-target suggestion, never an automatic
merge. Git fetches remain explicit operations or external Git-tool work.

The issue timeline groups notes and results from its blocks. Model blocks use
their own Codex conversations so each receives its declared inputs independently.
Explicit continuation can reuse a block conversation with the same inputs and
definition. Before the checkout exists, the timeline uses its project fallback. Classic and flow writers cannot own the same issue concurrently.
Parallel graph lanes describe independent branches. The owning Arena or Swarm
skill can coordinate isolated parallel workers inside its block; ordinary blocks
serialize through the one conversation.

Installed skills are discovered explicitly through the existing Codex transport.
A continuation reuses a conversation only while its skill and inputs match. Missing skills stop that
block without substituting another method. Skill instructions do not authorize
later verification, publication, merge, closure, or cleanup blocks.

Verification runs only when selected. Publication and merge use the recorded,
unchanged candidate and retained verification evidence. GitHub App publication,
provider-enforced protection, explicit acceptance, and cleanup ownership checks
remain required. Missing project policy or credentials are visible blockers, not
reasons to invent passing evidence or a legacy approval.

The artifact inspector shows evidence produced by the selected block. The latest
run appears first. Invalidated results remain visible with their old inputs. Existing evidence from older runs appears in collapsed sections
labeled by run number. Missing files and files that differ from their recorded
digest are omitted. Deleting evidence invalidates any proof that requires it.
Inspect shows raw text and offers a Restate toggle that applies the bro skill’s
plain-language guidance in a temporary discussion. Workspace removal uses the protected cleanup
adapter and retains its backups.
