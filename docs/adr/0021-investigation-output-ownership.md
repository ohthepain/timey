# Investigation outputs and retained reports

Investigations use the ordinary flow workspace. Request and Investigate precede
independently optional Generate report and Create Issues blocks. The saved array
controls execution order. Both outputs depend on completed inquiry findings;
Create Issues also receives findings from successfully completed report attempts.
Report failure pauses the route without preventing manual issue output.
Saved-output discovery lists report references rather than forwarding report
bodies. Only completed report attempts supply supplemental findings and retained
evidence. Create Issues records the facts it consumed. A successful report with
changed supplemental facts invalidates that completion without starting work;
new presentation of the same facts leaves it current.

Output attempts retain an immutable source snapshot with the investigation issue,
producer block and attempt, timestamp, inspected commit, findings, and evidence.
A new inquiry creates a run. Output-only executions stay attached to their source
run. Retry preserves publication identity and saved issue receipts even if a skill
is replaced. A deliberate generation receives a fresh publication identity.

Skills choose how to save their originals. Guarded output tools register retained
reports and approval-needed issue creations. Timey copies report content and
supporting evidence before deleting the disposable inquiry checkout. Evidence
integrity is checked when read. Missing or changed evidence does not hide the
report. Published report records are immutable.

Report discussion belongs to the investigation, separately from project-owned
conversations. It shares ProjectDiscuss rendering, sending, tools, and skills.
Each message snapshots its selected report context. Reading or discussing an
archived source never restores it or starts inquiry work.

Idle standard legacy flows adopt the new blocks without replacing inquiry attempt
identities. Customized layouts and unresolved active work stay unchanged.
Historical issue completion is backed by retained outcomes, not fabricated runs.

See the [accepted design and acceptance scenarios](../plans/investigation-reports.md)
and the [codebase map](../agents/codebase.md) for implementation boundaries.

## Retained native chat tools

The native protocol accepts dynamic tools at thread creation but cannot add them
when resuming an existing thread. Classic issue conversations therefore expose
the shared project registry through an authenticated loopback MCP adapter. Each
Codex connection configures its own adapter before starting the native process.
It can resume the original native thread with these tools, preserving its identity
and existing writer guards. No global Codex configuration changes are needed.

The adapter allows tool calls only during the owning connection's active turns.
Its session receipts reject changed or uncertain request replay. The project
registry retains its existing approval, ownership, and execution checks. Closing
the native connection also closes its adapter. Creating or loading an
investigation starts no model turn.
