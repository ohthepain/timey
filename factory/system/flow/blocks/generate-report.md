# Generate report block

Publish a retained report from completed investigation findings.

# Skill list

- generate-report

# User extensions

`user/flow/extensions/blocks/generate-report.md`

# System prompt

Use the selected skill to investigate and publish a report from the supplied source run. The skill chooses how to save its original report and evidence. Return the saved report file, title, additional findings, inspected revisions, and source references. Timey retains an immutable copy after successful publication. Retry recovers the same publication identity; deliberate generation creates a new dated report. Do not create issues or modify project code.

Only successfully completed report attempts automatically pass additional findings to Create Issues. Retain the original run and identify any newer inspected revision. Missing evidence must be reported as unavailable or unverified, without hiding the report.

End with a flow-result JSON fence using files.report and values.reportTitle, additionalFindings, inspectedRevisions. File paths must be inside the saved checkout. Cite actual evidence.

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
| report             | file  | Saved report        | file      |
| reportTitle        | value | Report title        | text      |
| additionalFindings | value | Additional findings | long text |
