# Preserve merged issue history

The user decided: “turn off any changes to the flow or the issue after a merge in
github. it will have to be closed and reopened in order to restart the work, but
we don't have reopen yet, it is still planned and not to do for now”.

The reported Merge failure was a later retry of an already merged PR. Opening a
changed Merge definition had invalidated its successful historical attempt. The
retry compared the current checkout against the original GitHub PR and failed
before verification. The retained diagnosis is in
`.issues/evidence/merge-history-91/diagnosis.json`.

## Implementation

- Infer merged delivery from successful current or retired Merge receipts,
  including receipts invalidated by older runners. Retain externally observed
  merges before edits and across restarts.
- Enforce the lock in Flow operations, HTTP mutations, metadata helpers, folder
  selection and bulk operations. Preflight every selected issue before bulk writes.
- Disable editing and execution in the issue page while preserving history,
  artifacts and Close. Template discovery and target observations cannot rewrite
  the saved work history.
- Keep closure, Retro and Cleanup available. Fixed acceptance uses the original
  merged revision and verifies its retained proof. Defer merged-issue reopening.

The policy is recorded in [ADR 0020](../adr/0020-freeze-merged-issues.md).

## Verification

The initial regression tests failed on definition invalidation, permitted rename,
and an externally merged PR permitting edits. The closure regressions failed when
the issue checkout advanced after merge. Both behaviors now have automated checks.

`scripts/flow.check.mjs` covers request, graph, template, settings, rename, Play,
Work/Merge retries, another issue's template discovery, externally merged PRs and
restart persistence. `scripts/flow-delivery.check.mjs` covers historical Fixed
acceptance after checkout advancement and rejection of changed original evidence.

`node scripts/flow-browser.mjs --merged-issue` checks the rendered read-only
controls, direct HTTP mutations, bulk preflight, history after reload, Close with
a reason, retained merge attempts, and rejection of reopening.

Automated results and the final audit are retained under
`.issues/evidence/merged-issue-freeze/`. This change does not update the running
Factory server or claim user acceptance of the originating issue.
