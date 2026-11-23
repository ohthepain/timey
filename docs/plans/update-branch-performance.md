# Update Branch performance

Update Branch took minutes while Git merged in milliseconds. A live request on
an already current branch took 182.31 seconds. The retained preceding updates
also took roughly two to three minutes.

## Measurements

Run the disposable comparison with:

```sh
RUNS=5 node scripts/branch-update-benchmark.mjs --compare --assert
```

It imports the original Git provider, record store, and owned-operation adapter
from `3549f7e8afbc52bf724448e74a9d2460f1c1962c`. Five alternating runs per version
advance a real source branch, invoke the owned update, and check the resulting
commit, completed attempt, clean checkout and released claim. A separate plain
fetch-and-merge alternates order with the owned operation. Trace2 counts Git
subprocesses and remote metadata operations.

The [local evidence](update-branch-performance.local.json) records a median of
2.552 seconds before and 0.599 seconds after, with ranges of 2.539–2.716 and
0.556–0.677 seconds. Metadata lookups fell from 52 to two, and successful metadata
publications from eight to two. These disposable stores use local transport and
establish work reduction, not GitHub or S3 latency.

Five explicitly approved live button requests then completed successfully, with
unchanged clean source and the fetched commit present. The
[live evidence](update-branch-performance.live.json) records a median of 17.596
seconds, range 16.183–18.703 seconds. Plain remote fetch-and-merge in a disposable
copy had a median of 1.460 seconds, range 1.361–1.994 seconds. The selected issue's
store was initialized before timing. These requests used the earlier
`createCommitOnBranch` transport and are not proof of the final transport below.
The original 182-second request is a single baseline sample. All five measured
requests were already current; disposable executor tests separately cover actual
fast-forwards, merges, saved local edits, conflicts, hooks and interrupted work.

GitHub call timings from a separate diagnostic request attributed roughly five
seconds to the two `createCommitOnBranch` calls. API reference reads took about
0.3–0.5 seconds versus 1.4–1.9 seconds through Git over five read-only comparisons.
The remaining transports and artifact operations also contribute, so eliminating
one measured component cannot remove the entire request time.

## Implementation

Admission and completion publish separately as atomic Git metadata transactions.
The callback sees private writes and replay receipts until its conditional update
publishes the batch. No source operation starts before admission is confirmed.
Failure before publication leaves the original claim and records intact.

Read sets retain record values and the exact list prefixes used by the callback.
A competing update to an input or Stop command prevents publication. Disjoint
peer changes can be retained through at most five conditional publication attempts,
without replaying the callback. An uncertain response is reconciled against every
buffered receipt before another publication is attempted.

The final GitHub App transport uploads the prepared metadata tree and commit
through the Git data API, verifies both returned object IDs against local Git,
and updates only the configured metadata ref through `updateRefs`. Its
`beforeOid` condition and `force: false` preserve the existing exact-head guard.
The prepared commit uses UTC dates, so GitHub and local Git retain the same object
identity and later reads avoid fetching the just-published commit. Branch creation,
large batches and non-GitHub remotes retain authenticated Git publication.
See GitHub's [tree API](https://docs.github.com/en/rest/git/trees),
[commit API](https://docs.github.com/en/rest/git/commits), and
[conditional reference updates](https://docs.github.com/en/graphql/reference/git#updaterefs).

Established runtime refreshes read setup, role, ownership and selected display
state from one fresh metadata transaction. Git subprocesses batch blob hashing
and index updates. Default GitHub SSH reads share the existing guarded transport;
custom SSH settings retain their configured behavior.

Fresh acknowledged writes return their canonical input values. Replayed receipts
and subsequent reads still read retained storage. Verified immutable payloads are
shared within one metadata transaction, with a 32 MiB serialized-payload budget,
independent caller values, retry after read failure and expiry for detached
callbacks. This does not cache mutable authority across actions.

Progress checkpoints have at most one save in flight, and completion waits for
that save. Fetch, merge and conflict repair run between the metadata transactions.
Source hooks, conflict limits, ownership and Stop guards remain enforced.

## Verification status

The focused store, runtime, ownership and executor checks pass. The strict step
audit passes with Fallow warnings treated as failures. The wider Flow suite has
two failures that also reproduce on the clean starting revision: copied folder
selection and investigation output ordering. Neither was changed for this repair.

The final Git data transport passes local request, object-identity, permission,
stale-head, replay, concurrency and artifact lifetime checks. Its live performance
validation is pending explicit authorization for continued tests after the first
five-test allowance was used.
