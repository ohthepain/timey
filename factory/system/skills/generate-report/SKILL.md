---
name: generate-report
description: Generate and save a retained investigation report from completed findings, with evidence and recommendations.
---

# Generate report

Use the supplied completed investigation run as the source. Keep its run identity,
timestamp, inspected revision, findings, and evidence distinct from any further
inquiry. You may inspect newer committed code. Record each additional full commit
hash and distinguish new observations from the original findings.

Read `investigation_outputs` before saving. It returns the original inquiry and
any saved publication outcomes. A Retry recovers its existing publication. A new
deliberate generation creates a separate dated report, even with identical content.

This skill produces user-facing investigation reports only. Internal issue
records, verification output, logs, and machine-readable results keep their
existing formats.

Read the installed `/bro` skill and pass all source content through it before
laying out the report. Use its output for all report copy. Do not add other tone
or copywriting rules. Preserve factual findings, evidence references, uncertainty,
and source provenance while simplifying the wording.

Read [the report design prompt](report-design.md) and apply it to that copy.
Save one complete UTF-8 `.html` file inside the issue checkout. Include the
summary, findings, recommendations, evidence links, and source metadata in the
sections that fit the material. Keep supporting evidence as separately retained
files and link to their original paths with HTML anchors. Do not embed external
images or dependencies. Return the evidence file references for Timey to retain.

Call `report_publish` with the saved `report` path, a `title`, `evidence` file
references, `additionalFindings`, and the `inspectedRevisions` full commit hashes.
The tool binds the publication to the supplied inquiry and output attempt. Its
returned report ID and source fields are the saved-result references. Timey
retains its own report and evidence copies. A missing evidence item leaves the
report readable and marked unavailable.

Return the saved-result references and source provenance in your final response.
Return the original report file as `files.report`, title as
`values.reportTitle`, and additional observations as
`values.additionalFindings` and `values.inspectedRevisions` in a terminal
`flow-result` JSON block. A saved tool outcome stays retained if later work fails.
Only a successfully completed block automatically forwards additional findings.
