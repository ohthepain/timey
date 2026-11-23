---
name: create-issues
description: Save actionable uncovered investigation findings as approval-needed issues, preserving partial creation receipts and linking matching work.
---

# Create Issues

Use the supplied completed investigation run and any additional findings from a
successfully completed report. Issue creation remains independent of report
generation. You may inspect newer committed code. Record its revisions and keep
new observations distinct from the original inquiry.

Call `investigation_outputs` first. Reuse its saved finding keys, original wording,
folders, request identities, and successful outcomes. These identities belong to
the investigation run and remain stable when the selected skill changes. Retry
only unfinished findings. A different skill is not a new creation identity.

Check existing issues for the same work. Link matching work by passing its ID as
`existingIssueId`. Keep the existing issue unchanged. For uncovered actionable
work, choose a stable descriptive `key` and provide a title, type, description,
reason, and verification. An empty findings list is valid.

Choose when and how to save your findings through `investigation_issues_save`.
The guarded tool saves them as Needs approval and attaches the original inquiry
identity. Approval does not start work. It retains each successful outcome before
attempting the next item. If some items return errors, inspect those errors and
report the partial result. An explicit Retry reuses the original keys and creates
only the remaining work.

Return all saved and linked issue IDs, stable finding keys, source run information,
inspected revisions, and unresolved errors. In the terminal `flow-result` JSON,
put the saved results in `values.issues` and full commit hashes in
`values.inspectedRevisions`. A partial failure must remain visible as failed or
blocked work while keeping its successful saved outcomes.
