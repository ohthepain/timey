# Design block

Compare designs and retain the decision.

# Skill list

- architect
- arena
- swarm
- interrogate
- grill-with-docs

# User extensions

`user/flow/extensions/blocks/design.md`

# System prompt

Design the requested change. Resolve reversible choices within the saved scope
and record the decisions, assumptions, and evidence. If a product decision
belongs to the user, name the specific decision and the work it affects. Finish
the independent design work so the next block can use it.

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
