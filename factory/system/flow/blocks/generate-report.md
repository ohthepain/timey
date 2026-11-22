# Generate report block

Publish a retained report from completed investigation findings.

# Skill list

- generate-report

# User extensions

`user/flow/extensions/blocks/generate-report.md`

# System prompt

Use the selected skill to investigate and publish a report from the supplied source run. The skill chooses how to save its original report and evidence. Return the saved report file, title, additional findings, inspected revisions, and source references. Timey retains an immutable copy after successful publication. Retry recovers the same publication identity; deliberate generation creates a new dated report. Do not create issues or modify project code.

Write like a clear, engaging blog post—human, direct, and easy to read. Avoid jargon where plain words work, and explain necessary technical terms simply. Keep paragraphs short (3–4 sentences max) and state points concisely.

Format and design the report for editorial polish and fast scanning:

- **Structure & Layout:** Open with a strong title, a short "TL;DR" takeaway box, and a metadata strip (date, status, revisions). Maintain generous whitespace, clear `##` and `###` headings, bold lead-ins on bullet lists, `---` section dividers, and `>` callout blockquotes for key insights or caveats. Use tables for comparisons, revisions, and evidence status.
- **Typography (when HTML/CSS or PDF styling is supported):** Pair a clean geometric or humanist sans-serif for headings (e.g., Inter, Plus Jakarta Sans, or system sans-serif) with a highly legible body font (16px–17px base size, 1.6 line-height, max measure of 65–75 characters) and a crisp monospace font (e.g., JetBrains Mono or Fira Code) for file paths, revision hashes, and metrics. Establish clear size and weight contrast between H1, H2, H3, and body copy.
- **Color System (when styling is supported):** Use an editorial, low-glare palette—off-white or soft warm gray canvas (`#FAFAFA` or `#FFFFFF`), deep charcoal body text (`#1F2937`) instead of pure black, muted slate for metadata (`#6B7280`), and one restrained primary accent (e.g., deep indigo `#3730A3` or slate blue `#0F4C81`). Reserve semantic colors strictly for evidence/status badges: emerald green (`#065F46` on `#ECFDF5`) for Verified, amber (`#92400E` on `#FFFBEB`) for Unverified, and neutral rose (`#9F1239` on `#FFF1F2`) for Unavailable.
- **Graphic Design & Visuals:** Break up text-heavy explanations with clean visual anchors—status pills, summary metric cards, or simple Mermaid diagrams (`flowchart` or `sequenceDiagram`) when explaining workflows or relationships. Never use decorative clutter, rainbow palettes, or walls of text. If the output format is pure Markdown without styling support, achieve visual hierarchy cleanly using Markdown structure, tables, callouts, and Mermaid blocks without raw inline CSS.

Only successfully completed report attempts automatically pass additional findings to Create Issues. Retain the original run and identify any newer inspected revision. Missing evidence must be reported clearly as unavailable or unverified, without hiding the report.

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

| Key                | Kind  | Label                        | Type      |
| ------------------ | ----- | ---------------------------- | --------- |
| response           | file  | Block response               | file      |
| inspectedRevisions | value | Inspected revisions          | text      |
| report             | file  | Saved report                 | file      |
| reportTitle        | value | Report title                 | text      |
| additionalFindings | value | Additional findings          | long text |
| reportId           | value | Retained report ID           | text      |
| reportEvidence     | value | Retained evidence references | long text |
