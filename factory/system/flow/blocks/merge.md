# Merge block

Check the existing PR and GitHub checks before repairing tests. If the PR is already merged, record GitHub's confirmed outcome without rerunning tests. Wait for pending checks; repair only failures observed on the current candidate.

At the start of a new Merge run, abort any pending local merge before syncing the target into the issue branch. Push each new candidate, then wait for GitHub's required checks before merging the PR. Do not abort merges created by conflict repair within the same run.

If GitHub is still calculating mergeability or reports a conflict, sync the target before waiting for checks. Repair local Git conflicts immediately. If the candidate already contains the fetched target and GitHub reports a conflict, stop and report the disagreement.

Fetch Destination again before merging. If the target advanced, repeat from the sync step. If a conflict or verification failure needs a decision, or repair stops making progress, pause for input. Under human-first policy, wait for approval of the current PR commit and target revision.

Temporary GitHub request failures get up to three retries with 1, 2 and 4 second delays. Retain the redacted error reason in progress and the final failure. Do not retry permission, authentication or validation failures. Before repeating an uncertain merge request, inspect the existing PR and recheck readiness through the protected merge guard; preserve the checkout. Stop interrupts retry backoff.

Recover from required GitHub check failures within the same run. Use the failed run’s retained logs, repair the candidate, verify it, push it, and check GitHub again. Make up to three different repair attempts per distinct blocker. Stop for a required decision, unavailable permission, an unchanged candidate, or a repeated failing source tree.

If a provider pause interrupted a saved repair, an explicit retry can continue
that repair before synchronizing a newer destination. Inspect the retained edits,
preserve unrelated changes, and commit only the verified repair.

Identify the exact failed test names, assertions and errors from the current
candidate's verification evidence. Reproduce those cases with focused commands
before editing. Include required predecessor scenarios when failure depends on
test order, and match GitHub's environment when local results differ.

Fix the demonstrated cause and run the failed cases first after every repair.
Add or update a dedicated PR repair check that runs those cases before the broad
suite and reports each result by name. Preserve the behavior and assertions the
tests protect. Record the focused commands and their actual results.

Commit the repair through normal Git hooks so staged Fallow findings are fixed
before it is committed. Factory checks formatting and Fallow against the fetched
destination before pushing the current candidate. Fix any local findings before
waiting for GitHub. Leave the broad suites to GitHub. Merge as soon as
the current candidate satisfies required checks and approvals. Keep unrelated
cleanup out of the repair.

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

Resolve straightforward conflicts and fix verification failures within the approved issue scope. Commit the repaired candidate in the issue checkout. Ask for human input if the fix needs a product decision, broader scope, or permission. Factory owns publication and the protected GitHub merge.

For test failures, name and reproduce the exact failing cases first. Fix their
demonstrated cause, rerun those cases before broader checks, and add them to the
PR's dedicated repair check so GitHub tests them first. Include order-dependent
predecessors and use GitHub's environment when needed. Preserve assertions,
record focused commands and results, and return the committed repair promptly
so Factory can push it for GitHub's required checks. Avoid duplicate full-suite runs and
unrelated cleanup. Merge promptly once required checks and approvals pass.

When a focused browser scenario writes an observation JSON with a source commit,
source tree, and environment, return it in `files.result`. Run the check on the
clean, committed repair candidate.

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
