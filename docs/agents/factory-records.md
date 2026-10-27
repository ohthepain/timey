# Shared factory progress and completion

Both coordinators use the same records. The chat coordinator selects work across
the queue and stops after its requested operation. The issue coordinator continues
one approved plan. These control loops and their authorization remain separate.

An assignment finishing and an issue step finishing are different facts. An
investigation can finish while the Implement step remains unfinished. Record the
assignment outcome through `factory record`; record satisfied issue steps through
`factory complete`. Both front doors use the same writers and evidence rules.
Neither operation means user acceptance.

## Read current progress

`pnpm run factory -- inspect` includes `progress`, keyed by full issue ID, alongside
reports and assignments. It contains the issue coordinator's current status, plan
approval, outstanding question and saved activity. Read it before proposing work.
If that coordinator is active, inspect its work rather than starting a competing
coordinator. If it is waiting, surface its exact request and existing response
control; do not invent another question or claim the request was answered.
Opening or inspecting progress starts nothing. Runtime connection details and live
output remain transport records, not a second account of completed issue work.

The shared store preserves `.issues/factory-ui/lifecycle.json` and existing IDs for
compatibility. Its historical directory name does not restrict who can read it.
Updates merge the selected issue into the latest ledger under a lock; a damaged
ledger or unknown lock is a diagnostic, never permission to reset it.

## Record implementation checks

After reviewing the linked implementation plan and actual evidence, run:

```sh
pnpm run factory -- record-checks /absolute/tmp/checks.json
```

The JSON contains `issue_id`, `expected_state`, `revision`, `report_sha256`,
`basis` (the inspection’s `completion_basis`), `plan_path`, `result`, and optional `chat_id`. Use the current inspection's report
hash, state and snapshot HEAD. `result` follows `planCheckSchema` in
`scripts/factory-ui/plan-check-schema.mjs`: preserve original plan step IDs and
version groups, give each acceptance criterion its result, explanation, concrete
next action, evidence file paths and any existing human-check ID. The validator
requires inspected supporting files for passes/failures/skips and forbids invented
human approval. Existing applicable manual skips are preserved.

Both entry points write the same `plan_verification` report field and a shared
receipt under `.issues/factory-progress/`. The UI and native completion checks
validate the same report, plan, source and evidence hashes. No UI chat or run
history is needed to use native-reviewed results. Legacy UI receipts remain
readable. Changed requirements, plan, source or evidence invalidate old results.

## Record completed issue steps

After reviewing the current stage's actual exit conditions, run:

```sh
pnpm run factory -- complete /absolute/tmp/completion.json
```

The envelope contains `issue_id`, `expected_state`, `revision`, `report_sha256`,
`basis` (the inspection’s `completion_basis`), `result`, and optional `chat_id`, using the fresh inspection. `result` contains:

- `outcome: "completed"`, `summary`, factual `notes`, absolute `evidence` file
  paths, and `remaining` limitations or tasks.
- `next_state`, and `stage_records` in configured order, each with `state`,
  `outcome` (`completed` or policy-permitted `skipped`) and an evidenced `reason`.
- `skipped_steps: []`, `commit_revision`, `verification_summary` and
  `audit_summary`; use null for inapplicable commit/check summaries. Implementation
  and Commit need the real existing commit; Verify needs actual current check
  summaries, including the strict saved-base audit.

This calls the same stage/evidence validators and atomic report writer as the UI.
It records stage history and supporting hashes without starting a worker, merging,
committing source, changing human judgments or closing the issue. It rejects
stale reports/source, active issue coordination, competing reviews/integration,
unsupported skips, missing checks and attempts to manufacture acceptance. It does
not change assignment status; record that separately only when its own evidence
requirements are satisfied. A failed completion write is not permission to edit
the report manually to bypass the check.

## Authorization and handoffs

Record the actual source of each operation: a direct user action, continuation
under an exact approved plan and its approval receipt, or coordinator bookkeeping.
Automatic retries are coordinator instructions, never fictional human follow-ups.
A plan does not supply human-first candidate approval or final acceptance.

Reviewers return findings to whichever coordinator requested them. That handoff
is normal. The issue coordinator saves guarded updates and continues; the chat
coordinator records its requested operation and presents the next manual choice.
Ask the user only for an actual missing decision, observation or permission, and
show that request where they can answer it. Do not ask them to find a different
coordinator to perform routine bookkeeping.

## Skip decision sources

Stage history and saved route steps carry a `source` beside the reason:
`{ kind: original-report }`, `{ kind: user }`, or
`{ kind: stage, state: <configured-state> }`. The expanded skipped stage shows
both source and reason. A future skip remains a plan until applied; applying it
preserves the original decision source. The server supplies stage sources from
the actual review context, independently of execution authorization. Older records
with no known source say “Source not recorded”; the current stage is not used to
invent a historical source. See the tracker guide for initial capture routing.

Saving confirmed grilling to any role updates the inputs used by Progress and
invalidates its previous scope assessment. Save alone enables Continue without
starting work; Save and continue uses that same updated record immediately.
The next assessment reads the saved answers and respects recorded initial skips,
then presents any required exact-plan approval. A saved interview alone does not
approve implementation, finish the role or grant final acceptance.
