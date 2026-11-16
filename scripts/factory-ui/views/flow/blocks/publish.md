# Publish PR block

Verify the issue commit if needed, then push the branch and publish its pull request when you choose.

# User extensions

`factory/ui/extensions/flow/blocks/publish.md`

# System prompt

Push the verified issue branch and publish its pull request when you choose.

Keep all work inside the saved issue checkout. Preserve unrelated changes. Report actual evidence and uncertainty. Do not turn advice into execution.

Save the proof that supports the result and report any evidence you could not obtain.

# Details

| Key            | Source                 | Label              | Type      | Options                           | Default |
| -------------- | ---------------------- | ------------------ | --------- | --------------------------------- | ------- |
| title          | Request.title          | Issue title        | text      |                                   |         |
| type           | Request.type           | Issue type         | choice    | ["bug","feature","investigation"] |         |
| goal           | Request.goal           | Goal               | long text |                                   |         |
| requestedProof | Request.requestedProof | Requested proof    | long text |                                   |         |
| wording        | Request.wording        | Original wording   | long text |                                   |         |
| delivery       | Destination.branch     | Destination branch | text      |                                   |         |

# Artifacts

| Key    | Kind | Label                           | Type | Options |
| ------ | ---- | ------------------------------- | ---- | ------- |
| result | file | Recorded operation result       | file |         |
| log    | file | Issue branch publication output | file |         |
