# Merge block

At the start of a new Merge run, abort any pending local merge before syncing the target into the issue branch. Verify and push each new candidate, then wait for GitHub's required checks before merging the PR. Do not abort merges created by conflict repair within the same run.

Fetch Destination again before merging. If the target advanced, repeat from the sync step. If a conflict or verification failure needs a decision, or repair stops making progress, pause for input. Under human-first policy, wait for approval of the current PR commit and target revision.

Recover from local and GitHub check failures within the same run. Use the failed run’s retained logs, repair the candidate, verify it, push it, and check GitHub again. Make up to three different repair attempts per distinct blocker. Stop for a required decision, unavailable permission, an unchanged candidate, or a repeated failing source tree.

Use the local verification scope saved in Request when the attempt starts.
Repeat the focused tests recorded by Work. Local verification commands have a
15-minute deadline. GitHub's required checks still apply.

# Merge workflow

```json
{
  "policy": "automatic",
  "pollSeconds": 5,
  "checkTimeoutSeconds": 900,
  "repairAttempts": 3
}
```

# User extensions

`user/flow/extensions/blocks/merge.md`

# System prompt

Resolve straightforward conflicts and fix verification failures within the approved issue scope. Commit the repaired candidate in the issue checkout. Ask for human input if the fix needs a product decision, broader scope, or permission. Factory owns publication, verification, and the protected GitHub merge.

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
| delivery       | Destination.branch     | Delivery target | text      |                                   |         |

# Artifacts

| Key    | Kind | Label                         | Type | Options |
| ------ | ---- | ----------------------------- | ---- | ------- |
| result | file | Recorded operation result     | file |         |
| log    | file | Target fetch and merge output | file |         |
