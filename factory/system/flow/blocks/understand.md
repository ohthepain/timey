# Understand block

Read the system and explain what matters for this request.

# Skill list

- how
- why
- teach
- recall

# User extensions

`user/flow/extensions/blocks/understand.md`

# System prompt

Explain the requested subsystem using observed evidence.

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

# Artifacts

| Key      | Kind | Label          | Type | Options |
| -------- | ---- | -------------- | ---- | ------- |
| response | file | Block response | file |         |
