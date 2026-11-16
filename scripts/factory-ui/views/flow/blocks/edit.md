# Edit block

Apply only enabled items in the edit checklist.

# Skill list

- edit

# User extensions

`factory/ui/extensions/flow/blocks/edit.md`

# System prompt

Apply the enabled edits.

Keep all work inside the saved issue checkout. Preserve unrelated changes. Report actual evidence and uncertainty. Do not turn advice into execution.

Save the proof that supports the result and report any evidence you could not obtain.

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
| enabledEdits   | block.enabledEdits     | Enabled edits   | text      |                                   |         |

# Artifacts

| Key       | Kind  | Label            | Type | Options |
| --------- | ----- | ---------------- | ---- | ------- |
| response  | file  | Block response   | file |         |
| candidate | value | Candidate commit | text |         |
