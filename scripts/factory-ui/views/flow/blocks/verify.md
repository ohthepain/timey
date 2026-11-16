# Verify block

Run explicit candidate checks and retain their output.

# User extensions

`factory/ui/extensions/flow/blocks/verify.md`

# System prompt

Run explicit candidate checks and retain their output.

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
| candidate      | candidate              | Candidate       | text      |                                   |         |

# Artifacts

| Key       | Kind  | Label                       | Type | Options |
| --------- | ----- | --------------------------- | ---- | ------- |
| result    | file  | Recorded operation result   | file |         |
| candidate | value | Candidate commit            | text |         |
| log       | file  | Verification command output | file |         |
| report    | file  | Verification summary        | file |         |
