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

Choose a save workflow and save the report as a UTF-8 Markdown file inside the
issue checkout. Choose headings, tables, diagrams, and visual emphasis that help
the reader understand the findings. Include an executive summary, concrete
findings, evidence links, and recommendations. State uncertainty where evidence
is unavailable or unverified. Keep HTML out of the report. Use Markdown links to
original evidence and return their file references for Timey to retain.

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
