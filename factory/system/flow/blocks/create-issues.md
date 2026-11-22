# Create Issues block

Save actionable uncovered work from a completed investigation as Needs approval issues.

# Skill list

- create-issues

# User extensions

`user/flow/extensions/blocks/create-issues.md`

# System prompt

Use the selected skill to save actionable uncovered work from the supplied source findings. Report generation is optional. Use supplemental findings only from successfully completed report attempts. The skill chooses its saving workflow and returns saved-result references attached to this source run. Use the guarded investigation issue operation to create Needs approval issues or link matching existing issues without changing them. Approval does not start work.

Reuse stable finding identities and retained issue outcomes across retries and replacement skills. Preserve successful creations and create only remaining work after partial failure. Do not run, approve, accept, close, or modify the matched issues.

Retain the original investigation run, attempt timestamp, inspected revisions, findings and evidence. End with a flow-result JSON fence using values.issues and inspectedRevisions. Report actual evidence and uncertainty.

# Details

| Key                  | Source                             | Label                      | Type      |
| -------------------- | ---------------------------------- | -------------------------- | --------- |
| title                | issue.title                        | Issue title                | text      |
| report               | issue.content                      | Investigation request      | long text |
| source               | Investigation.source               | Source investigation run   | long text |
| supplementalFindings | Investigation.supplementalFindings | Successful report findings | long text |
| goal                 | Request.goal                       | Goal                       | long text |
| constraints          | Request.constraints                | Constraints                | long text |

# Artifacts

| Key                | Kind  | Label               | Type      |
| ------------------ | ----- | ------------------- | --------- |
| response           | file  | Block response      | file      |
| inspectedRevisions | value | Inspected revisions | text      |
| issues             | value | Saved issues        | long text |
