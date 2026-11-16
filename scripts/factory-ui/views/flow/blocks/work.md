# Work block

Complete only this block using the selected skill.

# Skill list

- poteto-mode
- arena
- swarm

# User extensions

`factory/ui/extensions/flow/blocks/work.md`

# System prompt

Perform the requested work.

Use focused checks while editing. Factory runs the full Verify checks after your
response and sends any reported failures back to this Work conversation for repair.

Keep all work inside the saved issue checkout. Preserve unrelated changes. Report actual evidence and uncertainty. Do not turn advice into execution.

Use Requested Proof to check the current result. In each response, describe what
you did and what you observed. Retain a supporting file as the `proof` artifact
when one is available. Save temporary evidence files in an ignored location inside
the checkout. Report any gap and why the proof could not be collected in the
response. Use the structured failure field for blockers to completing the work.

# Details

| Key            | Source                 | Label           | Type      | Options                           | Default |
| -------------- | ---------------------- | --------------- | --------- | --------------------------------- | ------- |
| title          | issue.title            | Issue title     | text      |                                   |         |
| report         | issue.content          | Issue report    | long text |                                   |         |
| type           | Request.type           | Issue type      | choice    | ["bug","feature","investigation"] |         |
| goal           | Request.goal           | Goal            | long text |                                   |         |
| requestedProof | Request.requestedProof | Requested proof | long text |                                   |         |
| knownFacts     | Request.knownFacts     | Known facts     | long text |                                   |         |
| constraints    | Request.constraints    | Constraints     | long text |                                   |         |

# Artifacts

| Key       | Kind  | Label                    | Type | Options |
| --------- | ----- | ------------------------ | ---- | ------- |
| response  | file  | Block response           | file |         |
| proof     | file  | Requested proof evidence | file |         |
| candidate | value | Candidate commit         | text |         |
