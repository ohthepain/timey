# Act on investigation findings

A completed investigation needs a direct path to actionable work. A Retro reviews
how an issue went; it is not a prerequisite for using investigation results.

## User experience

Completed Understand blocks offer **Create follow-up issues** in their results.
The action proposes bounded work from the retained findings and evidence. It does
not create issues or start work while preparing the proposals.

Review the proposed title, issue type, request, reason, and proof. Select the
proposals to keep and choose an issue folder, initially the project default.
**Create selected issues** saves only the reviewed selection. Each new issue
needs approval before work starts and links to the exact source issue and attempt.
The source investigation remains open and its Retro setting is unchanged.

An empty proposal list is valid. Already addressed work, existing issues, declined
proposals, and irrecoverable historical data should not generate another issue by
default. The person can edit a proposal before explicitly creating it.

## Ownership and safeguards

`FlowFollowups` owns proposal snapshots and reviewed creation. It reads a completed
current Understand attempt and verifies its retained output digest. Existing
capture owns issue publication and stable request identities. It supplies normal
folder, approval, and shared-queue safeguards.

A saved proposal binds to its source report, attempt, definition, output, and
evidence. Changed findings require a new review. Creation retains individual
outcomes and reuses stable capture identities, including after a partial failure
or restart. The same proposal cannot silently create duplicate issues.

The browser owns the review form. Loading the issue and refreshing the page never
invoke proposal generation, issue creation, or execution. The explicit proposal
action is a read-only AI discussion over supplied evidence, with no tools.

## Verification

Use disposable reports to verify proposal generation without issue creation,
selected and edited creation, source lineage, approval state, restart/replay,
stale or changed evidence, and partial failures. Drive the review form in Chrome
with injected proposals and assert the original issue remains open with Retro off.

The focused creation and recovery cases pass. The executor and server-control
regressions passed 65 checks; the final source-attempt and creation selection
passed seven focused checks. A further ten Understand, Retro, and closure checks
passed. These runs use injected responses and disposable projects, with no live
model execution, issue creation, GitHub publication, acceptance, or closure.

The focused Chrome review passed against the final UI assets, including edited
selection, approval state, source lineage, and reload without duplicate creation.
Retained evidence: `.issues/evidence/flow-browser-c812accc-78d9-48d1-ac3f-8e5b0bef5284/`.
The enforced step audit passed against starting commit
`ebe757d63390e0ee93c04fce238972bbfc516c3b`; its summary is
`.issues/evidence/2026-11-18T12-54-36.733Z-db75fb83-6169-4b46-b6f1-ae61004bd016-summary.json`.
